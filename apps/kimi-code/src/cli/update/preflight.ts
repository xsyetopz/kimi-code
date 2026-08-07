import { log, type Logger } from "@moonshot-ai/kimi-code-sdk";

import { readUpdateCache } from "./cache";
import {
  emptyUpdateInstallState,
  readUpdateInstallState,
} from "./install-state";
import {
  promptForInstallChoice,
  type InstallPromptChoiceValue,
  type InstallPromptOptions,
} from "./prompt";
import { refreshUpdateCache } from "./refresh";
import {
  appendRolloutDecisionLog,
  decidePassiveUpdateTarget,
  isRolloutBypassedByExperimentalEnv,
  resolveUpdateDeviceId,
  type PassiveUpdateDecision,
} from "./rollout";
import { detectInstallSource } from "./source";
import {
  tryStartAutomaticBackgroundInstall,
  showPendingBackgroundInstallNotice,
} from "./preflight-background-install";
import {
  canAutoInstall,
  formatUpdateErrorMessage,
  installCommandFor,
  installUpdate,
  renderInstallSuccessMessage,
  renderManualUpdateMessage,
} from "./preflight-install-commands";
import {
  NPM_PACKAGE_NAME,
  type InstallSource,
  type UpdateDecision,
  type UpdateManifest,
  type UpdatePreflightResult,
  type UpdateTarget,
} from "./types";

export type { UpdatePreflightResult } from "./types";

export {
  canAutoInstall,
  installCommandFor,
  installUpdate,
  renderInstallSuccessMessage,
  renderManualUpdateMessage,
  spawnForSource,
} from "./preflight-install-commands";

export interface RunUpdatePreflightOptions {
  readonly stdout?: { write(chunk: string): boolean };
  readonly stderr?: { write(chunk: string): boolean };
  readonly isTTY?: boolean;
  readonly logger?: Pick<Logger, "info" | "warn">;
}

const USER_VISIBLE_UPDATE_REFRESH_TIMEOUT_MS = 1_000;

function refreshInBackground(): void {
  void refreshUpdateCache().catch(() => {});
}

type RolloutCheckPhase =
  | "startup-cache"
  | "background-refresh"
  | "prompt-refresh";

/** Record which case a passive version check hit in `updates/rollout.log`. */
function logRolloutDecision(
  phase: RolloutCheckPhase,
  currentVersion: string,
  latest: string | null,
  manifest: UpdateManifest | null,
  decision: PassiveUpdateDecision,
): void {
  void appendRolloutDecisionLog({
    ts: new Date().toISOString(),
    phase,
    reason: decision.reason,
    current: currentVersion,
    latest,
    target: decision.target?.version ?? null,
    manifestPresent: manifest !== null,
    publishedAt: manifest?.publishedAt ?? null,
    bucket: decision.bucket,
    delaySeconds: decision.delaySeconds,
    eligibleAt: decision.eligibleAt,
  });
}

function refreshAndMaybeInstallInBackground(
  currentVersion: string,
  deviceId: string,
  bypassRollout: boolean,
  isInteractive: boolean,
  installState: Awaited<ReturnType<typeof readUpdateInstallState>>,
  platform: NodeJS.Platform,
  logger: Pick<Logger, "info" | "warn">,
): void {
  void (async () => {
    const refreshed = await refreshUpdateCache();
    if (!isInteractive) return;
    const decision = decidePassiveUpdateTarget(
      currentVersion,
      refreshed.latest,
      refreshed.manifest,
      deviceId,
      new Date(),
      bypassRollout,
    );
    logRolloutDecision(
      "background-refresh",
      currentVersion,
      refreshed.latest,
      refreshed.manifest,
      decision,
    );
    const target = decision.target;
    if (target === null) return;
    const source = await detectInstallSource().catch(
      () => "unsupported" as const,
    );
    await tryStartAutomaticBackgroundInstall(
      installState,
      currentVersion,
      target,
      source,
      platform,
      logger,
    );
  })().catch(() => {});
}

interface UserVisibleUpdateTarget {
  readonly target: UpdateTarget | null;
  readonly manifest: UpdateManifest | null;
}

async function refreshUserVisibleUpdateTarget(
  currentVersion: string,
  deviceId: string,
  bypassRollout: boolean,
  fallbackTarget: UpdateTarget,
  fallbackManifest: UpdateManifest | null,
): Promise<UserVisibleUpdateTarget> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const fallback: UserVisibleUpdateTarget = {
    target: fallbackTarget,
    manifest: fallbackManifest,
  };
  try {
    const refresh = refreshUpdateCache()
      .then((refreshed) => {
        const decision = decidePassiveUpdateTarget(
          currentVersion,
          refreshed.latest,
          refreshed.manifest,
          deviceId,
          new Date(),
          bypassRollout,
        );
        logRolloutDecision(
          "prompt-refresh",
          currentVersion,
          refreshed.latest,
          refreshed.manifest,
          decision,
        );
        return {
          target: decision.target,
          manifest: refreshed.manifest,
        };
      })
      .catch(() => fallback);
    const timeoutFallback = new Promise<UserVisibleUpdateTarget>((resolve) => {
      timeout = setTimeout(() => {
        resolve(fallback);
      }, USER_VISIBLE_UPDATE_REFRESH_TIMEOUT_MS);
    });
    return await Promise.race([refresh, timeoutFallback]);
  } catch {
    return fallback;
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

/**
 * `KIMI_CODE_NO_AUTO_UPDATE` (or the legacy `KIMI_CLI_NO_AUTO_UPDATE` alias)
 * fully disables the update preflight — no check, no background install, no
 * prompt. Migrated from kimi-cli, where the variable gated all auto-update
 * behavior. Accepts the usual truthy values (`1`/`true`/`yes`/`on`).
 */
function isAutoUpdateDisabledByEnv(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const truthy = (value?: string): boolean =>
    ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
  return (
    truthy(env["KIMI_CODE_NO_AUTO_UPDATE"]) ||
    truthy(env["KIMI_CLI_NO_AUTO_UPDATE"])
  );
}

async function promptInstall(
  currentVersion: string,
  target: UpdateTarget,
  source: InstallSource,
  installCommand: string,
): Promise<InstallPromptChoiceValue> {
  const options: InstallPromptOptions = {
    currentVersion,
    target,
    installSource: source,
    installCommand,
  };
  return promptForInstallChoice(options);
}

export function decideUpdateAction(
  target: UpdateTarget | null,
  isInteractive: boolean,
  source: InstallSource,
  platform: NodeJS.Platform,
): UpdateDecision {
  if (target === null || !isInteractive) return "none";
  return canAutoInstall(source, platform) ? "prompt-install" : "manual-command";
}

export async function runUpdatePreflight(
  currentVersion: string,
  options: RunUpdatePreflightOptions = {},
): Promise<UpdatePreflightResult> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const logger = options.logger ?? log;
  const platform = process.platform;

  if (isAutoUpdateDisabledByEnv()) {
    return "continue";
  }

  try {
    const isInteractive =
      options.isTTY ?? (process.stdin.isTTY && process.stdout.isTTY);
    const deviceId = resolveUpdateDeviceId();
    const bypassRollout = isRolloutBypassedByExperimentalEnv();
    let installState = await readUpdateInstallState().catch(() =>
      emptyUpdateInstallState(),
    );
    if (isInteractive) {
      installState = await showPendingBackgroundInstallNotice(
        installState,
        currentVersion,
        stdout,
        logger,
      );
    }

    const cache = await readUpdateCache().catch(() => null);
    const cachedManifest = cache?.manifest ?? null;
    const cachedDecision = decidePassiveUpdateTarget(
      currentVersion,
      cache?.latest ?? null,
      cachedManifest,
      deviceId,
      new Date(),
      bypassRollout,
    );
    logRolloutDecision(
      "startup-cache",
      currentVersion,
      cache?.latest ?? null,
      cachedManifest,
      cachedDecision,
    );
    const target = cachedDecision.target;
    if (target === null) {
      refreshAndMaybeInstallInBackground(
        currentVersion,
        deviceId,
        bypassRollout,
        isInteractive,
        installState,
        platform,
        logger,
      );
      return "continue";
    }

    const source: InstallSource = !isInteractive
      ? "unsupported"
      : await detectInstallSource().catch(() => "unsupported" as const);

    const decision = decideUpdateAction(
      target,
      isInteractive,
      source,
      platform,
    );
    if (decision === "none") {
      refreshInBackground();
      return "continue";
    }

    if (
      await tryStartAutomaticBackgroundInstall(
        installState,
        currentVersion,
        target,
        source,
        platform,
        logger,
      )
    ) {
      refreshInBackground();
      return "continue";
    }

    const userVisibleUpdate = await refreshUserVisibleUpdateTarget(
      currentVersion,
      deviceId,
      bypassRollout,
      target,
      cachedManifest,
    );
    const userVisibleTarget = userVisibleUpdate.target;
    if (userVisibleTarget === null) return "continue";
    if (
      await tryStartAutomaticBackgroundInstall(
        installState,
        currentVersion,
        userVisibleTarget,
        source,
        platform,
        logger,
      )
    ) {
      return "continue";
    }

    const installCommand = installCommandFor(
      source,
      userVisibleTarget.version,
      platform,
    );

    if (decision === "manual-command") {
      stdout.write(
        renderManualUpdateMessage(
          currentVersion,
          userVisibleTarget,
          source,
          installCommand,
        ),
      );
      return "continue";
    }

    const choice = await promptInstall(
      currentVersion,
      userVisibleTarget,
      source,
      installCommand,
    );
    if (choice === "skip") return "continue";

    try {
      await installUpdate(source, userVisibleTarget.version, platform);
      stdout.write(renderInstallSuccessMessage(userVisibleTarget));
      return "exit";
    } catch (error) {
      stderr.write(
        `warning: failed to install ${NPM_PACKAGE_NAME}@${userVisibleTarget.version}: ` +
          `${formatUpdateErrorMessage(error)}\n`,
      );
      return "continue";
    }
  } catch {
    return "continue";
  }
}

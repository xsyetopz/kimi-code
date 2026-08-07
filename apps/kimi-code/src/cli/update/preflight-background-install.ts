import { spawn } from "node:child_process";

import type { Logger } from "@moonshot-ai/kimi-code-sdk";

import { loadTuiConfig } from "#/tui/config";

import { tryAcquireUpdateInstallLock } from "./install-lock";
import {
  readUpdateInstallState,
  writeUpdateInstallState,
} from "./install-state";
import { CHANGELOG_URL } from "./prompt";
import { canAutoInstall, spawnForSource } from "./preflight-install-commands";
import type { InstallSource, UpdateInstallState, UpdateTarget } from "./types";

export const AUTO_INSTALL_FAILURE_PROMPT_THRESHOLD = 2;
export const AUTO_INSTALL_ACTIVE_TTL_MS = 6 * 60 * 60 * 1000;

export type UpdateLogger = Pick<Logger, "info" | "warn">;

export function nowIso(): string {
  return new Date().toISOString();
}

export function failureAttemptsFor(
  state: UpdateInstallState,
  target: UpdateTarget,
): number {
  return state.lastFailure?.version === target.version
    ? state.lastFailure.attempts
    : 0;
}

export function hasFreshActiveInstall(
  state: UpdateInstallState,
  target: UpdateTarget,
): boolean {
  const active = state.active;
  if (active === null || active.version !== target.version) return false;
  const startedAt = Date.parse(active.startedAt);
  if (!Number.isFinite(startedAt)) return false;
  return Date.now() - startedAt < AUTO_INSTALL_ACTIVE_TTL_MS;
}

function renderBackgroundInstallSuccessNotice(version: string): string {
  const displayVersion = version.startsWith("v") ? version : `v${version}`;
  return `Kimi Code updated to ${displayVersion}\nChangelog: ${CHANGELOG_URL}\n`;
}

export function logUpdateInfo(
  logger: UpdateLogger,
  message: string,
  payload: Record<string, unknown>,
): void {
  try {
    logger.info(message, payload);
  } catch {
    // Diagnostic logging must never affect update prompting.
  }
}

export function logUpdateWarn(
  logger: UpdateLogger,
  message: string,
  payload: Record<string, unknown>,
): void {
  try {
    logger.warn(message, payload);
  } catch {
    // Diagnostic logging must never affect update prompting.
  }
}

export async function shouldAutoInstallUpdates(): Promise<boolean> {
  try {
    const config = await loadTuiConfig();
    return config.upgrade.autoInstall;
  } catch {
    return true;
  }
}

export async function showPendingBackgroundInstallNotice(
  state: UpdateInstallState,
  currentVersion: string,
  stdout: { write(chunk: string): boolean },
  logger: UpdateLogger,
): Promise<UpdateInstallState> {
  const success = state.lastSuccess;
  if (
    success !== null &&
    success.notifiedAt === null &&
    success.version === currentVersion
  ) {
    stdout.write(renderBackgroundInstallSuccessNotice(success.version));
    logUpdateInfo(logger, "background update success notice shown", {
      version: success.version,
      inferredFromActive: false,
    });
    const nextState: UpdateInstallState = {
      ...state,
      active: null,
      lastFailure: null,
      lastSuccess: {
        ...success,
        notifiedAt: nowIso(),
      },
    };
    await writeUpdateInstallState(nextState).catch(() => {});
    return nextState;
  }

  const active = state.active;
  if (active === null || active.version !== currentVersion) return state;
  if (
    success !== null &&
    success.version === currentVersion &&
    success.notifiedAt !== null
  ) {
    return state;
  }

  const notifiedAt = nowIso();
  stdout.write(renderBackgroundInstallSuccessNotice(active.version));
  logUpdateInfo(logger, "background update success notice shown", {
    version: active.version,
    inferredFromActive: true,
  });
  const nextState: UpdateInstallState = {
    ...state,
    active: null,
    lastFailure: null,
    lastSuccess: {
      version: active.version,
      installedAt: notifiedAt,
      notifiedAt,
    },
  };
  await writeUpdateInstallState(nextState).catch(() => {});
  return nextState;
}

async function startBackgroundInstall(
  state: UpdateInstallState,
  currentVersion: string,
  target: UpdateTarget,
  source: InstallSource,
  platform: NodeJS.Platform,
  logger: UpdateLogger,
): Promise<void> {
  const lock = await tryAcquireUpdateInstallLock({ version: target.version });
  if (lock === null) return;

  try {
    const freshState = await readUpdateInstallState().catch(() => state);
    if (
      hasFreshActiveInstall(freshState, target) ||
      failureAttemptsFor(freshState, target) >=
        AUTO_INSTALL_FAILURE_PROMPT_THRESHOLD
    ) {
      return;
    }

    const startedState: UpdateInstallState = {
      ...freshState,
      active: {
        version: target.version,
        source,
        startedAt: nowIso(),
      },
    };
    await writeUpdateInstallState(startedState);
    logUpdateInfo(logger, "background update install started", {
      currentVersion,
      targetVersion: target.version,
      source,
    });

    const { cmd, args } = spawnForSource(source, target.version, platform);
    let settled = false;

    const finish = (succeeded: boolean): void => {
      if (settled) return;
      settled = true;
      const attempts = failureAttemptsFor(startedState, target) + 1;

      const nextState: UpdateInstallState = succeeded
        ? {
            ...startedState,
            active: null,
            lastFailure: null,
            lastSuccess: {
              version: target.version,
              installedAt: nowIso(),
              notifiedAt: null,
            },
          }
        : {
            ...startedState,
            active: null,
            lastFailure: {
              version: target.version,
              failedAt: nowIso(),
              attempts,
            },
          };
      void writeUpdateInstallState(nextState).catch(() => {});
      if (succeeded) {
        logUpdateInfo(logger, "background update install succeeded", {
          targetVersion: target.version,
          source,
        });
        return;
      }
      logUpdateWarn(logger, "background update install failed", {
        targetVersion: target.version,
        source,
        attempts,
      });
    };

    const child = spawn(cmd, [...args], {
      detached: true,
      stdio: "ignore",
      shell: platform === "win32" ? true : undefined,
      // On Windows a detached child gets its own console window; with shell:true
      // that window would flash during a passive background update. Hide it so
      // the silent updater stays silent.
      windowsHide: platform === "win32" ? true : undefined,
    });
    child.once("error", () => {
      finish(false);
    });
    child.once("exit", (code) => {
      finish(code === 0);
    });
    child.unref();
  } finally {
    await lock.release().catch(() => {});
  }
}

export async function tryStartAutomaticBackgroundInstall(
  installState: UpdateInstallState,
  currentVersion: string,
  target: UpdateTarget,
  source: InstallSource,
  platform: NodeJS.Platform,
  logger: UpdateLogger,
): Promise<boolean> {
  const sourceCanAutoInstall = canAutoInstall(source, platform);
  const autoInstallUpdates = sourceCanAutoInstall
    ? await shouldAutoInstallUpdates()
    : false;
  if (!autoInstallUpdates || !sourceCanAutoInstall) return false;
  if (
    failureAttemptsFor(installState, target) >=
    AUTO_INSTALL_FAILURE_PROMPT_THRESHOLD
  ) {
    return false;
  }
  if (!hasFreshActiveInstall(installState, target)) {
    await startBackgroundInstall(
      installState,
      currentVersion,
      target,
      source,
      platform,
      logger,
    ).catch(() => {});
  }
  return true;
}

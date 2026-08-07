import type {
  CapabilityStatus,
  PluginInfo,
  PluginSummary,
} from "@moonshot-ai/kimi-code-sdk";

import {
  PluginInstallTrustConfirmComponent,
  PluginsPanelComponent,
  describeCapabilityIssues,
  formatCapabilityVersion,
  type PluginInstallTrustConfirmResult,
} from "../components/dialogs/plugins-selector";
import { formatErrorMessage } from "../utils/event-payload";
import {
  formatPluginSourceLabel,
  isOfficialPluginInstall,
} from "../utils/plugin-source-label";
import { QUOTA_CONSUMING_PLUGIN_IDS } from "#/constant/app";
import type { PluginMarketplaceEntry } from "#/utils/plugin-marketplace";
import type { SlashCommandHost } from "./dispatch";
import {
  PLUGIN_RELOAD_HINT,
  resolvePluginApi,
  resolvePluginInstallSource,
  truncateForStatus,
} from "./plugins-api";

const CAPABILITY_POLL_INTERVAL_MS = 700;
const CAPABILITY_POLL_ATTEMPTS = 260; // ~3 minutes of runtime setup budget

const PLUGIN_QUOTA_NOTE = "Note: This plugin consumes your quota.";

/** Client-injected v2 entries install their runtime and plugin together.
 * Trust keys on the parser-proof `builtIn` flag — the `capability:<id>`
 * source string stays purely diagnostic. */
export function isCapabilityEntry(
  host: SlashCommandHost,
  entry: PluginMarketplaceEntry,
): boolean {
  return host.engineV2 && entry.builtIn === true;
}

/**
 * Closed-set id check for the post-remove note. The capability ids are part
 * of the client/engine CONTRACT (mirrored in the klient zod enum), not
 * product data that drifts — so they may be named here. What must not
 * happen is the alternative: answering set membership by running
 * `listCapabilities()`, which fires every entry's detector (seconds of
 * probes) just to decide whether to print one hint line.
 */
export function isCapabilityId(host: SlashCommandHost, id: string): boolean {
  return host.engineV2 && (id === "kimi-cu" || id === "kimi-webbridge");
}

/** Poll a background capability install, mirroring progress into the
 * panel's inline installing line until it settles (or we run out of budget). */
export async function pollCapabilityInstall(
  host: SlashCommandHost,
  panel: PluginsPanelComponent,
  id: string,
  label: string,
): Promise<CapabilityStatus | undefined> {
  const session = host.requireSession();
  for (let attempt = 0; attempt < CAPABILITY_POLL_ATTEMPTS; attempt += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, CAPABILITY_POLL_INTERVAL_MS);
    });
    const status = await session.getCapability(id);
    if (!status.install.running) return status;
    const step = status.install.step ?? "configuring runtime";
    const percent = status.install.percent;
    panel.setInstalling(
      `${truncateForStatus(label)} — ${step}${percent !== undefined ? ` ${percent}%` : ""}`,
    );
    host.state.ui.requestRender();
  }
  return undefined;
}

export async function installCapabilityFromPanel(
  host: SlashCommandHost,
  panel: PluginsPanelComponent,
  entry: PluginMarketplaceEntry,
): Promise<void> {
  const label = entry.displayName;
  // Capability entries are official by construction; the trust prompt is
  // reserved for unreviewed third-party plugins.
  panel.setInstalling(truncateForStatus(label));
  host.state.ui.requestRender();
  const session = host.requireSession();
  try {
    // An install already running (started from another panel or client) is
    // followed, not restarted — the service rejects duplicate starts even
    // though the original is healthy.
    const alreadyRunning = await session.getCapability(entry.id).then(
      (status) => status.install.running,
      () => false,
    );
    if (!alreadyRunning) {
      await session.installCapability(entry.id);
    }
  } catch (error) {
    panel.clearInstalling();
    host.state.ui.requestRender();
    host.showError(`Failed to install ${label}: ${formatErrorMessage(error)}`);
    host.restoreEditor();
    return;
  }
  let result: CapabilityStatus | undefined;
  try {
    result = await pollCapabilityInstall(host, panel, entry.id, label);
  } catch {
    result = undefined;
  }
  panel.clearInstalling();
  // Close the panel so the result lines land in the transcript, matching the
  // plain plugin install flow.
  host.restoreEditor();
  if (result === undefined) {
    host.showStatus(
      `${label} setup is still running in the background; /plugins shows its state.`,
    );
    return;
  }
  if (result.install.error !== undefined) {
    host.showError(
      `${label} setup failed: ${result.install.error}. Install again from /plugins to retry.`,
    );
    return;
  }
  if (result.state !== "ready") {
    const issues = describeCapabilityIssues(result);
    host.showStatus(
      `${label} setup is incomplete${issues.length > 0 ? `: ${issues}` : ""}.`,
      "warning",
    );
    if (
      result.id === "kimi-cu" &&
      result.steps.some(
        (step) => step.id === "permissions" && step.state !== "ok",
      )
    ) {
      host.showStatus(
        "Grant Accessibility and Screen Recording in System Settings → Privacy & Security, then reopen /plugins to recheck.",
        "warning",
      );
    }
    host.showStatus(PLUGIN_RELOAD_HINT, "warning");
    return;
  }
  host.showStatus(
    `${label} is ready${result.version !== undefined ? ` (${formatCapabilityVersion(result.version)})` : ""}.`,
  );
  const skillShadow = result.steps.find(
    (step) => step.id === "skill-shadow" && step.state !== "ok",
  );
  if (skillShadow?.detail !== undefined) {
    host.showStatus(
      `A user-installed kimi-webbridge skill is shadowing the managed plugin. Remove it manually: ${skillShadow.detail}`,
      "warning",
    );
  }
  host.showStatus(PLUGIN_RELOAD_HINT, "warning");
}

export async function confirmInstallTrust(
  host: SlashCommandHost,
  label: string,
  official: boolean,
): Promise<boolean> {
  // Kimi-built official plugins are trusted implicitly; anything else requires
  // the user to explicitly opt in via the trust prompt.
  if (official) return true;
  return new Promise((resolveConfirmed) => {
    host.mountEditorReplacement(
      new PluginInstallTrustConfirmComponent({
        label,
        onDone: (result: PluginInstallTrustConfirmResult) => {
          host.restoreEditor();
          resolveConfirmed(result.kind === "confirm");
        },
      }),
    );
  });
}

export async function installFromPanel(
  host: SlashCommandHost,
  panel: PluginsPanelComponent,
  source: string,
  label: string,
  official: boolean,
): Promise<void> {
  if (!(await confirmInstallTrust(host, label, official))) {
    host.showStatus(`Install cancelled: ${label}.`);
    host.restoreEditor();
    return;
  }
  // Official installs keep the panel mounted and show the inline installing
  // state; third-party installs pass through a trust prompt that replaces the
  // panel, so fall back to a transcript status for those.
  if (official) {
    panel.setInstalling(truncateForStatus(label));
  } else {
    host.showStatus(`Installing or updating ${label} from marketplace...`);
  }
  host.state.ui.requestRender();
  try {
    await installPluginFromSource(host, source);
  } catch (error) {
    if (official) {
      panel.clearInstalling();
      host.state.ui.requestRender();
    } else {
      // The trust prompt replaced the panel; re-mount it so the user can retry
      // instead of being dropped back at the editor.
      host.mountEditorReplacement(panel);
    }
    host.showError(`Failed to install ${label}: ${formatErrorMessage(error)}`);
    return;
  }
  // Close the panel after installing so the result status and the
  // "/reload or /new" tip are visible in the transcript.
  host.restoreEditor();
}

export async function installPluginFromSource(
  host: SlashCommandHost,
  source: string,
): Promise<void> {
  const session = await resolvePluginApi(host);
  const beforeList = await session.listPlugins();
  const summary = await session.installPlugin(
    resolvePluginInstallSource(source, host.state.appState.workDir),
  );
  showPluginInstallResult(host, beforeList, summary);
}

export async function removePlugin(
  host: SlashCommandHost,
  id: string,
): Promise<void> {
  await (await resolvePluginApi(host)).removePlugin(id);
  host.showStatus(`Removed ${id}.`);
  if (isCapabilityId(host, id)) {
    host.showStatus(
      "Note: the runtime binaries were left untouched, but Kimi Code plugin wiring is disabled for new sessions. Reinstall any time from the Official tab.",
    );
  }
  host.showStatus(PLUGIN_RELOAD_HINT, "warning");
}

export const __pluginsCommandInternals = {
  isCapabilityEntry,
  installCapabilityFromPanel,
  pollCapabilityInstall,
  removePlugin,
};

function showPluginInstallResult(
  host: SlashCommandHost,
  beforeList: readonly PluginSummary[],
  summary: PluginSummary,
): void {
  const previous = beforeList.find((entry) => entry.id === summary.id);
  const serverWord = summary.mcpServerCount === 1 ? "server" : "servers";
  const mcpHint =
    summary.mcpServerCount > 0
      ? ` Declares ${summary.mcpServerCount} MCP ${serverWord}; enabled by default and configurable from /plugins.`
      : "";
  const action = describeInstallAction(previous, summary);
  host.showStatus(`${action} (${summary.id}).${mcpHint}`);
  host.showStatus(PLUGIN_RELOAD_HINT, "warning");
  // Gate on provenance, not just the id: a local/GitHub fork whose manifest
  // reuses a billed plugin's id is not the official quota-consuming build.
  if (
    QUOTA_CONSUMING_PLUGIN_IDS.includes(summary.id) &&
    isOfficialPluginInstall(summary)
  ) {
    host.showStatus(PLUGIN_QUOTA_NOTE, "warning");
  }
}

function describeInstallAction(
  previous: PluginSummary | undefined,
  next: PluginSummary,
): string {
  const sourceLabel = formatPluginSourceLabel(next);
  const versionFromTo = (prev?: string, cur?: string): string => {
    if (prev === undefined || prev === cur)
      return cur === undefined ? "" : ` ${cur}`;
    return ` ${prev} → ${cur ?? "-"}`;
  };
  if (previous === undefined) {
    return `Installed ${next.displayName}${versionFromTo(undefined, next.version)} ${sourcePhrase(sourceLabel)}`;
  }
  if (sourceIdentity(previous) !== sourceIdentity(next)) {
    const prevSourceLabel = formatPluginSourceLabel(previous);
    return `Migrated ${next.displayName}: ${prevSourceLabel} → ${sourceLabel}${versionFromTo(previous.version, next.version)}`;
  }
  return `Updated ${next.displayName}${versionFromTo(previous.version, next.version)} ${sourcePhrase(sourceLabel)}`;
}

// formatPluginSourceLabel already prefixes zip-url hosts with "via", so adding
// "from" would read as "from via <host>". Only prepend "from" otherwise.
function sourcePhrase(sourceLabel: string): string {
  return sourceLabel.startsWith("via ") ? sourceLabel : `from ${sourceLabel}`;
}

function sourceIdentity(plugin: PluginSummary): string {
  if (plugin.source === "github" && plugin.github !== undefined) {
    return `github:${plugin.github.owner}/${plugin.github.repo}`;
  }
  return plugin.source;
}

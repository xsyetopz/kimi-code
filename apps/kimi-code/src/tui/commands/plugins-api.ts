import { homedir as osHomedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import type { Session } from "@moonshot-ai/kimi-code-sdk";

import { NO_ACTIVE_SESSION_MESSAGE } from "../constant/kimi-tui";
import type { PluginsPanelTabId } from "../components/dialogs/plugins-selector";
import type { SlashCommandHost } from "./dispatch";

export interface ShowPluginsPickerOptions {
  readonly selectedId?: string;
  readonly pluginHint?: {
    readonly id: string;
    readonly text: string;
  };
  readonly initialTab?: PluginsPanelTabId;
  readonly marketplaceSource?: string;
}

export interface PluginMcpServerHint {
  readonly server: string;
  readonly text: string;
}

export interface ShowPluginMcpPickerOptions {
  readonly selectedServer?: string;
  readonly serverHint?: PluginMcpServerHint;
}

/** The plugin-management surface `/plugins` operates on. */
export type PluginApi = Pick<
  Session,
  | "listPlugins"
  | "installPlugin"
  | "setPluginEnabled"
  | "setPluginMcpServerEnabled"
  | "removePlugin"
  | "reloadPlugins"
  | "getPluginInfo"
>;

/**
 * Resolve the plugin-management API. On the v2 engine plugin state is
 * app-global, so a session-less startup still gets a working `/plugins`
 * through the harness's global facade; on v1 (and once a session exists) the
 * session's own API is used.
 */
export async function resolvePluginApi(
  host: SlashCommandHost,
): Promise<PluginApi> {
  if (host.session !== undefined) return host.session;
  if (!host.engineV2) {
    throw new Error(NO_ACTIVE_SESSION_MESSAGE);
  }
  return {
    listPlugins: () => host.harness.listPlugins(),
    installPlugin: (source) => host.harness.installPlugin(source),
    setPluginEnabled: (id, enabled) =>
      host.harness.setPluginEnabled(id, enabled),
    setPluginMcpServerEnabled: (id, server, enabled) =>
      host.harness.setPluginMcpServerEnabled(id, server, enabled),
    removePlugin: (id) => host.harness.removePlugin(id),
    reloadPlugins: () => host.harness.reloadPlugins(),
    getPluginInfo: (id) => host.harness.getPluginInfo(id),
  };
}

export const PLUGIN_RELOAD_HINT =
  "Run /new or /reload to apply plugin changes.";

export function truncateForStatus(input: string): string {
  const max = 80;
  return input.length > max ? `${input.slice(0, max - 1)}…` : input;
}

export function resolvePluginInstallSource(
  source: string,
  workDir: string,
): string {
  const trimmed = source.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://"))
    return trimmed;
  if (trimmed === "~") return osHomedir();
  if (trimmed.startsWith("~/")) return join(osHomedir(), trimmed.slice(2));
  return isAbsolute(trimmed) ? trimmed : resolve(workDir, trimmed);
}

export function pluginInlineChangeHint(): string {
  return "run /reload or /new to apply";
}

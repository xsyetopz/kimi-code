import { Input, truncateToWidth, visibleWidth } from "@moonshot-ai/kimi-tui";
import type {
  CapabilityStatus,
  PluginInfo,
  PluginMcpServerInfo,
  PluginSummary,
} from "@moonshot-ai/kimi-code-sdk";
import chalk from "chalk";

import { currentTheme } from "#/tui/theme";
import type { ColorPalette } from "#/tui/theme/colors";
import {
  formatPluginSourceLabel,
  pluginTrustLabel,
} from "#/tui/utils/plugin-source-label";
import {
  computeUpdateStatus,
  type PluginMarketplaceEntry,
} from "#/utils/plugin-marketplace";

export const MCP_SERVER_PREFIX = "mcp:";
export const ELLIPSIS = "…";

export const WEB_BRIDGE_URL =
  "https://www.kimi.com/features/webbridge#local-agent";
export const WEB_BRIDGE_ENTRY: PluginMarketplaceEntry = {
  id: "kimi-webbridge",
  displayName: "Kimi WebBridge",
  source: WEB_BRIDGE_URL,
  tier: "official",
  homepage: WEB_BRIDGE_URL,
  description:
    "Control your real browser from Kimi Code — navigate, click, type, and screenshot",
};

export function isPinnedWebBridgeEntry(entry: PluginMarketplaceEntry): boolean {
  return entry === WEB_BRIDGE_ENTRY;
}

export interface PluginsOverviewItem {
  readonly value: string;
  readonly kind: "plugin" | "action";
  readonly label: string;
  readonly status?: string;
  readonly description: string;
}

export function buildMcpItems(info: PluginInfo): PluginsOverviewItem[] {
  const items: PluginsOverviewItem[] = info.mcpServers.map((server) => ({
    value: `${MCP_SERVER_PREFIX}${server.name}`,
    kind: "plugin",
    label: server.name,
    status: server.enabled ? "enabled" : "disabled",
    description: mcpServerDescription(server),
  }));
  items.push({
    value: "back",
    kind: "action",
    label: "Back to installed plugins",
    description: "Return to the local plugin manager.",
  });
  return items;
}

function mcpServerDescription(server: PluginMcpServerInfo): string {
  const action = server.enabled ? "Enter/Space disable" : "Enter/Space enable";
  if (server.transport === "http" || server.transport === "sse") {
    return `${action} · ${server.transport.toUpperCase()} · ${server.url ?? server.runtimeName}`;
  }
  const args =
    server.args !== undefined && server.args.length > 0
      ? ` ${server.args.join(" ")}`
      : "";
  const command = `${server.command ?? ""}${args}`.trim();
  const cwd = server.cwd === undefined ? "" : ` · cwd ${server.cwd}`;
  return `${action} · stdio · ${command || server.runtimeName}${cwd}`;
}

export function mcpItemServerName(
  item: PluginsOverviewItem,
): string | undefined {
  if (!item.value.startsWith(MCP_SERVER_PREFIX)) return undefined;
  return item.value.slice(MCP_SERVER_PREFIX.length);
}

export function overviewPluginDescription(plugin: PluginSummary): string {
  const state = plugin.state === "ok" ? "" : ` · state ${plugin.state}`;
  const skills = `${plugin.skillCount} skill${plugin.skillCount === 1 ? "" : "s"}`;
  const mcp =
    plugin.mcpServerCount > 0
      ? ` · MCP ${plugin.enabledMcpServerCount}/${plugin.mcpServerCount}`
      : "";
  const diagnostics = plugin.hasErrors ? " · diagnostics available" : "";
  const source = ` · ${formatPluginSourceLabel(plugin)}`;
  const trust = ` · ${pluginTrustLabel(plugin)}`;
  return `id ${plugin.id} · ${skills}${mcp}${source}${trust}${state}${diagnostics}`;
}

export function pluginStatus(plugin: PluginSummary): string | undefined {
  if (plugin.state !== "ok") return plugin.state;
  return plugin.enabled ? "enabled" : "disabled";
}

export function marketplaceStatusStyle(
  status: string,
  colors: ColorPalette,
): (text: string) => string {
  if (status.startsWith("update")) return chalk.hex(colors.warning);
  if (
    status === "finish setup" ||
    status === "installing…" ||
    status === "unsupported"
  ) {
    return chalk.hex(colors.warning);
  }
  if (status.startsWith("installed")) return chalk.hex(colors.textDim);
  return chalk.hex(colors.primary);
}

export function renderUrlInputBox(
  input: Input,
  focused: boolean,
  width: number,
  colors: ColorPalette,
): string[] {
  input.focused = focused;
  const border = (s: string): string => chalk.hex(colors.primary)(s);
  const boxWidth = Math.max(24, width - 2);
  const innerWidth = Math.max(10, boxWidth - 4);
  const inputLine = input.render(innerWidth)[0] ?? "";
  const rightPad = Math.max(0, innerWidth - visibleWidth(inputLine));
  return [
    " " + border("╭" + "─".repeat(boxWidth - 2) + "╮"),
    " " + border("│") + "  " + inputLine + " ".repeat(rightPad) + border("│"),
    " " + border("╰" + "─".repeat(boxWidth - 2) + "╯"),
  ];
}

export function marketplaceEntryDescription(
  entry: PluginMarketplaceEntry,
): string {
  const tier = marketplaceTierLabel(entry.tier);
  const description = entry.description ?? tier;
  const version = entry.version !== undefined ? ` · v${entry.version}` : "";
  const keywords =
    entry.keywords !== undefined && entry.keywords.length > 0
      ? ` · ${entry.keywords.join(", ")}`
      : "";
  const tierSuffix = entry.description !== undefined ? ` · ${tier}` : "";
  return `${description} · id ${entry.id}${version}${tierSuffix}${keywords}`;
}

function marketplaceTierLabel(tier: PluginMarketplaceEntry["tier"]): string {
  if (tier === "official") return "Official plugin";
  if (tier === "curated") return "Curated plugin";
  return "Plugin";
}

export function capabilityMarketplaceEntry(
  capability: CapabilityStatus,
): PluginMarketplaceEntry {
  return {
    id: capability.id,
    displayName: capability.displayName,
    source: `capability:${capability.id}`,
    tier: "official",
    description: capability.description,
    builtIn: true,
  };
}

export function capabilityNeedsSetup(capability: CapabilityStatus): boolean {
  return (
    (capability.state === "not_installed" || capability.state === "partial") &&
    !capability.install.running
  );
}

export function capabilityRowStatus(
  capability: CapabilityStatus,
  entry: PluginMarketplaceEntry,
): string {
  if (capability.install.running) return "installing…";
  switch (capability.state) {
    case "ready":
      return capability.version === undefined
        ? "ready"
        : `ready · ${formatCapabilityVersion(capability.version)}`;
    case "partial":
      return "finish setup";
    case "not_installed":
      return installStatus(entry);
    case "unsupported":
      return "unsupported";
  }
}

export function formatCapabilityVersion(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

export function describeCapabilityIssues(capability: CapabilityStatus): string {
  const issues: string[] = [];
  const required = capability.steps.filter(
    (step) => step.optional !== true && step.state !== "ok",
  );
  if (required.length > 0) {
    issues.push(`needs ${required.map(formatCapabilityStep).join(", ")}`);
  }
  const extension = capability.steps.find(
    (step) => step.id === "extension" && step.state !== "ok",
  );
  if (extension !== undefined) issues.push("browser extension not connected");
  const skillShadow = capability.steps.find(
    (step) => step.id === "skill-shadow" && step.state !== "ok",
  );
  if (skillShadow !== undefined)
    issues.push("user skill shadows managed plugin");
  return issues.join(", ");
}

function formatCapabilityStep(step: CapabilityStatus["steps"][number]): string {
  const label =
    step.id === "daemon-binary"
      ? "daemon binary"
      : step.id === "skill"
        ? "agent skill"
        : step.id;
  if (step.detail === undefined || step.detail.length === 0) return label;
  const detail = step.detail
    .replaceAll("screenRecording", "screen recording")
    .replaceAll(",", ", ");
  return `${label} (${detail})`;
}

function installStatus(entry: PluginMarketplaceEntry): string {
  return entry.version === undefined ? "install" : `install v${entry.version}`;
}

export function marketplaceEntryStatus(
  entry: PluginMarketplaceEntry,
  installed: ReadonlyMap<string, string | undefined>,
): string {
  const status = computeUpdateStatus(
    entry.version,
    installed.get(entry.id),
    installed.has(entry.id),
  );
  switch (status.kind) {
    case "update":
      return `update ${status.local} → ${status.latest}`;
    case "up-to-date":
      return status.version === undefined
        ? "installed"
        : `installed · v${status.version}`;
    case "not-installed":
      return installStatus(entry);
  }
}

export function sectionLabel(label: string, colors: ColorPalette): string {
  return chalk.hex(colors.textDim).bold(` ${label}`);
}

export function statusStyle(
  item: PluginsOverviewItem,
  colors: ColorPalette,
): (text: string) => string {
  if (item.kind === "action") return chalk.hex(colors.textDim);
  if (item.status === "enabled" || item.status === "installed")
    return chalk.hex(colors.success);
  if (item.status?.startsWith("install")) return chalk.hex(colors.primary);
  if (item.status === "disabled") return chalk.hex(colors.textDim);
  if (item.status !== undefined && /^\d/.test(item.status))
    return chalk.hex(colors.textDim);
  return chalk.hex(colors.warning);
}

export function mutedHintLine(text: string, colors?: ColorPalette): string {
  if (colors !== undefined) {
    return chalk.hex(colors.textMuted)(text);
  }
  return currentTheme.fg("textMuted", text);
}

export function wrapOverviewDescription(text: string, width: number): string[] {
  const maxWidth = Math.max(1, width);
  const words = text
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (visibleWidth(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current.length > 0) lines.push(current);
    current =
      visibleWidth(word) <= maxWidth
        ? word
        : truncateToWidth(word, maxWidth, ELLIPSIS);
  }

  if (current.length > 0) lines.push(current);
  return lines;
}

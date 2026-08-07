import type {
  CapabilityStatus,
  PluginSummary,
} from "@moonshot-ai/kimi-code-sdk";
import { truncateToWidth, visibleWidth } from "@moonshot-ai/kimi-tui";

import {
  describeCapabilityIssues,
  formatCapabilityVersion,
} from "#/tui/components/dialogs/plugins-selector";
import {
  formatPluginSourceLabel,
  pluginTrustLabel,
} from "#/tui/utils/plugin-source-label";
import {
  computeUpdateStatus,
  type PluginMarketplaceEntry,
} from "#/utils/plugin-marketplace";

import {
  PLUGINS_PANEL_ELLIPSIS,
  WEB_BRIDGE_ENTRY,
  type InkPluginsPanelRowStatusTone,
} from "./plugins-panel-types";

export function isPinnedWebBridgeEntry(entry: PluginMarketplaceEntry): boolean {
  return entry === WEB_BRIDGE_ENTRY;
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

export function installStatus(entry: PluginMarketplaceEntry): string {
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

export function marketplaceTierLabel(
  tier: PluginMarketplaceEntry["tier"],
): string {
  if (tier === "official") return "Official plugin";
  if (tier === "curated") return "Curated plugin";
  return "Plugin";
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

export function installedStatusTone(
  status: string | undefined,
): InkPluginsPanelRowStatusTone {
  if (status === "enabled") return "success";
  if (status === "disabled") return "dim";
  return "warning";
}

export function marketplaceStatusTone(
  status: string,
): InkPluginsPanelRowStatusTone {
  if (status.startsWith("update")) return "warning";
  if (
    status === "finish setup" ||
    status === "installing…" ||
    status === "unsupported"
  ) {
    return "warning";
  }
  if (status.startsWith("installed")) return "dim";
  return "primary";
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
        : truncateToWidth(word, maxWidth, PLUGINS_PANEL_ELLIPSIS);
  }

  if (current.length > 0) lines.push(current);
  return lines;
}

export function capabilityIssuesText(capability: CapabilityStatus): string {
  return describeCapabilityIssues(capability);
}

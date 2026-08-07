import type {
  CapabilityStatus,
  PluginSummary,
} from "@moonshot-ai/kimi-code-sdk";

import type { PluginsPanelOptions } from "#/tui/components/dialogs/plugins-selector";
import {
  computeUpdateStatus,
  type PluginMarketplaceEntry,
} from "#/utils/plugin-marketplace";

import {
  capabilityMarketplaceEntry,
} from "./plugins-panel-format";
import { WEB_BRIDGE_ENTRY, type PluginsPanelMarketState } from "./plugins-panel-types";

export function pluginsPanelCapabilityFor(
  capabilities: readonly CapabilityStatus[] | undefined,
  id: string,
): CapabilityStatus | undefined {
  return capabilities?.find((capability) => capability.id === id);
}

export function pluginsPanelCapabilityForEntry(
  capabilities: readonly CapabilityStatus[] | undefined,
  entry: PluginMarketplaceEntry,
): CapabilityStatus | undefined {
  return entry.builtIn === true
    ? pluginsPanelCapabilityFor(capabilities, entry.id)
    : undefined;
}

export function pluginsPanelInstalledVersions(
  installed: readonly PluginSummary[],
): ReadonlyMap<string, string | undefined> {
  return new Map(
    installed.map((plugin) => [plugin.id, plugin.version]),
  );
}

export function pluginsPanelMarketplaceEntries(
  market: PluginsPanelMarketState,
  installedIds: ReadonlySet<string>,
): readonly PluginMarketplaceEntry[] {
  if (market.status !== "loaded") return [];
  return market.entries.toSorted(
    (a, b) => Number(installedIds.has(b.id)) - Number(installedIds.has(a.id)),
  );
}

export function pluginsPanelPendingBuiltInEntries(
  opts: PluginsPanelOptions,
): readonly PluginMarketplaceEntry[] {
  if (opts.catalogIsDefault === false) return [];
  return (opts.capabilities ?? [])
    .filter((capability) => capability.supported)
    .map(capabilityMarketplaceEntry);
}

export function pluginsPanelOfficialCatalogEntries(
  marketplaceEntries: readonly PluginMarketplaceEntry[],
  capabilities: readonly CapabilityStatus[] | undefined,
): readonly PluginMarketplaceEntry[] {
  return marketplaceEntries.filter((entry) => {
    if (entry.tier !== "official") return false;
    return pluginsPanelCapabilityForEntry(capabilities, entry)?.supported !== false;
  });
}

export function pluginsPanelOfficialEntries(
  market: PluginsPanelMarketState,
  opts: PluginsPanelOptions,
  marketplaceEntries: readonly PluginMarketplaceEntry[],
): readonly PluginMarketplaceEntry[] {
  const pendingBuiltIn = pluginsPanelPendingBuiltInEntries(opts);
  if (market.status !== "loaded") {
    return pendingBuiltIn.some((entry) => entry.id === WEB_BRIDGE_ENTRY.id)
      ? pendingBuiltIn
      : [...pendingBuiltIn, WEB_BRIDGE_ENTRY];
  }
  const officialCatalog = pluginsPanelOfficialCatalogEntries(
    marketplaceEntries,
    opts.capabilities,
  );
  return officialCatalog.some((entry) => entry.id === WEB_BRIDGE_ENTRY.id)
    ? officialCatalog
    : [WEB_BRIDGE_ENTRY, ...officialCatalog];
}

export function pluginsPanelThirdPartyEntries(
  marketplaceEntries: readonly PluginMarketplaceEntry[],
): readonly PluginMarketplaceEntry[] {
  return marketplaceEntries.filter((entry) => entry.tier !== "official");
}

export function pluginsPanelInstalledUpdateStatus(
  market: PluginsPanelMarketState,
  plugin: PluginSummary,
):
  | { entry: PluginMarketplaceEntry; local: string; latest: string }
  | undefined {
  if (market.status !== "loaded") return undefined;
  const entry = market.entries.find((e) => e.id === plugin.id);
  if (entry === undefined) return undefined;
  const status = computeUpdateStatus(entry.version, plugin.version, true);
  return status.kind === "update"
    ? { entry, local: status.local, latest: status.latest }
    : undefined;
}

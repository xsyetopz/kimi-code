import type {
  CapabilityStatus,
  PluginSummary,
} from "@moonshot-ai/kimi-code-sdk";

import type { PluginsPanelOptions } from "#/tui/components/dialogs/plugins-selector";
import type { PluginMarketplaceEntry } from "#/utils/plugin-marketplace";

import {
  pluginsPanelCapabilityFor,
  pluginsPanelCapabilityForEntry,
  pluginsPanelInstalledUpdateStatus,
  pluginsPanelInstalledVersions,
  pluginsPanelOfficialCatalogEntries,
  pluginsPanelOfficialEntries,
  pluginsPanelThirdPartyEntries,
} from "./plugins-panel-entries";
import {
  capabilityIssuesText,
  capabilityNeedsSetup,
  capabilityRowStatus,
  installedStatusTone,
  isPinnedWebBridgeEntry,
  marketplaceEntryDescription,
  marketplaceEntryStatus,
  marketplaceStatusTone,
  overviewPluginDescription,
  pluginStatus,
  wrapOverviewDescription,
} from "./plugins-panel-format";
import type {
  InkPluginsPanelRowView,
  PluginsPanelMarketState,
} from "./plugins-panel-types";

export interface PluginsPanelProjectionState {
  readonly opts: PluginsPanelOptions;
  readonly market: PluginsPanelMarketState;
  readonly selectedIndex: number;
}

export function projectPluginsPanelInstalled(
  state: PluginsPanelProjectionState,
  descriptionWidth: number,
): {
  readonly rows: InkPluginsPanelRowView[];
  readonly footerLines: string[];
} {
  const { installed } = state.opts;
  if (installed.length === 0) {
    return {
      rows: [
        {
          label: "No plugins installed.",
          status: undefined,
          statusTone: "dim",
          descriptionLines: [],
          hint: undefined,
          selected: false,
        },
      ],
      footerLines: [" 0 installed"],
    };
  }
  const rows = installed.map((plugin, index) =>
    projectPluginsPanelInstalledRow(state, plugin, index, descriptionWidth),
  );
  return {
    rows,
    footerLines: [` ${installed.length} installed`],
  };
}

export function projectPluginsPanelInstalledRow(
  state: PluginsPanelProjectionState,
  plugin: PluginSummary,
  index: number,
  descriptionWidth: number,
): InkPluginsPanelRowView {
  const status = pluginStatus(plugin);
  const update = pluginsPanelInstalledUpdateStatus(state.market, plugin);
  const capability = pluginsPanelCapabilityFor(state.opts.capabilities, plugin.id);
  let rowStatus = status;
  let statusTone = installedStatusTone(status);
  if (update !== undefined) {
    rowStatus = `update ${update.local} → ${update.latest}`;
    statusTone = "warning";
  }
  if (capability !== undefined && capability.state !== "ready") {
    const badge = capability.install.running
      ? "installing…"
      : capabilityNeedsSetup(capability)
        ? "setup incomplete"
        : capability.state === "unsupported"
          ? "unsupported"
          : undefined;
    if (badge !== undefined) {
      rowStatus = badge;
      statusTone = badge === "unsupported" ? "dim" : "warning";
    }
  }
  const capabilityIssues =
    capability === undefined ? "" : capabilityIssuesText(capability);
  const description =
    capabilityIssues.length === 0
      ? overviewPluginDescription(plugin)
      : `${overviewPluginDescription(plugin)} · ${capabilityIssues}`;
  return {
    label: plugin.displayName,
    status: rowStatus,
    statusTone,
    descriptionLines: wrapOverviewDescription(description, descriptionWidth),
    hint:
      state.opts.pluginHint?.id === plugin.id
        ? state.opts.pluginHint.text
        : undefined,
    selected: index === state.selectedIndex,
  };
}

export function projectPluginsPanelOfficial(
  state: PluginsPanelProjectionState,
  marketplaceEntries: readonly PluginMarketplaceEntry[],
  descriptionWidth: number,
): {
  readonly rows: InkPluginsPanelRowView[];
  readonly footerLines: string[];
} {
  const officialEntries = pluginsPanelOfficialEntries(
    state.market,
    state.opts,
    marketplaceEntries,
  );
  if (state.market.status !== "loaded") {
    const rows = officialEntries.map((entry, index) =>
      projectPluginsPanelMarketplaceRow(
        state,
        entry,
        index,
        descriptionWidth,
        pluginsPanelInstalledVersions(state.opts.installed),
      ),
    );
    return projectPluginsPanelPendingMarketplace(
      state,
      rows,
      officialEntries,
      descriptionWidth,
    );
  }
  return projectPluginsPanelMarketplaceList(
    state,
    officialEntries,
    descriptionWidth,
    pluginsPanelOfficialCatalogEntries(
      marketplaceEntries,
      state.opts.capabilities,
    ),
  );
}

export function projectPluginsPanelThirdParty(
  state: PluginsPanelProjectionState,
  marketplaceEntries: readonly PluginMarketplaceEntry[],
  descriptionWidth: number,
): {
  readonly rows: InkPluginsPanelRowView[];
  readonly footerLines: string[];
} {
  const thirdPartyEntries = pluginsPanelThirdPartyEntries(marketplaceEntries);
  if (state.market.status !== "loaded") {
    return projectPluginsPanelPendingMarketplace(
      state,
      [],
      thirdPartyEntries,
      descriptionWidth,
    );
  }
  return projectPluginsPanelMarketplaceList(
    state,
    thirdPartyEntries,
    descriptionWidth,
    thirdPartyEntries,
  );
}

function projectPluginsPanelPendingMarketplace(
  state: PluginsPanelProjectionState,
  rows: readonly InkPluginsPanelRowView[],
  entriesForCount: readonly PluginMarketplaceEntry[],
  descriptionWidth: number,
): {
  readonly rows: InkPluginsPanelRowView[];
  readonly footerLines: string[];
} {
  if (state.market.status === "loading" || state.market.status === "idle") {
    return {
      rows: [
        ...rows,
        {
          label: "Loading marketplace…",
          status: undefined,
          statusTone: "dim",
          descriptionLines: [],
          hint: undefined,
          selected: false,
        },
      ],
      footerLines: pluginsPanelMarketFooterLines(state, entriesForCount),
    };
  }
  if (state.market.status === "error") {
    return {
      rows: [
        ...rows,
        {
          label: `Marketplace unavailable: ${state.market.message}`,
          status: undefined,
          statusTone: "warning",
          descriptionLines: wrapOverviewDescription(
            "Use the Custom tab to install from a URL.",
            descriptionWidth,
          ),
          hint: undefined,
          selected: false,
        },
      ],
      footerLines: [],
    };
  }
  return projectPluginsPanelMarketplaceFooter(
    state,
    rows,
    entriesForCount,
    rows.length,
  );
}

function projectPluginsPanelMarketplaceList(
  state: PluginsPanelProjectionState,
  entries: readonly PluginMarketplaceEntry[],
  descriptionWidth: number,
  entriesForCount: readonly PluginMarketplaceEntry[],
): {
  readonly rows: InkPluginsPanelRowView[];
  readonly footerLines: string[];
} {
  const installedVersions = pluginsPanelInstalledVersions(state.opts.installed);
  if (state.market.status === "loading" || state.market.status === "idle") {
    return {
      rows: [
        {
          label: "Loading marketplace…",
          status: undefined,
          statusTone: "dim",
          descriptionLines: [],
          hint: undefined,
          selected: false,
        },
      ],
      footerLines: [],
    };
  }
  if (state.market.status === "error") {
    return {
      rows: [
        {
          label: `Marketplace unavailable: ${state.market.message}`,
          status: undefined,
          statusTone: "warning",
          descriptionLines: ["Use the Custom tab to install from a URL."],
          hint: undefined,
          selected: false,
        },
      ],
      footerLines: [],
    };
  }
  const rows = entries.map((entry, index) =>
    projectPluginsPanelMarketplaceRow(
      state,
      entry,
      index,
      descriptionWidth,
      installedVersions,
    ),
  );
  return projectPluginsPanelMarketplaceFooter(state, rows, entriesForCount, 0);
}

function projectPluginsPanelMarketplaceFooter(
  state: PluginsPanelProjectionState,
  rows: readonly InkPluginsPanelRowView[],
  entriesForCount: readonly PluginMarketplaceEntry[],
  indexOffset: number,
): {
  readonly rows: InkPluginsPanelRowView[];
  readonly footerLines: string[];
} {
  if (
    rows.length === 0 &&
    state.market.status === "loaded" &&
    indexOffset === 0
  ) {
    return {
      rows: [
        {
          label: "No plugins found.",
          status: undefined,
          statusTone: "dim",
          descriptionLines: [],
          hint: undefined,
          selected: false,
        },
      ],
      footerLines: pluginsPanelMarketFooterLines(state, entriesForCount),
    };
  }
  return {
    rows,
    footerLines: pluginsPanelMarketFooterLines(state, entriesForCount),
  };
}

function pluginsPanelMarketFooterLines(
  state: PluginsPanelProjectionState,
  entriesForCount: readonly PluginMarketplaceEntry[],
): string[] {
  if (state.market.status !== "loaded") return [];
  const installedCount = entriesForCount.filter((entry) =>
    state.opts.installedIds.has(entry.id),
  ).length;
  return [
    ` ${installedCount} installed · ${entriesForCount.length - installedCount} available`,
    ` Source: ${state.market.source}`,
  ];
}

function projectPluginsPanelMarketplaceRow(
  state: PluginsPanelProjectionState,
  entry: PluginMarketplaceEntry,
  index: number,
  descriptionWidth: number,
  installedVersions: ReadonlyMap<string, string | undefined>,
): InkPluginsPanelRowView {
  const capability = pluginsPanelCapabilityForEntry(
    state.opts.capabilities,
    entry,
  );
  const status = isPinnedWebBridgeEntry(entry)
    ? "open in browser"
    : capability === undefined
      ? marketplaceEntryStatus(entry, installedVersions)
      : capabilityRowStatus(capability, entry);
  const capabilityIssues =
    capability === undefined ? "" : capabilityIssuesText(capability);
  const description =
    capabilityIssues.length === 0
      ? marketplaceEntryDescription(entry)
      : `${marketplaceEntryDescription(entry)} · ${capabilityIssues}`;
  return {
    label: entry.displayName,
    status,
    statusTone: marketplaceStatusTone(status),
    descriptionLines: wrapOverviewDescription(description, descriptionWidth),
    hint: undefined,
    selected: index === state.selectedIndex,
  };
}

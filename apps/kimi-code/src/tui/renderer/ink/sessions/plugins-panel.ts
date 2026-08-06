import type {
  CapabilityStatus,
  PluginSummary,
} from "@moonshot-ai/kimi-code-sdk";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@moonshot-ai/kimi-tui";

import {
  describeCapabilityIssues,
  formatCapabilityVersion,
  type PluginsPanelOptions,
  type PluginsPanelSelection,
  type PluginsPanelStateSnapshot,
  type PluginsPanelTabId,
} from "#/tui/components/dialogs/plugins-selector";
import { printableChar } from "#/tui/utils/printable-key";
import {
  formatPluginSourceLabel,
  pluginTrustLabel,
} from "#/tui/utils/plugin-source-label";
import {
  computeUpdateStatus,
  type PluginMarketplaceEntry,
} from "#/utils/plugin-marketplace";

const ELLIPSIS = "…";
const WEB_BRIDGE_URL = "https://www.kimi.com/features/webbridge#local-agent";
const WEB_BRIDGE_ENTRY: PluginMarketplaceEntry = {
  id: "kimi-webbridge",
  displayName: "Kimi WebBridge",
  source: WEB_BRIDGE_URL,
  tier: "official",
  homepage: WEB_BRIDGE_URL,
  description:
    "Control your real browser from Kimi Code — navigate, click, type, and screenshot",
};

const PLUGINS_PANEL_TABS: readonly { id: PluginsPanelTabId; label: string }[] =
  [
    { id: "installed", label: "Installed" },
    { id: "official", label: "Official" },
    { id: "third-party", label: "Third-party" },
    { id: "custom", label: "Custom" },
  ];

type MarketState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | {
      readonly status: "loaded";
      readonly entries: readonly PluginMarketplaceEntry[];
      readonly source: string;
    };

export type InkPluginsPanelRowStatusTone =
  | "primary"
  | "success"
  | "warning"
  | "dim";

export interface InkPluginsPanelRowView {
  readonly label: string;
  readonly status: string | undefined;
  readonly statusTone: InkPluginsPanelRowStatusTone;
  readonly descriptionLines: readonly string[];
  readonly hint: string | undefined;
  readonly selected: boolean;
}

export interface InkPluginsPanelView {
  readonly title: string;
  readonly hint: string;
  readonly tabs: readonly { readonly label: string; readonly active: boolean }[];
  readonly mode: "installing" | "list" | "custom";
  readonly rows: readonly InkPluginsPanelRowView[];
  readonly footerLines: readonly string[];
  readonly customPrompt: string | undefined;
  readonly customInput: string | undefined;
  readonly installingLabel: string | undefined;
}

export class InkPluginsPanelSession {
  private readonly opts: PluginsPanelOptions;
  private activeTabIndex: number;
  private selectedIndex = 0;
  private market: MarketState = { status: "idle" };
  private installing: string | undefined;
  private customText = "";
  private onStateChange: (() => void) | null = null;

  constructor(opts: PluginsPanelOptions) {
    this.opts = opts;
    this.activeTabIndex = Math.max(
      0,
      PLUGINS_PANEL_TABS.findIndex(
        (tab) => tab.id === (opts.initialTab ?? "installed"),
      ),
    );
    if (opts.selectedId !== undefined && this.activeTab.id === "installed") {
      const idx = opts.installed.findIndex((p) => p.id === opts.selectedId);
      if (idx >= 0) this.selectedIndex = idx;
    }
  }

  setOnStateChange(onStateChange: (() => void) | null): void {
    this.onStateChange = onStateChange;
  }

  importState(snapshot: PluginsPanelStateSnapshot): void {
    this.activeTabIndex = snapshot.activeTabIndex;
    this.selectedIndex = snapshot.selectedIndex;
    this.market = snapshot.market;
    this.installing = snapshot.installing;
    this.customText = snapshot.customText;
  }

  exportState(): PluginsPanelStateSnapshot {
    return {
      activeTabIndex: this.activeTabIndex,
      selectedIndex: this.selectedIndex,
      market: this.market,
      installing: this.installing,
      customText: this.customText,
    };
  }

  setMarketplaceLoading(): void {
    this.market = { status: "loading" };
    this.notifyChange();
  }

  setMarketplace(
    entries: readonly PluginMarketplaceEntry[],
    source: string,
  ): void {
    this.market = { status: "loaded", entries, source };
    this.notifyChange();
  }

  setMarketplaceError(message: string): void {
    this.market = { status: "error", message };
    this.notifyChange();
  }

  setInstalling(label: string): void {
    this.installing = label;
    this.notifyChange();
  }

  clearInstalling(): void {
    this.installing = undefined;
    this.notifyChange();
  }

  handleInput(
    data: string,
    callbacks: {
      readonly onSelect: (selection: PluginsPanelSelection) => void;
      readonly onCancel: () => void;
    },
  ): boolean {
    if (this.installing !== undefined) return true;
    if (matchesKey(data, Key.escape)) {
      callbacks.onCancel();
      return true;
    }
    if (matchesKey(data, Key.tab)) {
      this.activeTabIndex =
        (this.activeTabIndex + 1) % PLUGINS_PANEL_TABS.length;
      this.selectedIndex = 0;
      this.requestMarketplaceIfNeeded();
      this.notifyChange();
      return true;
    }
    if (matchesKey(data, Key.shift("tab"))) {
      this.activeTabIndex =
        (this.activeTabIndex - 1 + PLUGINS_PANEL_TABS.length) %
        PLUGINS_PANEL_TABS.length;
      this.selectedIndex = 0;
      this.requestMarketplaceIfNeeded();
      this.notifyChange();
      return true;
    }
    switch (this.activeTab.id) {
      case "installed":
        this.handleInstalledInput(data, callbacks.onSelect);
        return true;
      case "official":
      case "third-party":
        this.handleMarketplaceInput(data, callbacks.onSelect);
        return true;
      case "custom":
        this.handleCustomInput(data, callbacks.onSelect);
        return true;
    }
  }

  projectView(width = 120): InkPluginsPanelView {
    if (this.installing !== undefined) {
      return {
        title: "Plugins",
        hint: "",
        tabs: [],
        mode: "installing",
        rows: [],
        footerLines: [],
        customPrompt: undefined,
        customInput: undefined,
        installingLabel: this.installing,
      };
    }

    const tab = this.activeTab.id;
    const hint =
      tab === "installed"
        ? this.installedHint()
        : tab === "custom"
          ? " Tab switch · Enter install · Esc cancel"
          : " Tab switch · ↑↓ navigate · Enter open/install · Esc cancel";

    const descriptionWidth = Math.max(1, width - 4);
    let rows: InkPluginsPanelRowView[] = [];
    let footerLines: string[] = [];

    if (tab === "installed") {
      ({ rows, footerLines } = this.projectInstalled(descriptionWidth));
    } else if (tab === "official") {
      ({ rows, footerLines } = this.projectOfficial(descriptionWidth));
    } else if (tab === "third-party") {
      ({ rows, footerLines } = this.projectThirdParty(descriptionWidth));
    }

    return {
      title: "Plugins",
      hint,
      tabs: PLUGINS_PANEL_TABS.map((item, index) => ({
        label: item.label,
        active: index === this.activeTabIndex,
      })),
      mode: tab === "custom" ? "custom" : "list",
      rows,
      footerLines,
      customPrompt:
        tab === "custom"
          ? " Install from a GitHub URL (or zip URL / local path):"
          : undefined,
      customInput: tab === "custom" ? this.customText : undefined,
      installingLabel: undefined,
    };
  }

  private notifyChange(): void {
    this.onStateChange?.();
  }

  private get activeTab(): (typeof PLUGINS_PANEL_TABS)[number] {
    return PLUGINS_PANEL_TABS[this.activeTabIndex]!;
  }

  private get marketplaceEntries(): readonly PluginMarketplaceEntry[] {
    if (this.market.status !== "loaded") return [];
    const { installedIds } = this.opts;
    return this.market.entries.toSorted(
      (a, b) => Number(installedIds.has(b.id)) - Number(installedIds.has(a.id)),
    );
  }

  private get installedVersions(): ReadonlyMap<string, string | undefined> {
    return new Map(
      this.opts.installed.map((plugin) => [plugin.id, plugin.version]),
    );
  }

  private capabilityFor(id: string): CapabilityStatus | undefined {
    return this.opts.capabilities?.find((capability) => capability.id === id);
  }

  private capabilityForEntry(
    entry: PluginMarketplaceEntry,
  ): CapabilityStatus | undefined {
    return entry.builtIn === true ? this.capabilityFor(entry.id) : undefined;
  }

  private get officialEntries(): readonly PluginMarketplaceEntry[] {
    if (this.market.status !== "loaded") {
      return this.pendingBuiltInEntries.some(
        (entry) => entry.id === WEB_BRIDGE_ENTRY.id,
      )
        ? this.pendingBuiltInEntries
        : [...this.pendingBuiltInEntries, WEB_BRIDGE_ENTRY];
    }
    return this.officialCatalogEntries.some(
      (entry) => entry.id === WEB_BRIDGE_ENTRY.id,
    )
      ? this.officialCatalogEntries
      : [WEB_BRIDGE_ENTRY, ...this.officialCatalogEntries];
  }

  private get pendingBuiltInEntries(): readonly PluginMarketplaceEntry[] {
    if (this.opts.catalogIsDefault === false) return [];
    return (this.opts.capabilities ?? [])
      .filter((capability) => capability.supported)
      .map(capabilityMarketplaceEntry);
  }

  private get officialCatalogEntries(): readonly PluginMarketplaceEntry[] {
    return this.marketplaceEntries.filter((entry) => {
      if (entry.tier !== "official") return false;
      return this.capabilityForEntry(entry)?.supported !== false;
    });
  }

  private get thirdPartyEntries(): readonly PluginMarketplaceEntry[] {
    return this.marketplaceEntries.filter((entry) => entry.tier !== "official");
  }

  private requestMarketplaceIfNeeded(): void {
    if (this.market.status === "idle" && this.activeTab.id !== "custom") {
      this.market = { status: "loading" };
      this.opts.onRequestMarketplace?.();
      this.notifyChange();
    }
  }

  private handleInstalledInput(
    data: string,
    onSelect: (selection: PluginsPanelSelection) => void,
  ): void {
    const plugins = this.opts.installed;
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.notifyChange();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(plugins.length - 1, this.selectedIndex + 1);
      this.notifyChange();
      return;
    }
    const plugin = plugins[this.selectedIndex];
    const ch = printableChar(data);
    if (matchesKey(data, Key.space) || ch === " ") {
      if (plugin !== undefined) {
        onSelect({
          kind: "toggle",
          id: plugin.id,
          enabled: !plugin.enabled,
        });
      }
      return;
    }
    if (ch === "d" || ch === "D") {
      if (plugin !== undefined) onSelect({ kind: "remove", id: plugin.id });
      return;
    }
    if (ch === "m" || ch === "M") {
      if (plugin !== undefined) onSelect({ kind: "mcp", id: plugin.id });
      return;
    }
    if (ch === "r" || ch === "R") {
      onSelect({ kind: "reload" });
      return;
    }
    if (matchesKey(data, Key.enter)) {
      if (plugin === undefined) return;
      const capability = this.capabilityFor(plugin.id);
      if (capability !== undefined && capabilityNeedsSetup(capability)) {
        onSelect({
          kind: "install",
          entry: capabilityMarketplaceEntry(capability),
        });
        return;
      }
      const update = this.installedUpdateStatus(plugin);
      if (update !== undefined) {
        onSelect({ kind: "install", entry: update.entry });
      } else {
        onSelect({ kind: "details", id: plugin.id });
      }
      return;
    }
    if (ch === "i" || ch === "I") {
      if (plugin !== undefined) onSelect({ kind: "details", id: plugin.id });
    }
  }

  private handleMarketplaceInput(
    data: string,
    onSelect: (selection: PluginsPanelSelection) => void,
  ): void {
    const entries =
      this.activeTab.id === "official"
        ? this.officialEntries
        : this.thirdPartyEntries;
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.notifyChange();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex =
        entries.length === 0
          ? 0
          : Math.min(entries.length - 1, this.selectedIndex + 1);
      this.notifyChange();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const entry = entries[this.selectedIndex];
      if (entry === undefined) return;
      if (isPinnedWebBridgeEntry(entry)) {
        onSelect({
          kind: "open-url",
          url: WEB_BRIDGE_URL,
          label: entry.displayName,
        });
        return;
      }
      onSelect({ kind: "install", entry });
    }
  }

  private handleCustomInput(
    data: string,
    onSelect: (selection: PluginsPanelSelection) => void,
  ): void {
    if (matchesKey(data, Key.enter)) {
      const source = this.customText.trim();
      if (source.length > 0) onSelect({ kind: "install-source", source });
      return;
    }
    if (matchesKey(data, Key.backspace) || data === "\u007f") {
      if (this.customText.length > 0) {
        this.customText = this.customText.slice(0, -1);
        this.notifyChange();
      }
      return;
    }
    const ch = printableChar(data);
    if (ch !== undefined && ch.length === 1 && ch >= " ") {
      this.customText += ch;
      this.notifyChange();
    }
  }

  private installedHint(): string {
    const plugin = this.opts.installed[this.selectedIndex];
    const capability =
      plugin === undefined ? undefined : this.capabilityFor(plugin.id);
    const needsSetup =
      capability !== undefined && capabilityNeedsSetup(capability);
    const hasUpdate =
      plugin !== undefined && this.installedUpdateStatus(plugin) !== undefined;
    const enter = needsSetup
      ? "Enter finish setup"
      : hasUpdate
        ? "Enter update"
        : "Enter details";
    return ` Tab switch · Space toggle · D remove · M MCP · ${enter} · I details · R reload · Esc cancel`;
  }

  private installedUpdateStatus(
    plugin: PluginSummary,
  ):
    | { entry: PluginMarketplaceEntry; local: string; latest: string }
    | undefined {
    if (this.market.status !== "loaded") return undefined;
    const entry = this.market.entries.find((e) => e.id === plugin.id);
    if (entry === undefined) return undefined;
    const status = computeUpdateStatus(entry.version, plugin.version, true);
    return status.kind === "update"
      ? { entry, local: status.local, latest: status.latest }
      : undefined;
  }

  private projectInstalled(descriptionWidth: number): {
    readonly rows: InkPluginsPanelRowView[];
    readonly footerLines: string[];
  } {
    const { installed } = this.opts;
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
      this.projectInstalledRow(plugin, index, descriptionWidth),
    );
    return {
      rows,
      footerLines: [` ${installed.length} installed`],
    };
  }

  private projectInstalledRow(
    plugin: PluginSummary,
    index: number,
    descriptionWidth: number,
  ): InkPluginsPanelRowView {
    const status = pluginStatus(plugin);
    const update = this.installedUpdateStatus(plugin);
    const capability = this.capabilityFor(plugin.id);
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
      capability === undefined ? "" : describeCapabilityIssues(capability);
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
        this.opts.pluginHint?.id === plugin.id
          ? this.opts.pluginHint.text
          : undefined,
      selected: index === this.selectedIndex,
    };
  }

  private projectOfficial(descriptionWidth: number): {
    readonly rows: InkPluginsPanelRowView[];
    readonly footerLines: string[];
  } {
    if (this.market.status !== "loaded") {
      const entries = this.officialEntries;
      const rows = entries.map((entry, index) =>
        this.projectMarketplaceRow(entry, index, descriptionWidth),
      );
      return this.projectPendingMarketplace(rows, entries, descriptionWidth);
    }
    return this.projectMarketplaceList(
      this.officialEntries,
      descriptionWidth,
      this.officialCatalogEntries,
    );
  }

  private projectThirdParty(descriptionWidth: number): {
    readonly rows: InkPluginsPanelRowView[];
    readonly footerLines: string[];
  } {
    if (this.market.status !== "loaded") {
      return this.projectPendingMarketplace([], this.thirdPartyEntries, descriptionWidth);
    }
    return this.projectMarketplaceList(
      this.thirdPartyEntries,
      descriptionWidth,
      this.thirdPartyEntries,
    );
  }

  private projectPendingMarketplace(
    rows: readonly InkPluginsPanelRowView[],
    entriesForCount: readonly PluginMarketplaceEntry[],
    descriptionWidth: number,
  ): {
    readonly rows: InkPluginsPanelRowView[];
    readonly footerLines: string[];
  } {
    if (this.market.status === "loading" || this.market.status === "idle") {
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
        footerLines: this.marketFooterLines(entriesForCount),
      };
    }
    if (this.market.status === "error") {
      return {
        rows: [
          ...rows,
          {
            label: `Marketplace unavailable: ${this.market.message}`,
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
    return this.projectMarketplaceFooter(rows, entriesForCount, rows.length);
  }

  private projectMarketplaceList(
    entries: readonly PluginMarketplaceEntry[],
    descriptionWidth: number,
    entriesForCount: readonly PluginMarketplaceEntry[],
  ): {
    readonly rows: InkPluginsPanelRowView[];
    readonly footerLines: string[];
  } {
    if (this.market.status === "loading" || this.market.status === "idle") {
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
    if (this.market.status === "error") {
      return {
        rows: [
          {
            label: `Marketplace unavailable: ${this.market.message}`,
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
      this.projectMarketplaceRow(entry, index, descriptionWidth),
    );
    return this.projectMarketplaceFooter(rows, entriesForCount, 0);
  }

  private projectMarketplaceFooter(
    rows: readonly InkPluginsPanelRowView[],
    entriesForCount: readonly PluginMarketplaceEntry[],
    indexOffset: number,
  ): {
    readonly rows: InkPluginsPanelRowView[];
    readonly footerLines: string[];
  } {
    if (
      rows.length === 0 &&
      this.market.status === "loaded" &&
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
        footerLines: this.marketFooterLines(entriesForCount),
      };
    }
    return {
      rows,
      footerLines: this.marketFooterLines(entriesForCount),
    };
  }

  private marketFooterLines(
    entriesForCount: readonly PluginMarketplaceEntry[],
  ): string[] {
    if (this.market.status !== "loaded") return [];
    const installedCount = entriesForCount.filter((entry) =>
      this.opts.installedIds.has(entry.id),
    ).length;
    return [
      ` ${installedCount} installed · ${entriesForCount.length - installedCount} available`,
      ` Source: ${this.market.source}`,
    ];
  }

  private projectMarketplaceRow(
    entry: PluginMarketplaceEntry,
    index: number,
    descriptionWidth: number,
  ): InkPluginsPanelRowView {
    const capability = this.capabilityForEntry(entry);
    const status = isPinnedWebBridgeEntry(entry)
      ? "open in browser"
      : capability === undefined
        ? marketplaceEntryStatus(entry, this.installedVersions)
        : capabilityRowStatus(capability, entry);
    const capabilityIssues =
      capability === undefined ? "" : describeCapabilityIssues(capability);
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
      selected: index === this.selectedIndex,
    };
  }
}

function isPinnedWebBridgeEntry(entry: PluginMarketplaceEntry): boolean {
  return entry === WEB_BRIDGE_ENTRY;
}

function capabilityMarketplaceEntry(
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

function capabilityNeedsSetup(capability: CapabilityStatus): boolean {
  return (
    (capability.state === "not_installed" || capability.state === "partial") &&
    !capability.install.running
  );
}

function capabilityRowStatus(
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

function installStatus(entry: PluginMarketplaceEntry): string {
  return entry.version === undefined ? "install" : `install v${entry.version}`;
}

function marketplaceEntryStatus(
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

function marketplaceEntryDescription(entry: PluginMarketplaceEntry): string {
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

function overviewPluginDescription(plugin: PluginSummary): string {
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

function pluginStatus(plugin: PluginSummary): string | undefined {
  if (plugin.state !== "ok") return plugin.state;
  return plugin.enabled ? "enabled" : "disabled";
}

function installedStatusTone(
  status: string | undefined,
): InkPluginsPanelRowStatusTone {
  if (status === "enabled") return "success";
  if (status === "disabled") return "dim";
  return "warning";
}

function marketplaceStatusTone(
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

function wrapOverviewDescription(text: string, width: number): string[] {
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

export function createInkPluginsPanelSession(
  opts: PluginsPanelOptions,
): InkPluginsPanelSession {
  return new InkPluginsPanelSession(opts);
}

export function projectInkPluginsPanelView(
  session: InkPluginsPanelSession,
  width = 120,
): InkPluginsPanelView {
  return session.projectView(width);
}

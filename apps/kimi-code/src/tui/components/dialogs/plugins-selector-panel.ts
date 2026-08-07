import {
  Container,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from "@moonshot-ai/kimi-tui";
import type {
  CapabilityStatus,
  PluginInfo,
  PluginMcpServerInfo,
  PluginSummary,
} from "@moonshot-ai/kimi-code-sdk";
import chalk from "chalk";

import { SELECT_POINTER } from "#/tui/constant/symbols";
import { currentTheme } from "#/tui/theme";
import type { ColorPalette } from "#/tui/theme/colors";
import {
  formatPluginSourceLabel,
  pluginTrustLabel,
} from "#/tui/utils/plugin-source-label";
import { printableChar } from "#/tui/utils/printable-key";
import { renderTabStrip } from "#/tui/utils/tab-strip";
import {
  computeUpdateStatus,
  type PluginMarketplaceEntry,
} from "#/utils/plugin-marketplace";

import { ChoicePickerComponent } from "./choice-picker";
import {
  capabilityMarketplaceEntry,
  capabilityNeedsSetup,
  capabilityRowStatus,
  describeCapabilityIssues,
  ELLIPSIS,
  formatCapabilityVersion,
  isPinnedWebBridgeEntry,
  marketplaceEntryDescription,
  marketplaceEntryStatus,
  marketplaceStatusStyle,
  mutedHintLine,
  overviewPluginDescription,
  pluginStatus,
  renderUrlInputBox,
  sectionLabel,
  statusStyle,
  WEB_BRIDGE_ENTRY,
  WEB_BRIDGE_URL,
  wrapOverviewDescription,
} from "./plugins-selector-helpers";

export type PluginsPanelTabId =
  | "installed"
  | "official"
  | "third-party"
  | "custom";

export type PluginsPanelSelection =
  | { readonly kind: "toggle"; readonly id: string; readonly enabled: boolean }
  | { readonly kind: "remove"; readonly id: string }
  | { readonly kind: "mcp"; readonly id: string }
  | { readonly kind: "details"; readonly id: string }
  | { readonly kind: "reload" }
  | { readonly kind: "install"; readonly entry: PluginMarketplaceEntry }
  | { readonly kind: "install-source"; readonly source: string }
  | { readonly kind: "open-url"; readonly url: string; readonly label: string };

export interface PluginsPanelOptions {
  readonly installed: readonly PluginSummary[];
  readonly installedIds: ReadonlySet<string>;
  readonly capabilities?: readonly CapabilityStatus[];
  /**
   * False when the marketplace was explicitly replaced (slash-command
   * source or env override): built-in rows then stay out of the Official
   * tab entirely. Undefined means the default catalog.
   */
  readonly catalogIsDefault?: boolean;
  readonly initialTab?: PluginsPanelTabId;
  readonly selectedId?: string;
  readonly pluginHint?: { readonly id: string; readonly text: string };
  readonly onSelect: (selection: PluginsPanelSelection) => void;
  readonly onCancel: () => void;
  /** Called the first time the Official or Third-party tab needs its catalog.
   * The host fetches the marketplace and calls setMarketplace / setMarketplaceError. */
  readonly onRequestMarketplace?: () => void;
}

type MarketState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | {
      readonly status: "loaded";
      readonly entries: readonly PluginMarketplaceEntry[];
      readonly source: string;
    };

const PLUGINS_PANEL_TABS: readonly { id: PluginsPanelTabId; label: string }[] =
  [
    { id: "installed", label: "Installed" },
    { id: "official", label: "Official" },
    { id: "third-party", label: "Third-party" },
    { id: "custom", label: "Custom" },
  ];

export interface PluginsPanelStateSnapshot {
  readonly activeTabIndex: number;
  readonly selectedIndex: number;
  readonly market: MarketState;
  readonly installing: string | undefined;
  readonly customText: string;
}

export interface PluginsPanelInkSync {
  importState(snapshot: PluginsPanelStateSnapshot): void;
  exportState(): PluginsPanelStateSnapshot;
  setOnStateChange(onChange: (() => void) | null): void;
  setMarketplaceLoading(): void;
  setMarketplace(
    entries: readonly PluginMarketplaceEntry[],
    source: string,
  ): void;
  setMarketplaceError(message: string): void;
  setInstalling(label: string): void;
  clearInstalling(): void;
}

export class PluginsPanelComponent extends Container implements Focusable {
  focused = false;

  private readonly opts: PluginsPanelOptions;
  private readonly customInput = new Input();
  private activeTabIndex: number;
  private selectedIndex = 0;
  private market: MarketState = { status: "idle" };
  private installing: string | undefined;
  private inkSession: PluginsPanelInkSync | null = null;
  private inkOnChange: (() => void) | null = null;

  constructor(opts: PluginsPanelOptions) {
    super();
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
    this.customInput.onSubmit = (value) => {
      const source = value.trim();
      if (source.length > 0)
        this.opts.onSelect({ kind: "install-source", source });
    };
  }

  getPluginsPanelOptions(): PluginsPanelOptions {
    return this.opts;
  }

  exportState(): PluginsPanelStateSnapshot {
    return {
      activeTabIndex: this.activeTabIndex,
      selectedIndex: this.selectedIndex,
      market: this.market,
      installing: this.installing,
      customText: this.customInput.getValue(),
    };
  }

  importState(snapshot: PluginsPanelStateSnapshot): void {
    this.activeTabIndex = snapshot.activeTabIndex;
    this.selectedIndex = snapshot.selectedIndex;
    this.market = snapshot.market;
    this.installing = snapshot.installing;
    this.customInput.setValue(snapshot.customText);
    this.invalidate();
  }

  attachInkSession(session: PluginsPanelInkSync, onChange: () => void): void {
    this.inkSession = session;
    this.inkOnChange = onChange;
    session.importState(this.exportState());
    session.setOnStateChange(() => {
      this.importState(session.exportState());
      this.inkOnChange?.();
    });
  }

  private notifyInkChange(): void {
    this.inkOnChange?.();
  }

  marketplaceStatus(): MarketState["status"] {
    return this.market.status;
  }

  setMarketplaceLoading(): void {
    this.market = { status: "loading" };
    this.inkSession?.setMarketplaceLoading();
    this.notifyInkChange();
  }

  setMarketplace(
    entries: readonly PluginMarketplaceEntry[],
    source: string,
  ): void {
    this.market = { status: "loaded", entries, source };
    this.inkSession?.setMarketplace(entries, source);
    this.notifyInkChange();
  }

  setMarketplaceError(message: string): void {
    this.market = { status: "error", message };
    this.inkSession?.setMarketplaceError(message);
    this.notifyInkChange();
  }

  setInstalling(label: string): void {
    this.installing = label;
    this.inkSession?.setInstalling(label);
    this.invalidate();
    this.notifyInkChange();
  }

  clearInstalling(): void {
    this.installing = undefined;
    this.inkSession?.clearInstalling();
    this.invalidate();
    this.notifyInkChange();
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

  /** Capability state for a MARKETPLACE row: only our own injected rows
   * (flagged `builtIn` — a custom catalog cannot forge the flag) may show
   * capability status, matching how Enter routes them. */
  private capabilityForEntry(
    entry: PluginMarketplaceEntry,
  ): CapabilityStatus | undefined {
    return entry.builtIn === true ? this.capabilityFor(entry.id) : undefined;
  }

  private get officialEntries(): readonly PluginMarketplaceEntry[] {
    // While the catalog is loading or unreachable, the locally-known
    // capability rows still render and install — built-in runtime setup
    // must never be blocked by an unrelated catalog fetch.
    if (this.market.status !== "loaded") {
      return this.pendingBuiltInEntries.some(
        (entry) => entry.id === WEB_BRIDGE_ENTRY.id,
      )
        ? this.pendingBuiltInEntries
        : [...this.pendingBuiltInEntries, WEB_BRIDGE_ENTRY];
    }
    // The real catalog entry wins when present (it installs the actual
    // plugin); the hardcoded promo row is only a fallback while the catalog
    // is loading, unreachable, or predates it — never a duplicate row.
    return this.officialCatalogEntries.some(
      (entry) => entry.id === WEB_BRIDGE_ENTRY.id,
    )
      ? this.officialCatalogEntries
      : [WEB_BRIDGE_ENTRY, ...this.officialCatalogEntries];
  }

  /** Capability rows synthesized from the engine's registry, independent of
   * the marketplace state; unsupported platforms hide them entirely. Only
   * the default catalog gets built-in rows — an explicitly overridden
   * marketplace must be able to fully replace the Official tab. */
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
    // Anything not explicitly marked official lands here: `curated` entries plus
    // entries that omit `tier` (custom marketplaces often do). Without this,
    // untiered entries would be invisible in both marketplace tabs.
    return this.marketplaceEntries.filter((entry) => entry.tier !== "official");
  }

  private requestMarketplaceIfNeeded(): void {
    // The Installed tab also needs the catalog to render update badges; only the
    // Custom tab (manual URL entry) can skip the fetch entirely.
    if (this.market.status === "idle" && this.activeTab.id !== "custom") {
      this.market = { status: "loading" };
      this.opts.onRequestMarketplace?.();
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.activeTabIndex =
        (this.activeTabIndex + 1) % PLUGINS_PANEL_TABS.length;
      this.selectedIndex = 0;
      this.requestMarketplaceIfNeeded();
      return;
    }
    if (matchesKey(data, Key.shift("tab"))) {
      this.activeTabIndex =
        (this.activeTabIndex - 1 + PLUGINS_PANEL_TABS.length) %
        PLUGINS_PANEL_TABS.length;
      this.selectedIndex = 0;
      this.requestMarketplaceIfNeeded();
      return;
    }
    switch (this.activeTab.id) {
      case "installed":
        this.handleInstalledInput(data);
        return;
      case "official":
      case "third-party":
        this.handleMarketplaceInput(data);
        return;
      case "custom":
        this.customInput.handleInput(data);
        return;
    }
  }

  private handleInstalledInput(data: string): void {
    const plugins = this.opts.installed;
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(plugins.length - 1, this.selectedIndex + 1);
      return;
    }
    const plugin = plugins[this.selectedIndex];
    const ch = printableChar(data);
    // Decode Space for terminals that send printable keys via Kitty/CSI-u
    // sequences (e.g. VS Code's integrated terminal); `matchesKey(Key.space)`
    // alone misses those and the toggle silently stops working.
    if (matchesKey(data, Key.space) || ch === " ") {
      if (plugin !== undefined) {
        this.opts.onSelect({
          kind: "toggle",
          id: plugin.id,
          enabled: !plugin.enabled,
        });
      }
      return;
    }
    if (ch === "d" || ch === "D") {
      if (plugin !== undefined)
        this.opts.onSelect({ kind: "remove", id: plugin.id });
      return;
    }
    if (ch === "m" || ch === "M") {
      if (plugin !== undefined)
        this.opts.onSelect({ kind: "mcp", id: plugin.id });
      return;
    }
    if (ch === "r" || ch === "R") {
      this.opts.onSelect({ kind: "reload" });
      return;
    }
    if (matchesKey(data, Key.enter)) {
      if (plugin === undefined) return;
      const capability = this.capabilityFor(plugin.id);
      if (capability !== undefined && capabilityNeedsSetup(capability)) {
        this.opts.onSelect({
          kind: "install",
          entry: capabilityMarketplaceEntry(capability),
        });
        return;
      }
      const update = this.installedUpdateStatus(plugin);
      if (update !== undefined) {
        this.opts.onSelect({ kind: "install", entry: update.entry });
      } else {
        this.opts.onSelect({ kind: "details", id: plugin.id });
      }
      return;
    }
    if (ch === "i" || ch === "I") {
      if (plugin !== undefined)
        this.opts.onSelect({ kind: "details", id: plugin.id });
    }
  }

  private handleMarketplaceInput(data: string): void {
    const entries =
      this.activeTab.id === "official"
        ? this.officialEntries
        : this.thirdPartyEntries;
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      // Clamp to 0 while the catalog is still loading (entries empty); otherwise
      // `entries.length - 1` is -1 and a later Enter reads `entries[-1]`.
      this.selectedIndex =
        entries.length === 0
          ? 0
          : Math.min(entries.length - 1, this.selectedIndex + 1);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const entry = entries[this.selectedIndex];
      if (entry === undefined) return;
      if (isPinnedWebBridgeEntry(entry)) {
        this.opts.onSelect({
          kind: "open-url",
          url: WEB_BRIDGE_URL,
          label: entry.displayName,
        });
        return;
      }
      this.opts.onSelect({ kind: "install", entry });
    }
  }

  override invalidate(): void {
    super.invalidate();
    this.customInput.invalidate();
  }

  override render(width: number): string[] {
    if (this.installing !== undefined) {
      return this.renderInstalling(width);
    }
    const colors = currentTheme.palette;
    const tab = this.activeTab.id;
    const hint =
      tab === "installed"
        ? this.installedHint()
        : tab === "custom"
          ? " Tab switch · Enter install · Esc cancel"
          : " Tab switch · ↑↓ navigate · Enter open/install · Esc cancel";
    const lines: string[] = [
      chalk.hex(colors.primary)("─".repeat(width)),
      chalk.hex(colors.primary).bold(" Plugins"),
      mutedHintLine(hint, colors),
      "",
      renderTabStrip({
        labels: PLUGINS_PANEL_TABS.map((t) => t.label),
        activeIndex: this.activeTabIndex,
        width,
        colors,
      }),
      "",
    ];

    if (tab === "installed") this.renderInstalled(lines, width);
    else if (tab === "official") this.renderOfficial(lines, width);
    else if (tab === "third-party") this.renderThirdParty(lines, width);
    else this.renderCustom(lines, width);

    lines.push(chalk.hex(colors.primary)("─".repeat(width)));
    return lines.map((line) => truncateToWidth(line, width, ELLIPSIS));
  }

  private renderInstalled(lines: string[], width: number): void {
    const { installed } = this.opts;
    const colors = currentTheme.palette;
    if (installed.length === 0) {
      lines.push(chalk.hex(colors.textMuted)("  No plugins installed."));
    } else {
      for (let i = 0; i < installed.length; i++) {
        lines.push(...this.renderInstalledRow(installed[i]!, i, width));
      }
    }
    lines.push("");
    lines.push(mutedHintLine(` ${installed.length} installed`, colors));
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

  private renderInstalledRow(
    plugin: PluginSummary,
    index: number,
    width: number,
  ): string[] {
    const colors = currentTheme.palette;
    const selected = index === this.selectedIndex;
    const pointer = selected ? SELECT_POINTER : " ";
    const labelStyle = selected
      ? chalk.hex(colors.primary).bold
      : chalk.hex(colors.text);
    const prefix = chalk.hex(selected ? colors.primary : colors.textDim)(
      `  ${pointer} `,
    );
    const status = pluginStatus(plugin);
    const update = this.installedUpdateStatus(plugin);
    const capability = this.capabilityFor(plugin.id);
    let line = prefix + labelStyle(plugin.displayName);
    if (status !== undefined) {
      line +=
        "  " +
        statusStyle(
          { kind: "plugin", value: "", label: "", description: "", status },
          colors,
        )(status);
    }
    if (update !== undefined) {
      const badge = `update ${update.local} → ${update.latest}`;
      line += "  " + marketplaceStatusStyle(badge, colors)(badge);
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
        // Unsupported is a fact, not a problem: dim it; actionable setup
        // states keep the warning tone.
        line +=
          "  " +
          (badge === "unsupported"
            ? chalk.hex(colors.textDim)(badge)
            : chalk.hex(colors.warning)(badge));
      }
    }
    if (this.opts.pluginHint?.id === plugin.id) {
      line += "  " + chalk.hex(colors.warning)(this.opts.pluginHint.text);
    }
    const descWidth = Math.max(1, width - 4);
    const out = [line];
    const capabilityIssues =
      capability === undefined ? "" : describeCapabilityIssues(capability);
    const description =
      capabilityIssues.length === 0
        ? overviewPluginDescription(plugin)
        : `${overviewPluginDescription(plugin)} · ${capabilityIssues}`;
    for (const descLine of wrapOverviewDescription(description, descWidth)) {
      out.push(mutedHintLine(`    ${descLine}`, colors));
    }
    return out;
  }

  private renderMarketplaceTab(
    lines: string[],
    width: number,
    entries: readonly PluginMarketplaceEntry[],
    indexOffset = 0,
    // Counts (installed/available footer) are computed over this list:
    // the Official tab renders the pinned promo as a row but excludes it
    // from the catalog counts, matching its pre-catalog semantics.
    entriesForCount: readonly PluginMarketplaceEntry[] = entries,
  ): void {
    const colors = currentTheme.palette;
    if (this.market.status === "loading" || this.market.status === "idle") {
      lines.push(chalk.hex(colors.textMuted)("  Loading marketplace…"));
      return;
    }
    if (this.market.status === "error") {
      lines.push(
        chalk.hex(colors.warning)(
          `  Marketplace unavailable: ${this.market.message}`,
        ),
      );
      lines.push(
        mutedHintLine("  Use the Custom tab to install from a URL.", colors),
      );
      return;
    }
    if (entries.length === 0) {
      lines.push(chalk.hex(colors.textMuted)("  No plugins found."));
    } else {
      for (let i = 0; i < entries.length; i++) {
        lines.push(
          ...this.renderMarketplaceRow(entries[i]!, i + indexOffset, width),
        );
      }
    }
    const installedCount = entriesForCount.filter((e) =>
      this.opts.installedIds.has(e.id),
    ).length;
    lines.push("");
    lines.push(
      mutedHintLine(
        ` ${installedCount} installed · ${entriesForCount.length - installedCount} available`,
        colors,
      ),
    );
    lines.push(mutedHintLine(` Source: ${this.market.source}`, colors));
  }

  private renderOfficial(lines: string[], width: number): void {
    // Loading / error: `officialEntries` carries the locally-known
    // capability rows (plus the promo fallback when webbridge is not among
    // them), so built-in setup works before the catalog arrives. Once
    // loaded, the promo appears only when the catalog lacks the real entry.
    if (this.market.status !== "loaded") {
      const entries = this.officialEntries;
      for (let i = 0; i < entries.length; i += 1) {
        lines.push(...this.renderMarketplaceRow(entries[i]!, i, width));
      }
      this.renderMarketplaceTab(lines, width, [], entries.length);
      return;
    }
    this.renderMarketplaceTab(
      lines,
      width,
      this.officialEntries,
      0,
      this.officialCatalogEntries,
    );
  }

  private renderThirdParty(lines: string[], width: number): void {
    this.renderMarketplaceTab(lines, width, this.thirdPartyEntries);
  }

  private renderMarketplaceRow(
    entry: PluginMarketplaceEntry,
    index: number,
    width: number,
  ): string[] {
    const colors = currentTheme.palette;
    const selected = index === this.selectedIndex;
    const pointer = selected ? SELECT_POINTER : " ";
    const labelStyle = selected
      ? chalk.hex(colors.primary).bold
      : chalk.hex(colors.text);
    const prefix = chalk.hex(selected ? colors.primary : colors.textDim)(
      `  ${pointer} `,
    );
    const capability = this.capabilityForEntry(entry);
    const status = isPinnedWebBridgeEntry(entry)
      ? "open in browser"
      : capability === undefined
        ? marketplaceEntryStatus(entry, this.installedVersions)
        : capabilityRowStatus(capability, entry);
    const line =
      prefix +
      labelStyle(entry.displayName) +
      "  " +
      marketplaceStatusStyle(status, colors)(status);
    const descWidth = Math.max(1, width - 4);
    const out = [line];
    const capabilityIssues =
      capability === undefined ? "" : describeCapabilityIssues(capability);
    const description =
      capabilityIssues.length === 0
        ? marketplaceEntryDescription(entry)
        : `${marketplaceEntryDescription(entry)} · ${capabilityIssues}`;
    for (const descLine of wrapOverviewDescription(description, descWidth)) {
      out.push(mutedHintLine(`    ${descLine}`, colors));
    }
    return out;
  }

  private renderCustom(lines: string[], width: number): void {
    const colors = currentTheme.palette;
    lines.push(
      mutedHintLine(
        " Install from a GitHub URL (or zip URL / local path):",
        colors,
      ),
    );
    lines.push("");
    lines.push(
      ...renderUrlInputBox(this.customInput, this.focused, width, colors),
    );
  }

  private renderInstalling(width: number): string[] {
    const colors = currentTheme.palette;
    const lines = [
      chalk.hex(colors.primary)("─".repeat(width)),
      chalk.hex(colors.primary).bold(" Plugins"),
      "",
      chalk.hex(colors.textMuted)(
        `  Installing ${this.installing} from marketplace…`,
      ),
      "",
      chalk.hex(colors.primary)("─".repeat(width)),
    ];
    return lines.map((line) => truncateToWidth(line, width, ELLIPSIS));
  }
}

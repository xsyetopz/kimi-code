import { Key, matchesKey } from "@moonshot-ai/kimi-tui";

import {
  type PluginsPanelOptions,
  type PluginsPanelSelection,
  type PluginsPanelStateSnapshot,
} from "#/tui/components/dialogs/plugins-selector";
import { printableChar } from "#/tui/utils/printable-key";
import type { PluginMarketplaceEntry } from "#/utils/plugin-marketplace";

import {
  pluginsPanelCapabilityFor,
  pluginsPanelInstalledUpdateStatus,
  pluginsPanelMarketplaceEntries,
  pluginsPanelOfficialEntries,
  pluginsPanelThirdPartyEntries,
} from "./plugins-panel-entries";
import {
  capabilityMarketplaceEntry,
  capabilityNeedsSetup,
  isPinnedWebBridgeEntry,
} from "./plugins-panel-format";
import {
  projectPluginsPanelInstalled,
  projectPluginsPanelOfficial,
  projectPluginsPanelThirdParty,
  type PluginsPanelProjectionState,
} from "./plugins-panel-project";
import {
  PLUGINS_PANEL_TABS,
  WEB_BRIDGE_URL,
  type InkPluginsPanelView,
  type PluginsPanelMarketState,
} from "./plugins-panel-types";

export type {
  InkPluginsPanelRowStatusTone,
  InkPluginsPanelRowView,
  InkPluginsPanelView,
} from "./plugins-panel-types";

export class InkPluginsPanelSession {
  private readonly opts: PluginsPanelOptions;
  private activeTabIndex: number;
  private selectedIndex = 0;
  private market: PluginsPanelMarketState = { status: "idle" };
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
    const projection = this.projectionState();
    const marketplaceEntries = pluginsPanelMarketplaceEntries(
      this.market,
      this.opts.installedIds,
    );
    let rows: InkPluginsPanelView["rows"] = [];
    let footerLines: string[] = [];

    if (tab === "installed") {
      ({ rows, footerLines } = projectPluginsPanelInstalled(
        projection,
        descriptionWidth,
      ));
    } else if (tab === "official") {
      ({ rows, footerLines } = projectPluginsPanelOfficial(
        projection,
        marketplaceEntries,
        descriptionWidth,
      ));
    } else if (tab === "third-party") {
      ({ rows, footerLines } = projectPluginsPanelThirdParty(
        projection,
        marketplaceEntries,
        descriptionWidth,
      ));
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

  private projectionState(): PluginsPanelProjectionState {
    return {
      opts: this.opts,
      market: this.market,
      selectedIndex: this.selectedIndex,
    };
  }

  private notifyChange(): void {
    this.onStateChange?.();
  }

  private get activeTab(): (typeof PLUGINS_PANEL_TABS)[number] {
    return PLUGINS_PANEL_TABS[this.activeTabIndex]!;
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
      const capability = pluginsPanelCapabilityFor(
        this.opts.capabilities,
        plugin.id,
      );
      if (capability !== undefined && capabilityNeedsSetup(capability)) {
        onSelect({
          kind: "install",
          entry: capabilityMarketplaceEntry(capability),
        });
        return;
      }
      const update = pluginsPanelInstalledUpdateStatus(this.market, plugin);
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
    const marketplaceEntries = pluginsPanelMarketplaceEntries(
      this.market,
      this.opts.installedIds,
    );
    const entries =
      this.activeTab.id === "official"
        ? pluginsPanelOfficialEntries(
            this.market,
            this.opts,
            marketplaceEntries,
          )
        : pluginsPanelThirdPartyEntries(marketplaceEntries);
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
      plugin === undefined
        ? undefined
        : pluginsPanelCapabilityFor(this.opts.capabilities, plugin.id);
    const needsSetup =
      capability !== undefined && capabilityNeedsSetup(capability);
    const hasUpdate =
      plugin !== undefined &&
      pluginsPanelInstalledUpdateStatus(this.market, plugin) !== undefined;
    const enter = needsSetup
      ? "Enter finish setup"
      : hasUpdate
        ? "Enter update"
        : "Enter details";
    return ` Tab switch · Space toggle · D remove · M MCP · ${enter} · I details · R reload · Esc cancel`;
  }
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

import type { PluginMarketplaceEntry } from "#/utils/plugin-marketplace";
import type { PluginsPanelTabId } from "#/tui/components/dialogs/plugins-selector";

export const PLUGINS_PANEL_ELLIPSIS = "…";

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

export const PLUGINS_PANEL_TABS: readonly {
  id: PluginsPanelTabId;
  label: string;
}[] = [
  { id: "installed", label: "Installed" },
  { id: "official", label: "Official" },
  { id: "third-party", label: "Third-party" },
  { id: "custom", label: "Custom" },
];

export type PluginsPanelMarketState =
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
  readonly tabs: readonly {
    readonly label: string;
    readonly active: boolean;
  }[];
  readonly mode: "installing" | "list" | "custom";
  readonly rows: readonly InkPluginsPanelRowView[];
  readonly footerLines: readonly string[];
  readonly customPrompt: string | undefined;
  readonly customInput: string | undefined;
  readonly installingLabel: string | undefined;
}

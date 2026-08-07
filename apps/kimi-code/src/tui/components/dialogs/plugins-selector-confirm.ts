import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  type Focusable,
} from "@moonshot-ai/kimi-tui";
import type { PluginInfo } from "@moonshot-ai/kimi-code-sdk";
import chalk from "chalk";

import { SELECT_POINTER } from "#/tui/constant/symbols";
import { currentTheme } from "#/tui/theme";
import { printableChar } from "#/tui/utils/printable-key";

import { ChoicePickerComponent } from "./choice-picker";
import {
  buildMcpItems,
  ELLIPSIS,
  MCP_SERVER_PREFIX,
  mcpItemServerName,
  mutedHintLine,
  sectionLabel,
  statusStyle,
  wrapOverviewDescription,
  type PluginsOverviewItem,
} from "./plugins-selector-helpers";

const REMOVE_CONFIRM_CANCEL = "cancel";
const REMOVE_CONFIRM_REMOVE = "remove";
const INSTALL_TRUST_EXIT = "exit";
const INSTALL_TRUST_TRUST = "trust";

export type PluginMcpSelection =
  | {
      readonly kind: "toggle";
      readonly pluginId: string;
      readonly server: string;
      readonly enabled: boolean;
    }
  | { readonly kind: "back"; readonly pluginId: string };

export interface PluginMcpSelectorOptions {
  readonly info: PluginInfo;
  readonly selectedServer?: string;
  readonly serverHint?: {
    readonly server: string;
    readonly text: string;
  };
  readonly onSelect: (selection: PluginMcpSelection) => void;
  readonly onCancel: () => void;
}

export class PluginMcpSelectorComponent extends Container implements Focusable {
  focused = false;

  private readonly opts: PluginMcpSelectorOptions;
  private readonly items: readonly PluginsOverviewItem[];
  private selectedIndex = 0;

  constructor(opts: PluginMcpSelectorOptions) {
    super();
    this.opts = opts;
    this.items = buildMcpItems(opts.info);
    const selectedIndex = this.items.findIndex(
      (item) => item.value === `${MCP_SERVER_PREFIX}${opts.selectedServer}`,
    );
    this.selectedIndex = Math.max(0, selectedIndex);
  }

  getPluginMcpSelectorOptions(): PluginMcpSelectorOptions {
    return this.opts;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(
        this.items.length - 1,
        this.selectedIndex + 1,
      );
      return;
    }
    if (
      matchesKey(data, Key.enter) ||
      matchesKey(data, Key.space) ||
      printableChar(data) === " "
    ) {
      const chosen = this.items[this.selectedIndex];
      if (chosen === undefined) return;
      if (chosen.value === "back") {
        this.opts.onSelect({ kind: "back", pluginId: this.opts.info.id });
        return;
      }
      const serverName = mcpItemServerName(chosen);
      if (serverName === undefined) return;
      const server = this.opts.info.mcpServers.find(
        (item) => item.name === serverName,
      );
      if (server === undefined) return;
      this.opts.onSelect({
        kind: "toggle",
        pluginId: this.opts.info.id,
        server: server.name,
        enabled: !server.enabled,
      });
    }
  }

  override render(width: number): string[] {
    const { info } = this.opts;
    const colors = currentTheme.palette;
    const serverItems = this.items.filter((item) => item.kind === "plugin");
    const actionItems = this.items.filter((item) => item.kind === "action");
    const lines: string[] = [
      chalk.hex(colors.primary)("─".repeat(width)),
      chalk.hex(colors.primary).bold(` MCP servers · ${info.displayName}`),
      mutedHintLine(
        " ↑↓ navigate · Enter/Space enable/disable · Esc cancel",
        colors,
      ),
      "",
      sectionLabel(
        `MCP servers (${info.enabledMcpServerCount}/${info.mcpServerCount} enabled)`,
        colors,
      ),
    ];

    if (serverItems.length === 0) {
      lines.push(chalk.hex(colors.textMuted)("  No MCP servers declared."));
    } else {
      for (let i = 0; i < serverItems.length; i++) {
        lines.push(...this.renderItem(serverItems[i]!, i, width));
      }
    }

    lines.push("");
    lines.push(sectionLabel("Actions", colors));
    for (let i = 0; i < actionItems.length; i++) {
      lines.push(
        ...this.renderItem(actionItems[i]!, serverItems.length + i, width),
      );
    }

    lines.push("");
    lines.push(chalk.hex(colors.primary)("─".repeat(width)));
    return lines.map((line) => truncateToWidth(line, width, ELLIPSIS));
  }

  private renderItem(
    item: PluginsOverviewItem,
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
    let line = prefix + labelStyle(item.label);
    if (item.status !== undefined) {
      line += "  " + statusStyle(item, colors)(item.status);
    }
    const serverName = mcpItemServerName(item);
    if (
      serverName !== undefined &&
      this.opts.serverHint?.server === serverName
    ) {
      line += "  " + chalk.hex(colors.warning)(this.opts.serverHint.text);
    }
    const descriptionWidth = Math.max(1, width - 4);
    const lines = [line];
    for (const descLine of wrapOverviewDescription(
      item.description,
      descriptionWidth,
    )) {
      lines.push(mutedHintLine(`    ${descLine}`, colors));
    }
    return lines;
  }
}

export type PluginRemoveConfirmResult =
  | { readonly kind: "confirm" }
  | { readonly kind: "cancel" };

export interface PluginRemoveConfirmOptions {
  readonly id: string;
  readonly displayName: string;
  readonly onDone: (result: PluginRemoveConfirmResult) => void;
}

export class PluginRemoveConfirmComponent extends ChoicePickerComponent {
  constructor(opts: PluginRemoveConfirmOptions) {
    super({
      title: `Remove ${opts.displayName} (${opts.id})?`,
      hint: "↑↓ navigate · Enter/Space select · ←/Esc cancel",
      formatHint: mutedHintLine,
      options: [
        {
          value: REMOVE_CONFIRM_CANCEL,
          label: "Cancel",
          description: "Keep this plugin installed.",
        },
        {
          value: REMOVE_CONFIRM_REMOVE,
          label: "Remove plugin",
          tone: "danger",
          description:
            "Remove only the install record; plugin files are left in place.",
        },
      ],
      onSelect: (value) => {
        opts.onDone(
          value === REMOVE_CONFIRM_REMOVE
            ? { kind: "confirm" }
            : { kind: "cancel" },
        );
      },
      onCancel: () => {
        opts.onDone({ kind: "cancel" });
      },
    });
  }
}

export type PluginInstallTrustConfirmResult =
  | { readonly kind: "confirm" }
  | { readonly kind: "cancel" };

export interface PluginInstallTrustConfirmOptions {
  /** Plugin display name or source, shown in the title for identification. */
  readonly label: string;
  readonly onDone: (result: PluginInstallTrustConfirmResult) => void;
}

/**
 * Confirmation shown before installing a third-party (unofficial) plugin.
 * Defaults to "Exit" so the user must explicitly switch to "Trust and install"
 * to proceed with a plugin that Kimi has not reviewed.
 */
export class PluginInstallTrustConfirmComponent extends ChoicePickerComponent {
  constructor(opts: PluginInstallTrustConfirmOptions) {
    super({
      title: `Install third-party plugin ${opts.label}?`,
      hint: "↑↓ navigate · Enter/Space select · ←/Esc cancel",
      formatHint: mutedHintLine,
      notice:
        "⚠️ This is a third-party plugin that Kimi has not reviewed. It can bundle MCP servers, " +
        "skills, or files that run code and access your workspace. Install it only if you " +
        "trust the source.",
      noticeTone: "warning",
      options: [
        {
          value: INSTALL_TRUST_EXIT,
          label: "Exit",
          description: "Cancel the installation.",
        },
        {
          value: INSTALL_TRUST_TRUST,
          label: "Trust and install",
          tone: "danger",
          description: "Install this third-party plugin anyway.",
        },
      ],
      onSelect: (value) => {
        opts.onDone(
          value === INSTALL_TRUST_TRUST
            ? { kind: "confirm" }
            : { kind: "cancel" },
        );
      },
      onCancel: () => {
        opts.onDone({ kind: "cancel" });
      },
    });
  }
}

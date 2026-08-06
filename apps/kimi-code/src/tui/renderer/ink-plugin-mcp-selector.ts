import { Key, matchesKey } from "@moonshot-ai/kimi-tui";

import type {
  PluginInfo,
  PluginMcpSelectorOptions,
  PluginMcpSelection,
} from "#/tui/components/dialogs/plugins-selector";
import { printableChar } from "#/tui/utils/printable-key";

const MCP_SERVER_PREFIX = "mcp:";

interface PluginMcpItemView {
  readonly value: string;
  readonly kind: "plugin" | "action";
  readonly label: string;
  readonly status: string | undefined;
  readonly description: string;
}

export interface InkPluginMcpSelectorRowView {
  readonly value: string;
  readonly kind: "plugin" | "action";
  readonly label: string;
  readonly status: string | undefined;
  readonly description: string;
  readonly selected: boolean;
  readonly hint: string | undefined;
}

export interface InkPluginMcpSelectorView {
  readonly title: string;
  readonly hint: string;
  readonly serverHeader: string;
  readonly actionHeader: string;
  readonly rows: readonly InkPluginMcpSelectorRowView[];
}

export class InkPluginMcpSelectorSession {
  private readonly opts: PluginMcpSelectorOptions;
  private readonly items: readonly PluginMcpItemView[];
  private selectedIndex = 0;

  constructor(opts: PluginMcpSelectorOptions) {
    this.opts = opts;
    this.items = buildMcpItems(opts.info);
    const selectedIndex = this.items.findIndex(
      (item) => item.value === `${MCP_SERVER_PREFIX}${opts.selectedServer}`,
    );
    this.selectedIndex = Math.max(0, selectedIndex);
  }

  handleInput(
    data: string,
    callbacks: {
      readonly onSelect: (selection: PluginMcpSelection) => void;
      readonly onCancel: () => void;
    },
  ): boolean {
    if (matchesKey(data, Key.escape)) {
      callbacks.onCancel();
      return true;
    }
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return true;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(
        this.items.length - 1,
        this.selectedIndex + 1,
      );
      return true;
    }
    if (
      matchesKey(data, Key.enter) ||
      matchesKey(data, Key.space) ||
      printableChar(data) === " "
    ) {
      const chosen = this.items[this.selectedIndex];
      if (chosen === undefined) return true;
      if (chosen.value === "back") {
        callbacks.onSelect({ kind: "back", pluginId: this.opts.info.id });
        return true;
      }
      const serverName = mcpItemServerName(chosen);
      if (serverName === undefined) return true;
      const server = this.opts.info.mcpServers.find(
        (item) => item.name === serverName,
      );
      if (server === undefined) return true;
      callbacks.onSelect({
        kind: "toggle",
        pluginId: this.opts.info.id,
        server: server.name,
        enabled: !server.enabled,
      });
      return true;
    }
    return true;
  }

  projectView(): InkPluginMcpSelectorView {
    const { info } = this.opts;
    const rows = this.items.map((item, index) => {
      const serverName = mcpItemServerName(item);
      const hint =
        serverName !== undefined &&
        this.opts.serverHint?.server === serverName
          ? this.opts.serverHint.text
          : undefined;
      return {
        value: item.value,
        kind: item.kind,
        label: item.label,
        status: item.status,
        description: item.description,
        selected: index === this.selectedIndex,
        hint,
      };
    });

    return {
      title: `MCP servers · ${info.displayName}`,
      hint: "↑↓ navigate · Enter/Space enable/disable · Esc cancel",
      serverHeader: `MCP servers (${info.enabledMcpServerCount}/${info.mcpServerCount} enabled)`,
      actionHeader: "Actions",
      rows,
    };
  }
}

function buildMcpItems(info: PluginInfo): readonly PluginMcpItemView[] {
  const items: PluginMcpItemView[] = info.mcpServers.map((server) => ({
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
    status: undefined,
    description: "Return to the local plugin manager.",
  });
  return items;
}

function mcpServerDescription(
  server: PluginInfo["mcpServers"][number],
): string {
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

function mcpItemServerName(item: PluginMcpItemView): string | undefined {
  if (!item.value.startsWith(MCP_SERVER_PREFIX)) return undefined;
  return item.value.slice(MCP_SERVER_PREFIX.length);
}

export function createInkPluginMcpSelectorSession(
  opts: PluginMcpSelectorOptions,
): InkPluginMcpSelectorSession {
  return new InkPluginMcpSelectorSession(opts);
}

export function projectInkPluginMcpSelectorView(
  session: InkPluginMcpSelectorSession,
): InkPluginMcpSelectorView {
  return session.projectView();
}

import { describe, expect, it, vi } from "vitest";

import {
  PluginMcpSelectorComponent,
  type PluginInfo,
} from "#/tui/components/dialogs/plugins-selector";
import { KimiTUI, type KimiTUIStartupInput } from "#/tui/kimi-tui";
import {
  createInkPluginMcpSelectorSession,
  projectInkPluginMcpSelectorView,
} from "#/tui/renderer/ink/sessions/plugin-mcp-selector";

function pluginInfo(overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    id: "kimi-datasource",
    displayName: "Kimi Datasource",
    version: "1.0.0",
    enabled: true,
    state: "ok",
    skillCount: 1,
    mcpServerCount: 2,
    enabledMcpServerCount: 2,
    hookCount: 0,
    commandCount: 0,
    hasErrors: false,
    source: "local-path",
    installedAt: "2026-05-29T00:00:00.000Z",
    root: "/plugins/kimi-datasource",
    manifest: undefined,
    mcpServers: [
      {
        name: "metadata",
        runtimeName: "plugin-kimi-datasource-metadata",
        enabled: true,
        transport: "stdio",
        command: "node",
        args: ["./bin/kimi-datasource.mjs", "metadata"],
      },
      {
        name: "data",
        runtimeName: "plugin-kimi-datasource-data",
        enabled: true,
        transport: "stdio",
        command: "node",
        args: ["./bin/kimi-datasource.mjs", "data"],
      },
    ],
    diagnostics: [],
    ...overrides,
  };
}

function makeTui() {
  const input: KimiTUIStartupInput = {
    cliOptions: {
      session: undefined,
      continue: false,
      yolo: false,
      auto: false,
      plan: false,
      model: undefined,
      outputFormat: undefined,
      prompt: undefined,
      skillsDirs: [],
      agent: undefined,
      agentFiles: [],
    },
    tuiConfig: {
      theme: "dark",
      disablePasteBurst: false,
      editorCommand: null,
      notifications: { enabled: true, condition: "unfocused" },
      upgrade: { autoInstall: true },
      statusLine: { items: null, command: null },
    },
    version: "test",
    workDir: "/tmp/kimi-test",
  };
  return new KimiTUI({ track: vi.fn() } as never, input);
}

describe("ink plugin mcp selector", () => {
  it("toggles MCP servers with Space", () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const session = createInkPluginMcpSelectorSession({
      info: pluginInfo(),
      onSelect,
      onCancel,
    });

    expect(projectInkPluginMcpSelectorView(session).title).toBe(
      "MCP servers · Kimi Datasource",
    );
    expect(session.handleInput("\u001B[B", { onSelect, onCancel })).toBe(true);
    expect(onSelect).not.toHaveBeenCalled();

    expect(session.handleInput(" ", { onSelect, onCancel })).toBe(true);
    expect(onSelect).toHaveBeenCalledWith({
      kind: "toggle",
      pluginId: "kimi-datasource",
      server: "data",
      enabled: false,
    });
  });

  it("returns to the plugin list with back", () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const session = createInkPluginMcpSelectorSession({
      info: pluginInfo(),
      onSelect,
      onCancel,
    });

    expect(session.handleInput("\u001B[B", { onSelect, onCancel })).toBe(true);
    expect(session.handleInput("\u001B[B", { onSelect, onCancel })).toBe(true);
    expect(session.handleInput("\r", { onSelect, onCancel })).toBe(true);
    expect(onSelect).toHaveBeenCalledWith({
      kind: "back",
      pluginId: "kimi-datasource",
    });
  });

  it("routes PluginMcpSelectorComponent mounts to Ink without legacy panel", () => {
    const tui = makeTui();
    const onSelect = vi.fn();
    const onCancel = vi.fn();

    tui.mountEditorReplacement(
      new PluginMcpSelectorComponent({
        info: pluginInfo(),
        onSelect,
        onCancel,
      }),
    );

    expect(tui.state.activeDialog).toBe("plugin-mcp-selector");
    expect(tui.getTerminalViewState().dialog.pluginMcpSelector?.title).toBe(
      "MCP servers · Kimi Datasource",
    );
    expect(
      (
        tui as unknown as { handleInkSimpleDialogInput: (data: string) => boolean }
      ).handleInkSimpleDialogInput("\u001B"),
    ).toBe(true);
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

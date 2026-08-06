import type { PluginSummary } from "@moonshot-ai/kimi-code-sdk";
import { describe, expect, it, vi } from "vitest";

import {
  PluginsPanelComponent,
  type PluginsPanelSelection,
} from "#/tui/components/dialogs/plugins-selector";
import { KimiTUI, type KimiTUIStartupInput } from "#/tui/kimi-tui";
import {
  createInkPluginsPanelSession,
  projectInkPluginsPanelView,
} from "#/tui/renderer/ink/sessions/plugins-panel";

const demoPlugin: PluginSummary = {
  id: "demo",
  displayName: "Demo",
  version: "1.0.0",
  enabled: true,
  state: "ok",
  skillCount: 1,
  mcpServerCount: 0,
  enabledMcpServerCount: 0,
  hasErrors: false,
  source: "local-path",
};

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
    terminalRenderer: "ink",
  };
  return new KimiTUI({ track: vi.fn() } as never, input);
}

describe("ink plugins panel", () => {
  it("toggles installed plugins with Space", () => {
    const onSelect = vi.fn<(selection: PluginsPanelSelection) => void>();
    const onCancel = vi.fn();
    const session = createInkPluginsPanelSession({
      installed: [demoPlugin],
      installedIds: new Set(["demo"]),
      onSelect,
      onCancel,
    });

    expect(projectInkPluginsPanelView(session).rows[0]?.label).toBe("Demo");
    expect(session.handleInput(" ", { onSelect, onCancel })).toBe(true);
    expect(onSelect).toHaveBeenCalledWith({
      kind: "toggle",
      id: "demo",
      enabled: false,
    });
  });

  it("requests the marketplace when switching to Official", () => {
    const onRequestMarketplace = vi.fn();
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const session = createInkPluginsPanelSession({
      installed: [],
      installedIds: new Set<string>(),
      onSelect,
      onCancel,
      onRequestMarketplace,
    });

    expect(session.handleInput("\t", { onSelect, onCancel })).toBe(true);
    expect(onRequestMarketplace).toHaveBeenCalledOnce();
    expect(projectInkPluginsPanelView(session).tabs[1]?.active).toBe(true);
  });

  it("shows installing overlay state", () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const session = createInkPluginsPanelSession({
      installed: [],
      installedIds: new Set<string>(),
      onSelect,
      onCancel,
    });

    session.setInstalling("Kimi Datasource");
    expect(projectInkPluginsPanelView(session).mode).toBe("installing");
    expect(projectInkPluginsPanelView(session).installingLabel).toBe(
      "Kimi Datasource",
    );
    expect(session.handleInput("\r", { onSelect, onCancel })).toBe(true);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("routes PluginsPanelComponent mounts to Ink without legacy panel", () => {
    const tui = makeTui();
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const panel = new PluginsPanelComponent({
      installed: [demoPlugin],
      installedIds: new Set(["demo"]),
      onSelect,
      onCancel,
    });

    tui.mountEditorReplacement(panel);

    expect(tui.state.activeDialog).toBe("plugins-panel");
    expect(tui.getTerminalViewState().dialog.pluginsPanel?.rows[0]?.label).toBe(
      "Demo",
    );
    expect(
      (
        tui as unknown as { handleInkSimpleDialogInput: (data: string) => boolean }
      ).handleInkSimpleDialogInput("\u001B"),
    ).toBe(true);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("dual-syncs async updates from the legacy panel handle", () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const panel = new PluginsPanelComponent({
      installed: [],
      installedIds: new Set<string>(),
      onSelect,
      onCancel,
    });
    const session = createInkPluginsPanelSession({
      installed: [],
      installedIds: new Set<string>(),
      onSelect,
      onCancel,
    });
    panel.attachInkSession(session, () => {});

    panel.setMarketplace(
      [
        {
          id: "kimi-datasource",
          tier: "official",
          displayName: "Kimi Datasource",
          source: "https://example.test/d.zip",
        },
      ],
      "https://example.test/marketplace.json",
    );
    expect(session.exportState().market.status).toBe("loaded");

    panel.setInstalling("Demo");
    expect(session.exportState().installing).toBe("Demo");
    expect(projectInkPluginsPanelView(session).mode).toBe("installing");

    panel.clearInstalling();
    expect(session.exportState().installing).toBeUndefined();
  });
});

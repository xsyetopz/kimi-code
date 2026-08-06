import { describe, expect, it, vi } from "vitest";

import { EffortSelectorComponent } from "#/tui/components/dialogs/effort-selector";
import { KimiTUI, type KimiTUIStartupInput } from "#/tui/kimi-tui";
import {
  createInkEffortSelectorSession,
  projectInkEffortSelectorView,
} from "#/tui/renderer/ink-effort-selector";

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

describe("ink effort selector", () => {
  it("steps effort segments and commits on enter", () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const session = createInkEffortSelectorSession({
      efforts: ["low", "high", "max"],
      currentValue: "low",
      onSelect,
      onCancel,
    });

    expect(session.handleInput("\u001B[C", { onSelect, onCancel })).toBe(true);
    expect(projectInkEffortSelectorView(session).segments).toEqual([
      { effort: "low", label: "Low", active: false },
      { effort: "high", label: "High", active: true },
      { effort: "max", label: "Max", active: false },
    ]);
    expect(session.handleInput("\r", { onSelect, onCancel })).toBe(true);
    expect(onSelect).toHaveBeenCalledWith("high");
  });

  it("routes EffortSelectorComponent mounts to Ink without legacy panel", () => {
    const tui = makeTui();
    const onSelect = vi.fn();
    const onCancel = vi.fn();

    tui.mountEditorReplacement(
      new EffortSelectorComponent({
        efforts: ["low", "high"],
        currentValue: "low",
        onSelect,
        onCancel,
      }),
    );

    expect(tui.state.activeDialog).toBe("effort-selector");
    expect(tui.getTerminalViewState().dialog.effortSelector?.title).toBe(
      "Select thinking effort",
    );
    expect(
      (
        tui as unknown as { handleInkSimpleDialogInput: (data: string) => boolean }
      ).handleInkSimpleDialogInput("\r"),
    ).toBe(true);
    expect(onSelect).toHaveBeenCalledWith("low");
    expect(tui.state.activeDialog).toBeNull();
  });
});

import { describe, expect, it, vi } from "vitest";

import { UndoSelectorComponent } from "#/tui/components/dialogs/undo-selector";
import { KimiTUI, type KimiTUIStartupInput } from "#/tui/kimi-tui";
import {
  createInkUndoSelectorSession,
  projectInkUndoSelectorView,
} from "#/tui/renderer/ink/sessions/undo-selector";

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

describe("ink undo selector", () => {
  it("selects the latest undo choice on enter", () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const session = createInkUndoSelectorSession({
      choices: [
        { id: "1", count: 1, input: "first", label: "Undo 1 message" },
        { id: "2", count: 2, input: "second", label: "Undo 2 messages" },
      ],
      onSelect,
      onCancel,
    });

    expect(projectInkUndoSelectorView(session).rows.at(-1)?.isSelected).toBe(
      true,
    );
    expect(session.handleInput("\r", { onSelect, onCancel })).toBe(true);
    expect(onSelect).toHaveBeenCalledWith({
      id: "2",
      count: 2,
      input: "second",
      label: "Undo 2 messages",
    });
  });

  it("routes UndoSelectorComponent mounts to Ink without legacy panel", () => {
    const tui = makeTui();
    const onSelect = vi.fn();
    const onCancel = vi.fn();

    tui.mountEditorReplacement(
      new UndoSelectorComponent({
        choices: [{ id: "1", count: 1, input: "hi", label: "Undo 1 message" }],
        onSelect,
        onCancel,
      }),
    );

    expect(tui.state.activeDialog).toBe("undo-selector");
    expect(tui.getTerminalViewState().dialog.undoSelector?.title).toBe(
      "Select messages to undo",
    );
    expect(
      (
        tui as unknown as { handleInkSimpleDialogInput: (data: string) => boolean }
      ).handleInkSimpleDialogInput("\r"),
    ).toBe(true);
    expect(onSelect).toHaveBeenCalled();
    expect(tui.state.activeDialog).toBeNull();
  });
});

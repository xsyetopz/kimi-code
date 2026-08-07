import { describe, expect, it, vi } from "vitest";

import { ThemeSelectorComponent } from "#/tui/components/dialogs/theme-selector";
import { KimiTUI, type KimiTUIStartupInput } from "#/tui/kimi-tui";
import {
  createInkChoicePickerList,
  handleInkChoicePickerInput,
  projectInkChoicePickerView,
} from "#/tui/renderer/ink/sessions/choice-picker";

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

describe("ink choice picker", () => {
  it("filters searchable lists and submits the selected value", () => {
    const opts = {
      title: "Pick one",
      searchable: true,
      options: [
        { value: "alpha", label: "Alpha" },
        { value: "beta", label: "Beta" },
      ],
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    };
    const list = createInkChoicePickerList(opts);

    expect(handleInkChoicePickerInput(opts, list, "b", opts)).toBe(true);
    expect(projectInkChoicePickerView(opts, list).options).toEqual([
      expect.objectContaining({ value: "beta", label: "Beta" }),
    ]);

    expect(handleInkChoicePickerInput(opts, list, "\r", opts)).toBe(true);
    expect(opts.onSelect).toHaveBeenCalledWith("beta");
  });

  it("routes ChoicePickerComponent mounts to Ink without legacy editor replacement", () => {
    const tui = makeTui();
    const mountEditorReplacement = vi.spyOn(
      tui as unknown as { mountEditorReplacement: (panel: unknown) => void },
      "mountEditorReplacement",
    );
    const onSelect = vi.fn();
    const onCancel = vi.fn();

    tui.mountEditorReplacement(
      new ThemeSelectorComponent({
        currentValue: "dark",
        onSelect,
        onCancel,
      }),
    );

    expect(tui.state.activeDialog).toBe("choice-picker");
    expect(tui.getTerminalViewState().dialog.choicePicker?.title).toBe(
      "Select theme",
    );
    expect(mountEditorReplacement.mock.calls.at(-1)?.[0]).toBeInstanceOf(
      ThemeSelectorComponent,
    );
    expect(tui.state.editorContainer.children).not.toContainEqual(
      expect.any(ThemeSelectorComponent),
    );

    expect(
      (
        tui as unknown as { handleInkSimpleDialogInput: (data: string) => boolean }
      ).handleInkSimpleDialogInput("\u001b[B"),
    ).toBe(true);
    expect(
      (
        tui as unknown as { handleInkSimpleDialogInput: (data: string) => boolean }
      ).handleInkSimpleDialogInput("\r"),
    ).toBe(true);
    expect(onSelect).toHaveBeenCalled();
    expect(tui.state.activeDialog).toBeNull();
  });
});

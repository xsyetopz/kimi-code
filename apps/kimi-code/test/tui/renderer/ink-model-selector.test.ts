import { describe, expect, it, vi } from "vitest";

import { TabbedModelSelectorComponent } from "#/tui/components/dialogs/tabbed-model-selector";
import { KimiTUI, type KimiTUIStartupInput } from "#/tui/kimi-tui";
import {
  createInkTabbedModelSelectorSession,
  projectInkModelSelectorView,
} from "#/tui/renderer/ink/sessions/model-selector";

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

describe("ink model selector", () => {
  it("filters models and commits thinking effort on enter", () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const session = createInkTabbedModelSelectorSession({
      models: {
        k2: {
          provider: "managed:kimi-code",
          model: "kimi-k2",
          maxContextSize: 100,
          displayName: "Kimi K2",
          capabilities: ["thinking"],
        },
        turbo: {
          provider: "managed:kimi-code",
          model: "kimi-turbo",
          maxContextSize: 100,
          displayName: "Kimi Turbo",
          capabilities: ["thinking"],
        },
      },
      currentValue: "k2",
      currentThinkingEffort: "off",
      onSelect,
      onCancel,
    });

    expect(session.handleInput("t", { onSelect, onCancel })).toBe(true);
    expect(projectInkModelSelectorView(session).rows).toEqual([
      expect.objectContaining({ alias: "turbo", name: "Kimi Turbo" }),
    ]);
    expect(session.handleInput("\r", { onSelect, onCancel })).toBe(true);
    expect(onSelect).toHaveBeenCalledWith({
      alias: "turbo",
      thinking: "on",
    });
  });

  it("routes TabbedModelSelectorComponent mounts to Ink without legacy panel", () => {
    const tui = makeTui();
    const onSelect = vi.fn();
    const onCancel = vi.fn();

    tui.mountEditorReplacement(
      new TabbedModelSelectorComponent({
        models: {
          k2: {
            provider: "managed:kimi-code",
            model: "kimi-k2",
            maxContextSize: 100,
            displayName: "Kimi K2",
          },
        },
        currentValue: "k2",
        currentThinkingEffort: "off",
        onSelect,
        onCancel,
      }),
    );

    expect(tui.state.activeDialog).toBe("model-selector");
    expect(tui.getTerminalViewState().dialog.modelSelector?.title).toBe(
      "Select a model",
    );
    expect(
      (
        tui as unknown as {
          handleInkSimpleDialogInput: (data: string) => boolean;
        }
      ).handleInkSimpleDialogInput("\r"),
    ).toBe(true);
    expect(onSelect).toHaveBeenCalled();
    expect(tui.state.activeDialog).toBeNull();
  });
});

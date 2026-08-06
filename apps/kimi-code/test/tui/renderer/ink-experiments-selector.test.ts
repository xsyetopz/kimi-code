import type { ExperimentalFeatureState } from "@moonshot-ai/kimi-code-sdk";
import { describe, expect, it, vi } from "vitest";

import {
  ExperimentsSelectorComponent,
  type ExperimentalFeatureDraftChange,
} from "#/tui/components/dialogs/experiments-selector";
import { KimiTUI, type KimiTUIStartupInput } from "#/tui/kimi-tui";
import {
  createInkExperimentsSelectorSession,
  projectInkExperimentsSelectorView,
} from "#/tui/renderer/ink-experiments-selector";

function feature(
  overrides: Partial<ExperimentalFeatureState> = {},
): ExperimentalFeatureState {
  return {
    id: "micro_compaction",
    title: "Micro compaction",
    description: "Trim older tool results.",
    surface: "core",
    env: "KIMI_CODE_EXPERIMENTAL_MICRO_COMPACTION",
    defaultEnabled: true,
    enabled: true,
    source: "default",
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
    terminalRenderer: "ink",
  };
  return new KimiTUI({ track: vi.fn() } as never, input);
}

describe("ink experiments selector", () => {
  it("drafts changes with Space and applies them with Enter", () => {
    const onApply =
      vi.fn<(changes: readonly ExperimentalFeatureDraftChange[]) => void>();
    const onCancel = vi.fn();
    const session = createInkExperimentsSelectorSession({
      features: [feature()],
      onApply,
      onCancel,
    });

    expect(session.handleInput(" ", { onApply, onCancel })).toBe(true);
    expect(onApply).not.toHaveBeenCalled();
    expect(projectInkExperimentsSelectorView(session).rows[0]?.enabled).toBe(
      false,
    );
    expect(projectInkExperimentsSelectorView(session).applyEnabled).toBe(true);

    expect(session.handleInput("\r", { onApply, onCancel })).toBe(true);
    expect(onApply).toHaveBeenCalledWith([
      { id: "micro_compaction", enabled: false },
    ]);
  });

  it("clears search before cancelling on double Esc", () => {
    const onApply = vi.fn();
    const onCancel = vi.fn();
    const session = createInkExperimentsSelectorSession({
      features: [feature()],
      onApply,
      onCancel,
    });

    expect(session.handleInput("m", { onApply, onCancel })).toBe(true);
    expect(projectInkExperimentsSelectorView(session).query).toBe("m");
    expect(session.handleInput("\u001B", { onApply, onCancel })).toBe(true);
    expect(onCancel).not.toHaveBeenCalled();
    expect(session.handleInput("\u001B", { onApply, onCancel })).toBe(true);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("routes ExperimentsSelectorComponent mounts to Ink without legacy panel", () => {
    const tui = makeTui();
    const onApply = vi.fn();
    const onCancel = vi.fn();

    tui.mountEditorReplacement(
      new ExperimentsSelectorComponent({
        features: [feature()],
        onApply,
        onCancel,
      }),
    );

    expect(tui.state.activeDialog).toBe("experiments-selector");
    expect(tui.getTerminalViewState().dialog.experimentsSelector?.title).toBe(
      "Experimental features",
    );
    expect(
      (
        tui as unknown as { handleInkSimpleDialogInput: (data: string) => boolean }
      ).handleInkSimpleDialogInput(" "),
    ).toBe(true);
    expect(
      (
        tui as unknown as { handleInkSimpleDialogInput: (data: string) => boolean }
      ).handleInkSimpleDialogInput("\r"),
    ).toBe(true);
    expect(onApply).toHaveBeenCalledWith([
      { id: "micro_compaction", enabled: false },
    ]);
  });
});

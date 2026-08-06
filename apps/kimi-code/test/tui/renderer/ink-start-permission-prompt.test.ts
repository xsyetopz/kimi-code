import { describe, expect, it, vi } from "vitest";

import {
  GoalStartPermissionPromptComponent,
  GOAL_START_MANUAL_OPTIONS,
} from "#/tui/components/dialogs/goal-start-permission-prompt";
import { SwarmStartPermissionPromptComponent } from "#/tui/components/dialogs/swarm-start-permission-prompt";
import { KimiTUI, type KimiTUIStartupInput } from "#/tui/kimi-tui";
import {
  createInkStartPermissionPromptSession,
  projectInkStartPermissionPromptView,
} from "#/tui/renderer/ink/sessions/start-permission-prompt";

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

describe("ink start permission prompt", () => {
  it("selects an option with Enter", () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const session = createInkStartPermissionPromptSession({
      title: "Start a goal with approvals on?",
      noticeLines: ["Manual mode is not suitable for unattended goal work."],
      options: GOAL_START_MANUAL_OPTIONS,
      onSelect,
      onCancel,
    });

    expect(
      projectInkStartPermissionPromptView(session).options[0]?.selected,
    ).toBe(true);
    expect(session.handleInput("\u001B[B", { onSelect, onCancel })).toBe(true);
    expect(
      projectInkStartPermissionPromptView(session).options[1]?.selected,
    ).toBe(true);
    expect(session.handleInput("\r", { onSelect, onCancel })).toBe(true);
    expect(onSelect).toHaveBeenCalledWith("yolo");
  });

  it("routes goal and swarm permission prompts to Ink", () => {
    const tui = makeTui();
    const onSelect = vi.fn();
    const onCancel = vi.fn();

    tui.mountEditorReplacement(
      new GoalStartPermissionPromptComponent({
        mode: "manual",
        onSelect,
        onCancel,
      }),
    );
    expect(tui.state.activeDialog).toBe("start-permission-prompt");
    expect(
      tui.getTerminalViewState().dialog.startPermissionPrompt?.title,
    ).toBe("Start a goal with approvals on?");

    tui.restoreEditor();

    tui.mountEditorReplacement(
      new SwarmStartPermissionPromptComponent({
        onSelect,
        onCancel,
      }),
    );
    expect(tui.state.activeDialog).toBe("start-permission-prompt");
    expect(
      tui.getTerminalViewState().dialog.startPermissionPrompt?.title,
    ).toBe("Start a swarm task with approvals on?");
    expect(
      (
        tui as unknown as { handleInkSimpleDialogInput: (data: string) => boolean }
      ).handleInkSimpleDialogInput("\u001B"),
    ).toBe(true);
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

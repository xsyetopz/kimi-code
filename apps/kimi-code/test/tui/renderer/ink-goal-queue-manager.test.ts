import { describe, expect, it, vi } from "vitest";

import {
  GoalQueueEditDialogComponent,
  GoalQueueManagerComponent,
  type GoalQueueManagerAction,
} from "#/tui/components/dialogs/goal-queue-manager";
import type { UpcomingGoal } from "#/tui/goal-queue-store";
import { KimiTUI, type KimiTUIStartupInput } from "#/tui/kimi-tui";
import {
  createInkGoalQueueEditSession,
  projectInkGoalQueueEditView,
} from "#/tui/renderer/ink-goal-queue-edit";
import {
  createInkGoalQueueManagerSession,
  projectInkGoalQueueManagerView,
} from "#/tui/renderer/ink-goal-queue-manager";

const demoGoal: UpcomingGoal = {
  id: "g1",
  objective: "Ship feature X",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const demoGoal2: UpcomingGoal = {
  id: "g2",
  objective: "Write docs",
  createdAt: "2026-01-02T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
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

describe("ink goal queue manager", () => {
  it("enters move mode with Space and deletes with D", async () => {
    const onAction = vi.fn(async (action: GoalQueueManagerAction) => {
      if (action.kind === "delete") {
        return { goals: [] };
      }
    });
    const onCancel = vi.fn();
    const session = createInkGoalQueueManagerSession({
      goals: [demoGoal],
      onAction,
      onCancel,
    });

    expect(projectInkGoalQueueManagerView(session).rows[0]?.label).toContain(
      "Ship feature X",
    );
    expect(session.handleInput(" ", { onAction, onCancel })).toBe(true);
    expect(projectInkGoalQueueManagerView(session).rows[0]?.moving).toBe(true);
    expect(session.handleInput("d", { onAction, onCancel })).toBe(true);
    await vi.waitFor(() => {
      expect(onAction).toHaveBeenCalledWith({
        kind: "delete",
        goalId: "g1",
      });
    });
    expect(projectInkGoalQueueManagerView(session).empty).toBe(true);
  });

  it("routes GoalQueueManagerComponent mounts to Ink without legacy panel", () => {
    const tui = makeTui();
    const onAction = vi.fn();
    const onCancel = vi.fn();
    tui.mountEditorReplacement(
      new GoalQueueManagerComponent({
        goals: [demoGoal],
        onAction,
        onCancel,
      }),
    );

    expect(tui.state.activeDialog).toBe("goal-queue-manager");
    expect(
      tui.getTerminalViewState().dialog.goalQueueManager?.rows[0]?.label,
    ).toContain("Ship feature X");
    expect(tui.state.editorContainer.children).toHaveLength(0);
    expect(
      (
        tui as unknown as { handleInkSimpleDialogInput: (data: string) => boolean }
      ).handleInkSimpleDialogInput("\u001B"),
    ).toBe(true);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("dual-syncs async snapshot updates through attachInkSession", async () => {
    const onAction = vi.fn(async (action: GoalQueueManagerAction) => {
      if (action.kind === "move") {
        return { goals: [demoGoal2, demoGoal] };
      }
    });
    const onCancel = vi.fn();
    const panel = new GoalQueueManagerComponent({
      goals: [demoGoal, demoGoal2],
      onAction,
      onCancel,
    });
    const session = createInkGoalQueueManagerSession({
      goals: [demoGoal, demoGoal2],
      onAction,
      onCancel,
    });
    panel.attachInkSession(session, () => {});

    expect(session.handleInput(" ", { onAction, onCancel })).toBe(true);
    expect(session.handleInput("\u001B[B", { onAction, onCancel })).toBe(true);
    await vi.waitFor(() => {
      expect(onAction).toHaveBeenCalledWith({
        kind: "move",
        goalId: "g1",
        direction: "down",
      });
    });
    expect(projectInkGoalQueueManagerView(session).rows[0]?.label).toContain(
      "Write docs",
    );
    expect(panel.exportState().goals.map((goal) => goal.id)).toEqual([
      "g2",
      "g1",
    ]);
  });
});

describe("ink goal queue edit", () => {
  it("submits trimmed objective on Enter", () => {
    const onDone = vi.fn();
    const session = createInkGoalQueueEditSession({
      goal: demoGoal,
      onDone,
    });

    expect(projectInkGoalQueueEditView(session).title).toBe(
      "Edit upcoming goal",
    );
    expect(session.handleInput(" Updated objective", { onDone })).toBe(true);
    expect(session.handleInput("\r", { onDone })).toBe(true);
    expect(onDone).toHaveBeenCalledWith({
      kind: "save",
      goalId: "g1",
      objective: "Ship feature X Updated objective",
    });
  });

  it("routes GoalQueueEditDialogComponent mounts to Ink", () => {
    const tui = makeTui();
    const onDone = vi.fn();
    tui.mountEditorReplacement(
      new GoalQueueEditDialogComponent({
        goal: demoGoal,
        onDone,
      }),
    );

    expect(tui.state.activeDialog).toBe("goal-queue-edit");
    expect(tui.getTerminalViewState().dialog.goalQueueEdit?.title).toBe(
      "Edit upcoming goal",
    );
    expect(tui.state.editorContainer.children).toHaveLength(0);
  });
});

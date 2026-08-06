import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@moonshot-ai/kimi-tui";

import {
  MultilineGoalInput,
  type GoalQueueEditDialogOptions,
  type GoalQueueEditResult,
} from "#/tui/components/dialogs/goal-queue-manager";

const ELLIPSIS = "…";
const MAX_GOAL_OBJECTIVE_LENGTH = 4000;

export interface InkGoalQueueEditView {
  readonly title: string;
  readonly subtitle: string;
  readonly subtitleIsError: boolean;
  readonly inputLines: readonly string[];
  readonly footer: string;
}

export class InkGoalQueueEditSession {
  private readonly opts: GoalQueueEditDialogOptions;
  private readonly input = new MultilineGoalInput();
  private done = false;
  private error: string | undefined;

  constructor(opts: GoalQueueEditDialogOptions) {
    this.opts = opts;
    this.input.setValue(opts.goal.objective);
    this.input.onSubmit = (value) => {
      this.submit(value);
    };
  }

  handleInput(
    data: string,
    callbacks: {
      readonly onDone: (result: GoalQueueEditResult) => void;
    },
  ): boolean {
    if (this.done) return true;
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl("c")) ||
      matchesKey(data, Key.ctrl("d"))
    ) {
      this.done = true;
      callbacks.onDone({ kind: "cancel", goalId: this.opts.goal.id });
      return true;
    }
    this.error = undefined;
    this.input.handleInput(data);
    return true;
  }

  projectView(width = 120): InkGoalQueueEditView {
    const innerWidth = Math.max(1, width - 4);
    return {
      title: "Edit upcoming goal",
      subtitle:
        this.error ?? "Update the queued objective.",
      subtitleIsError: this.error !== undefined,
      inputLines: this.input.render(innerWidth),
      footer: truncateToWidth(
        "Enter submit · Shift-Enter/Ctrl-J newline · Esc cancel",
        innerWidth,
        ELLIPSIS,
      ),
    };
  }

  private submit(value: string): void {
    const objective = value.trim();
    if (objective.length === 0) {
      this.error = "Goal objective cannot be empty.";
      return;
    }
    if (objective.length > MAX_GOAL_OBJECTIVE_LENGTH) {
      this.error = `Goal objective cannot exceed ${MAX_GOAL_OBJECTIVE_LENGTH} characters.`;
      return;
    }
    this.done = true;
    this.opts.onDone({
      kind: "save",
      goalId: this.opts.goal.id,
      objective,
    });
  }
}

export function createInkGoalQueueEditSession(
  opts: GoalQueueEditDialogOptions,
): InkGoalQueueEditSession {
  return new InkGoalQueueEditSession(opts);
}

export function projectInkGoalQueueEditView(
  session: InkGoalQueueEditSession,
  width = 120,
): InkGoalQueueEditView {
  return session.projectView(width);
}

export type { GoalQueueEditDialogOptions, GoalQueueEditResult };

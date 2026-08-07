import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@moonshot-ai/kimi-tui";

import type {
  GoalQueueManagerAction,
  GoalQueueManagerInkSync,
  GoalQueueManagerOptions,
  GoalQueueManagerStateSnapshot,
} from "#/tui/components/dialogs/goal-queue-manager";
import type { GoalQueueSnapshot, UpcomingGoal } from "#/tui/goal-queue-store";
import { printableChar } from "#/tui/utils/printable-key";
import { SearchableList } from "#/tui/utils/searchable-list";

const ELLIPSIS = "…";

export interface InkGoalQueueManagerRowView {
  readonly index: number;
  readonly label: string;
  readonly moving: boolean;
  readonly selected: boolean;
}

export interface InkGoalQueueManagerView {
  readonly title: string;
  readonly hint: string;
  readonly rows: readonly InkGoalQueueManagerRowView[];
  readonly belowCount: number;
  readonly empty: boolean;
  readonly busy: boolean;
}

export class InkGoalQueueManagerSession implements GoalQueueManagerInkSync {
  private readonly opts: GoalQueueManagerOptions;
  private goals: readonly UpcomingGoal[];
  private list: SearchableList<UpcomingGoal>;
  private movingGoalId: string | undefined;
  private busy = false;
  private onStateChange: (() => void) | null = null;

  constructor(opts: GoalQueueManagerOptions) {
    this.opts = opts;
    this.goals = opts.goals;
    this.list = this.createList(opts.selectedGoalId);
  }

  setOnStateChange(onStateChange: (() => void) | null): void {
    this.onStateChange = onStateChange;
  }

  importState(snapshot: GoalQueueManagerStateSnapshot): void {
    this.goals = snapshot.goals;
    this.movingGoalId = snapshot.movingGoalId;
    this.busy = snapshot.busy;
    this.list = this.createList(undefined, snapshot.selectedIndex);
  }

  exportState(): GoalQueueManagerStateSnapshot {
    const view = this.list.view();
    return {
      goals: this.goals,
      selectedIndex: view.selectedIndex,
      movingGoalId: this.movingGoalId,
      busy: this.busy,
    };
  }

  handleInput(
    data: string,
    callbacks: {
      readonly onAction: GoalQueueManagerOptions["onAction"];
      readonly onCancel: () => void;
    },
  ): boolean {
    if (this.busy) return true;
    if (matchesKey(data, Key.escape)) {
      callbacks.onCancel();
      return true;
    }

    const selected = this.selectedGoal();
    const decoded = printableChar(data);
    if (matchesKey(data, Key.space) || decoded === " ") {
      this.movingGoalId =
        this.movingGoalId === selected?.id ? undefined : selected?.id;
      this.notifyChange();
      return true;
    }

    if ((decoded === "e" || decoded === "E") && selected !== undefined) {
      void callbacks.onAction({ kind: "edit", goalId: selected.id });
      return true;
    }

    if ((decoded === "d" || decoded === "D") && selected !== undefined) {
      void this.applyQueueAction(callbacks.onAction, {
        kind: "delete",
        goalId: selected.id,
      });
      return true;
    }

    if (this.movingGoalId !== undefined) {
      if (matchesKey(data, Key.up)) {
        void this.applyQueueAction(callbacks.onAction, {
          kind: "move",
          goalId: this.movingGoalId,
          direction: "up",
        });
        return true;
      }
      if (matchesKey(data, Key.down)) {
        void this.applyQueueAction(callbacks.onAction, {
          kind: "move",
          goalId: this.movingGoalId,
          direction: "down",
        });
        return true;
      }
    }

    if (this.list.handleKey(data)) {
      this.notifyChange();
      return true;
    }
    return true;
  }

  projectView(width = 120): InkGoalQueueManagerView {
    const view = this.list.view();
    const hint =
      this.movingGoalId === undefined
        ? "↑↓ navigate · Space select · E edit · D delete · Esc cancel"
        : "↑↓ reorder · Space done · E edit · D delete · Esc cancel";
    const labelWidth = Math.max(1, width - 5);
    const rows: InkGoalQueueManagerRowView[] = [];
    for (let i = view.page.start; i < view.page.end; i++) {
      const goal = view.items[i];
      if (goal === undefined) continue;
      rows.push({
        index: i,
        label: truncateToWidth(
          `${String(i + 1)}. ${formatListObjective(goal.objective)}`,
          labelWidth,
          ELLIPSIS,
        ),
        moving: goal.id === this.movingGoalId,
        selected: i === view.selectedIndex,
      });
    }
    return {
      title: "Upcoming goals",
      hint,
      rows,
      belowCount: view.items.length - view.page.end,
      empty: this.goals.length === 0,
      busy: this.busy,
    };
  }

  private notifyChange(): void {
    this.onStateChange?.();
  }

  private selectedGoal(): UpcomingGoal | undefined {
    return this.list.selected();
  }

  private async applyQueueAction(
    onAction: GoalQueueManagerOptions["onAction"],
    action: Exclude<GoalQueueManagerAction, { kind: "edit" }>,
  ): Promise<void> {
    this.busy = true;
    this.notifyChange();
    try {
      const result = await onAction(action);
      if (result !== undefined) {
        this.applySnapshot(result, action);
      }
    } finally {
      this.busy = false;
      this.notifyChange();
    }
  }

  private applySnapshot(
    result: GoalQueueSnapshot,
    action: Exclude<GoalQueueManagerAction, { kind: "edit" }>,
  ): void {
    const selectedGoalId = action.kind === "delete" ? undefined : action.goalId;
    this.goals = result.goals;
    if (!this.goals.some((goal) => goal.id === this.movingGoalId)) {
      this.movingGoalId = undefined;
    }
    this.list = this.createList(selectedGoalId ?? this.movingGoalId);
  }

  private createList(
    selectedGoalId?: string,
    initialIndex?: number,
  ): SearchableList<UpcomingGoal> {
    const fromId = this.goals.findIndex((goal) => goal.id === selectedGoalId);
    const index = fromId === -1 ? initialIndex : fromId;
    return new SearchableList({
      items: this.goals,
      toSearchText: (goal) => goal.objective,
      pageSize: this.opts.pageSize,
      initialIndex: index === undefined || index === -1 ? 0 : index,
      searchable: false,
    });
  }
}

function formatListObjective(objective: string): string {
  return objective.replaceAll(/\s+/g, " ").trim();
}

export function createInkGoalQueueManagerSession(
  opts: GoalQueueManagerOptions,
): InkGoalQueueManagerSession {
  return new InkGoalQueueManagerSession(opts);
}

export function projectInkGoalQueueManagerView(
  session: InkGoalQueueManagerSession,
  width = 120,
): InkGoalQueueManagerView {
  return session.projectView(width);
}

export type { GoalQueueManagerAction, GoalQueueManagerOptions };

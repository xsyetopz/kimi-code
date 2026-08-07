/**
 * `goal` domain — `IAgentGoalService` implementation.
 *
 * Owns the main-agent goal lifecycle; persists the goal in the `wire`
 * `GoalModel` (`GoalState | null`) through the `goal.create` / `goal.update` /
 * `goal.clear` Ops (`wire.dispatch`), reads it through `wire.getModel`,
 * publishes `goal.updated` live to `IEventBus`, and forces a replayed `active`
 * goal back to `paused` via `wire.hooks.onDidRestore`. The accumulated
 * `wallClockMs` lives in the Model (set from each Op payload, never by
 * `Date.now()` inside `apply`); the active interval's epoch-ms
 * `wallClockResumedAt` anchor is
 * persisted at create/resume boundaries so recovery can settle crash-spanning
 * elapsed time without periodic writes. A `forked` wire Op clears the Model
 * at a fork boundary. Injects reminders through
 * `contextInjector`, drives continuation turns by enqueueing `newTurn`
 * `StepRequest`s onto `loop` (the continuation message materializes when the
 * loop pops it), accounts live
 * turn usage through `usage`, observes terminal goal tool results through
 * `toolExecutor`, writes system reminders through `systemReminder`, reports
 * telemetry through `telemetry`, and checks main-agent eligibility through
 * `scopeContext`. Measures time and arms hard deadlines through `goal`'s
 * App-scoped deadline scheduler. Two `onBeforeExecuteTool` veto listeners
 * guard the goal lifecycle: stale or budget-exhausted goal tool calls are
 * vetoed with synthetic results, and a `CreateGoal` call carrying a
 * `goal_start` display outside `auto` mode defers to a cold `waitUntil`
 * factory that runs the goal-start review through `toolApproval` under the
 * origin `goal-start-review-ask` — including the permission-mode switch
 * picked on the approval surface. The mutable turn-tracking and wall-clock
 * state (`liveTurnId`, `goalDrivenTurns`, `countedGoalTurns`,
 * `goalStarterTurns`, `goalOutcomeToolResultTurns`,
 * `goalOutcomeContinuationTurns`, `budgetGraceTurns`,
 * `pendingContinuationGoals`, `goalTurnTargets`, `exhaustedTurnBudgetGoals`,
 * `liveWallClockStartedAt`, `resumeContinuation`) is registered into
 * `agentState` (`IAgentStateService`) and read/written through it; the
 * `pendingContinuation` promise lock and the `wallClockDeadline` disposable
 * slot stay plain fields. Bound at Agent scope.
 * Subagent instances reject every goal command and do not install goal
 * injection, accounting, budget, or continuation hooks.
 */

import { randomUUID } from "node:crypto";

import type { TurnEndedEvent, TurnStartedEvent } from "#/agent/loop/turnEvents";
import {
  Disposable,
  MutableDisposable,
  type IDisposable,
} from "#/_base/di/lifecycle";
import {
  LifecycleScope,
  ScopeActivation,
  registerScopedService,
} from "#/_base/di/scope";
import { defineState } from "#/_base/state/stateRegistry";
import { abortError } from "#/_base/utils/abort";
import { isPlainRecord } from "#/_base/utils/canonical-args";
import { IAgentContextInjectorService } from "#/agent/contextInjector/contextInjector";
import type { ContextMessage, PromptOrigin } from "#/agent/contextMemory/types";
import { GoalInjection } from "#/agent/goal/injection/goalInjection";
import {
  IAgentLoopService,
  type AfterStepContext,
  type BeforeStepContext,
  type EnqueueReceipt,
} from "#/agent/loop/loop";
import {
  LOOP_CONTROL_SECTION,
  type LoopControl,
} from "#/agent/loop/configSection";
import { LoopErrors } from "#/agent/loop/errors";
import {
  ContinuationStepRequest,
  MessageStepRequest,
} from "#/agent/loop/stepRequest";
import { IAgentSystemReminderService } from "#/agent/systemReminder/systemReminder";
import { IAgentScopeContext } from "#/agent/scopeContext/scopeContext";
import { IAgentStateService } from "#/agent/state/agentState";
import type { ExecutableToolResult } from "#/tool/toolContract";
import { IAgentPermissionModeService } from "#/agent/permissionMode/permissionMode";
import type { PermissionMode } from "#/agent/permissionPolicy/types";
import { IAgentToolApprovalService } from "#/agent/toolApproval/toolApproval";
import { IAgentToolExecutorService } from "#/agent/toolExecutor/toolExecutor";
import type { BeforeToolExecuteEvent } from "#/agent/toolExecutor/toolHooks";
import {
  IAgentUsageService,
  type UsageRecordedContext,
} from "#/agent/usage/usage";
import { IConfigService } from "#/app/config/config";
import {
  ErrorCodes,
  Error2,
  toKimiErrorPayload,
  type KimiErrorPayload,
} from "#/errors";
import { IWireService } from "#/wire/wire";
import { defineModel } from "#/wire/model";
import { IEventBus } from "#/app/event/eventBus";

import {
  IAgentGoalService,
  type GoalReasonInput,
  type ResumeGoalInput,
} from "./goal";
import { IGoalDeadlineScheduler } from "./goalDeadlineScheduler";
import {
  clearGoal,
  createGoal,
  GoalModel,
  updateGoal,
  type GoalState,
} from "./goalOps";
import type {
  CreateGoalInput,
  GoalActor,
  GoalBudgetLimits,
  GoalBudgetReport,
  GoalChange,
  GoalChangeStats,
  GoalSnapshot,
  GoalStatus,
  GoalToolResult,
} from "./types";

const MAX_GOAL_OBJECTIVE_LENGTH = 4000;

const MAX_GOAL_COMPLETION_CRITERION_LENGTH = MAX_GOAL_OBJECTIVE_LENGTH;

const GOAL_CANCELLED_REMINDER = [
  "The user cancelled the current goal.",
  "Ignore earlier active-goal reminders for that goal.",
  "Handle the next user request normally unless the user starts or resumes a goal.",
].join(" ");

const GOAL_FORK_CLEARED_REMINDER = [
  "This fork does not have a current goal.",
  "Ignore earlier active-goal reminders from the source session.",
  "Handle requests normally unless the user starts a new goal.",
].join(" ");

const GOAL_FORK_CLEARED_REMINDER_NAME = "goal_fork_cleared";

const GOAL_CONTINUATION_ORIGIN: PromptOrigin = {
  kind: "system_trigger",
  name: "goal_continuation",
};
const GOAL_RATE_LIMIT_PAUSE_REASON = "Paused after provider rate limit";
const GOAL_PROVIDER_CONNECTION_PAUSE_PREFIX =
  "Paused after provider connection error";
const GOAL_PROVIDER_AUTH_PAUSE_PREFIX =
  "Paused after provider authentication error";
const GOAL_PROVIDER_API_PAUSE_PREFIX = "Paused after provider API error";
const GOAL_MODEL_CONFIG_PAUSE_PREFIX = "Paused after model configuration error";
const GOAL_RUNTIME_PAUSE_PREFIX = "Paused after runtime error";
const GOAL_CONTINUATION_FAILURE_PAUSE_PREFIX =
  "Paused after goal continuation failure";
const GOAL_PROVIDER_FILTERED_PAUSE_REASON =
  "Paused after provider safety policy block";
const GOAL_BUDGET_BLOCK_PREFIX = "Blocked after goal budget reached";
const LLM_NOT_SET_MESSAGE = 'LLM not set, send "/login" to login';

const GOAL_BUDGET_STOP_REMINDER_NAME = "goal_budget_stop";

const GOAL_BUDGET_STOP_REMINDER = [
  "The goal's hard budget was reached and the goal is now blocked; the user can resume it with /goal resume.",
  "Stop immediately.",
  "Do not call any more tools: they will be rejected.",
  "Write a brief final status message summarizing the progress so far.",
].join(" ");

const GOAL_BUDGET_TOOLS_REJECTED_MESSAGE =
  "Goal budget exhausted; tool calls are rejected. Write your final message.";
const GOAL_STALE_TOOL_RESULT =
  "Goal changed since this turn started; ignored stale goal tool call.";

const GOAL_CONTINUATION_PROMPT = [
  "Continue working toward the active goal.",
  "Keep the self-audit brief. Do not explore unrelated interpretations once the goal can be",
  "decided. If the objective is simple, already answered, impossible, unsafe, or contradictory,",
  "do not run another goal turn. Explain briefly if useful, then call UpdateGoal with `complete`",
  "or `blocked` in the same turn. Otherwise, weigh the objective and any completion criteria",
  "against the work done so far, choose one bounded, useful slice of work, and use the existing",
  "conversation context and your tools. Do not try to finish a broad goal in one turn unless the",
  "whole goal is genuinely small. Most goal turns should not call UpdateGoal: after completing a",
  "useful slice, if material work remains, end the turn normally without calling UpdateGoal so",
  "the runtime can continue the goal in the next turn. Call UpdateGoal with `complete` only when",
  "all required work is done, any stated validation has passed, and there is no useful next",
  "action. Completion audit: before calling `complete`, verify the current state against the",
  "actual objective and every explicit requirement. Treat weak or indirect evidence as not",
  "complete. Do not mark complete after only producing a plan, summary, first pass, or partial",
  "result. Do not mark complete merely because a budget is nearly exhausted or you want to stop.",
  "Blocked audit: do not call UpdateGoal with `blocked` the first time you hit a blocker. Use",
  "`blocked` only for a genuine impasse: an external condition, required user input, missing",
  "credentials or permissions, or a persistent technical failure. For those non-terminal",
  "blockers, the same blocking condition must repeat for at least 3 consecutive goal turns before",
  "you call `blocked`, counting the original/user-triggered turn and automatic continuations.",
  "If a previously blocked goal is resumed, treat the resumed run as a fresh blocked audit.",
  "Exception: if the objective itself is impossible, unsafe, or contradictory, call UpdateGoal",
  "with `blocked` in the same turn; do not run more goal turns just to satisfy the audit. Do not",
  "use `blocked` because the work is large, hard, slow, uncertain, incomplete, still needs",
  "validation, would benefit from clarification, or needs more goal turns. Once the 3-turn",
  "threshold is met and you cannot make meaningful progress without user input or an",
  "external-state change, call UpdateGoal with `blocked`; do not keep reporting the blocker while",
  "leaving the goal active. Do not ask the user for input unless a real blocker prevents progress.",
].join(" ");

const GOAL_STEP_CAP_CONTINUATION_PROMPT = [
  "The previous goal turn reached the per-turn step limit before finishing its work,",
  "so a new turn was started for you. Pick up where that turn stopped and keep each",
  "slice of work small enough to fit the limit.",
  GOAL_CONTINUATION_PROMPT,
].join(" ");

interface GoalForkNoticeState {
  readonly goalPresent: boolean;
  readonly reminderPending: boolean;
}

interface PendingContinuation {
  readonly receipt: EnqueueReceipt;
  readonly goalId: string;
  turnId?: number;
}

interface ResumeContinuation {
  readonly turnId: number;
  readonly goalId: string;
}

const GoalForkNoticeModel = defineModel<GoalForkNoticeState>(
  "goalForkNotice",
  () => ({ goalPresent: false, reminderPending: false }),
  {
    reducers: {
      "goal.create": (state) => ({ ...state, goalPresent: true }),
      "goal.clear": (state) => ({ ...state, goalPresent: false }),
      forked: (state) => ({
        goalPresent: false,
        reminderPending: state.goalPresent || state.reminderPending,
      }),
      "context.append_message": (
        state,
        payload: { message?: ContextMessage },
      ) =>
        state.reminderPending && isGoalForkClearedReminder(payload.message)
          ? { ...state, reminderPending: false }
          : state,
    },
  },
);

function isGoalForkClearedReminder(
  message: ContextMessage | undefined,
): boolean {
  return (
    message?.origin?.kind === "system_trigger" &&
    message.origin.name === GOAL_FORK_CLEARED_REMINDER_NAME
  );
}

function isGoalContinuationOrigin(origin: TurnStartedEvent["origin"]): boolean {
  return (
    origin.kind === "system_trigger" && origin.name === "goal_continuation"
  );
}

export const goalLiveTurnIdKey = defineState<number | undefined>(
  "goal.liveTurnId",
  () => undefined as number | undefined,
);
export const goalGoalDrivenTurnsKey = defineState<Map<number, string>>(
  "goal.goalDrivenTurns",
  () => new Map(),
);
export const goalCountedGoalTurnsKey = defineState<Set<number>>(
  "goal.countedGoalTurns",
  () => new Set(),
);
export const goalGoalStarterTurnsKey = defineState<Set<number>>(
  "goal.goalStarterTurns",
  () => new Set(),
);
export const goalGoalOutcomeToolResultTurnsKey = defineState<
  Map<number, string>
>("goal.goalOutcomeToolResultTurns", () => new Map());
export const goalGoalOutcomeContinuationTurnsKey = defineState<Set<number>>(
  "goal.goalOutcomeContinuationTurns",
  () => new Set(),
);
export const goalBudgetGraceTurnsKey = defineState<Set<number>>(
  "goal.budgetGraceTurns",
  () => new Set(),
);
export const goalPendingContinuationGoalsKey = defineState<Map<number, string>>(
  "goal.pendingContinuationGoals",
  () => new Map(),
);
export const goalGoalTurnTargetsKey = defineState<Map<number, string>>(
  "goal.goalTurnTargets",
  () => new Map(),
);
export const goalExhaustedTurnBudgetGoalsKey = defineState<Map<number, string>>(
  "goal.exhaustedTurnBudgetGoals",
  () => new Map(),
);
export const goalLiveWallClockStartedAtKey = defineState<number | undefined>(
  "goal.liveWallClockStartedAt",
  () => undefined as number | undefined,
);
export const goalResumeContinuationKey = defineState<
  ResumeContinuation | undefined
>("goal.resumeContinuation", () => undefined as ResumeContinuation | undefined);

import { AgentGoalServiceHooks } from "./goalService.hooks";

export class AgentGoalServiceContinuation extends AgentGoalServiceHooks {
  private async handleTurnEnded(
    turnId: number,
    result: Pick<TurnEndedEvent, "reason" | "error">,
  ): Promise<void> {
    const { goalId, lifecycleGoalId, starterTurn } =
      this.clearTurnTracking(turnId);
    const resumeContinuation = this.resumeContinuation;
    if (resumeContinuation?.turnId === turnId)
      this.resumeContinuation = undefined;
    if (
      resumeContinuation?.turnId === turnId &&
      result.reason === "cancelled"
    ) {
      const state = this.goalState;
      if (
        state === null ||
        state.status !== "active" ||
        state.goalId !== resumeContinuation.goalId
      ) {
        return;
      }
      if (this.blockIfBudgetReached(state) !== null) return;
      this.launchContinuationTurn(resumeContinuation.goalId);
      return;
    }
    if (goalId === undefined || lifecycleGoalId === undefined) return;
    const stepCapped = isMaxStepsTurnFailure(result);
    if (
      !stepCapped &&
      (result.reason === "blocked" ||
        result.reason === "cancelled" ||
        result.reason === "failed")
    ) {
      await this.settleAbnormalTurn(result, lifecycleGoalId);
      return;
    }
    if (starterTurn) this.incrementGoalTurn(goalId);

    const state = this.goalState;
    if (
      state === null ||
      state.status !== "active" ||
      state.goalId !== lifecycleGoalId
    )
      return;
    if (this.blockIfBudgetReached(state) !== null) return;
    this.launchContinuationTurn(lifecycleGoalId, stepCapped);
  }

  private clearTurnTracking(turnId: number): {
    readonly goalId?: string;
    readonly lifecycleGoalId?: string;
    readonly starterTurn: boolean;
  } {
    if (this.pendingContinuation?.turnId === turnId)
      this.pendingContinuation = undefined;
    if (this.liveTurnId === turnId) this.liveTurnId = undefined;
    const goalId = this.goalDrivenTurns.get(turnId);
    const lifecycleGoalId = this.goalTurnTarget(turnId);
    const starterTurn = this.goalStarterTurns.delete(turnId);
    this.goalDrivenTurns.delete(turnId);
    this.countedGoalTurns.delete(turnId);
    this.goalOutcomeToolResultTurns.delete(turnId);
    this.goalOutcomeContinuationTurns.delete(turnId);
    this.budgetGraceTurns.delete(turnId);
    this.pendingContinuationGoals.delete(turnId);
    this.goalTurnTargets.delete(turnId);
    this.exhaustedTurnBudgetGoals.delete(turnId);
    return { goalId, lifecycleGoalId, starterTurn };
  }

  private async settleAbnormalTurn(
    result: Pick<TurnEndedEvent, "reason" | "error">,
    goalId: string,
  ): Promise<boolean> {
    if (!this.isActiveGoal(goalId)) return false;
    if (result.reason === "blocked") {
      await this.markBlocked({ reason: "Blocked by UserPromptSubmit hook" });
      return true;
    }
    if (result.reason === "cancelled") {
      await this.pauseOnInterrupt({ reason: "Paused after interruption" });
      return true;
    }
    if (result.reason === "failed") {
      await this.pauseActiveGoal({
        reason: goalFailurePauseReason(result.error),
      });
      return true;
    }
    return false;
  }

  private async settleGoalAfterContinuationFailure(
    error: unknown,
    goalId: string | undefined,
  ): Promise<void> {
    if (goalId === undefined || !this.isActiveGoal(goalId)) return;
    try {
      const reason = pauseReasonWithMessage(
        GOAL_CONTINUATION_FAILURE_PAUSE_PREFIX,
        normalizeGoalErrorPayload(error).message,
      );
      await this.pauseActiveGoal({ reason }, "system");
    } catch {}
  }

  private launchContinuationTurn(goalId: string, stepCapped = false): void {
    if (!this.isActiveGoal(goalId)) return;
    if (this.pendingContinuation !== undefined) return;
    const message: ContextMessage = {
      role: "user",
      content: [
        {
          type: "text",
          text: stepCapped
            ? GOAL_STEP_CAP_CONTINUATION_PROMPT
            : GOAL_CONTINUATION_PROMPT,
        },
      ],
      toolCalls: [],
      origin: GOAL_CONTINUATION_ORIGIN,
    };
    const request = new MessageStepRequest(message, {
      kind: "goal_continuation",
      admission: "newTurn",
    });
    const receipt = this.loopService.enqueue(request);
    const pending: PendingContinuation = { receipt, goalId };
    this.pendingContinuation = pending;
    void receipt.assigned
      .then(({ turn }) => {
        pending.turnId = turn.id;
        if (!this.goalDrivenTurns.has(turn.id)) {
          this.pendingContinuationGoals.set(turn.id, pending.goalId);
        }
        return turn.result;
      })
      .finally(() => {
        if (pending.turnId !== undefined)
          this.pendingContinuationGoals.delete(pending.turnId);
        if (this.pendingContinuation === pending)
          this.pendingContinuation = undefined;
      });
  }

  private canLaunchContinuation(): boolean {
    if (this.liveTurnId !== undefined || this.pendingContinuation !== undefined)
      return false;
    const status = this.loopService.status();
    return status.state === "idle" && !status.hasPendingRequests;
  }

  private isActiveGoal(goalId: string): boolean {
    const state = this.goalState;
    return state?.status === "active" && state.goalId === goalId;
  }

  private isStaleGoalToolCall(ctx: BeforeToolExecuteEvent): boolean {
    const toolName = ctx.toolCall.name;
    if (!isGoalMutationTool(toolName)) return false;
    const goalId = this.goalTurnTarget(ctx.turnId);
    if (goalId === undefined) return false;
    return this.goalState?.goalId !== goalId;
  }

  private goalTurnTarget(turnId: number): string | undefined {
    return this.goalTurnTargets.get(turnId) ?? this.goalDrivenTurns.get(turnId);
  }

  private cancelPendingContinuation(
    preserveLiveContinuation = false,
    reason?: unknown,
  ): void {
    const pending = this.pendingContinuation;
    if (preserveLiveContinuation && pending?.turnId === this.liveTurnId) return;
    this.pendingContinuation = undefined;
    const cancellation = reason ?? abortError("Goal continuation cancelled");
    const aborted = pending?.receipt.abort(cancellation);
    if (pending !== undefined && !aborted && pending.turnId !== undefined) {
      this.loopService.cancel(pending.turnId, cancellation);
    }
  }

  private normalizeAfterReplay(): void {
    this.appendForkClearedReminder();
    this.wallClockDeadline.clear();
    this.liveWallClockStartedAt = undefined;
    const state = this.goalState;
    if (state === null) return;
    if (state.status === "complete") {
      this.clearInternal("runtime", { emit: false, track: false });
      return;
    }
    if (state.status !== "active") return;

    const reason = "Paused after agent resume";
    this.wire.dispatch(
      updateGoal({
        status: "paused",
        reason,
        wallClockMs: this.settleWallClock(state),
        actor: "runtime",
      }),
    );
    this.trackStatusChanged(this.requireState(), "runtime");
  }

  private appendForkClearedReminder(): void {
    if (!this.wire.getModel(GoalForkNoticeModel).reminderPending) return;
    this.reminders.appendSystemReminder(GOAL_FORK_CLEARED_REMINDER, {
      kind: "system_trigger",
      name: GOAL_FORK_CLEARED_REMINDER_NAME,
    });
  }

  private clearInternal(
    actor: GoalActor,
    opts: {
      readonly emit?: boolean;
      readonly track?: boolean;
      readonly preserveLiveContinuation?: boolean;
    } = {},
  ): void {
    if (this.goalState === null) return;
    this.resumeContinuation = undefined;
    this.cancelPendingContinuation(opts.preserveLiveContinuation === true);
    this.wallClockDeadline.clear();
    this.liveWallClockStartedAt = undefined;
    this.wire.dispatch(clearGoal({}));
    if (opts.emit !== false) this.emitGoalUpdated(null);
  }

  private applyLifecycle(
    state: GoalState,
    status: GoalStatus,
    reason: string | undefined,
    actor: GoalActor,
    opts: {
      readonly preserveLiveContinuation?: boolean;
      readonly cancellationReason?: unknown;
    } = {},
  ): GoalSnapshot {
    const wallClockMs = this.settleWallClock(state);
    const wallClockResumedAt = status === "active" ? Date.now() : undefined;
    if (status === "active") {
      this.liveWallClockStartedAt = this.deadlineScheduler.now();
    } else if (state.status === "active") {
      this.resumeContinuation = undefined;
      this.cancelPendingContinuation(
        opts.preserveLiveContinuation === true,
        opts.cancellationReason,
      );
      this.wallClockDeadline.clear();
      this.liveWallClockStartedAt = undefined;
    }
    this.wire.dispatch(
      updateGoal({ status, reason, wallClockMs, wallClockResumedAt, actor }),
    );
    const next = this.requireState();
    if (status === "active") this.adoptStarterTurn(actor);
    if (status === "active") this.refreshWallClockDeadline(next);
    this.emitGoalUpdated(this.toSnapshot(next), {
      kind: "lifecycle",
      status,
      reason,
      actor,
    });
    this.trackStatusChanged(next, actor);
    return this.toSnapshot(next);
  }

  private trackStatusChanged(state: GoalState, actor: GoalActor): void {
  }

  private requireState(): GoalState {
    const state = this.goalState;
    if (state === null) {
      throw new Error2(ErrorCodes.GOAL_NOT_FOUND, "No current goal");
    }
    return state;
  }

  private emitGoalUpdated(
    snapshot: GoalSnapshot | null,
    change?: GoalChange,
  ): void {
    this.eventBus.publish({ type: "goal.updated", snapshot, change });
  }

  private settleWallClock(state: GoalState): number {
    if (
      state.status === "active" &&
      this.liveWallClockStartedAt !== undefined
    ) {
      return (
        state.wallClockMs +
        Math.max(0, this.deadlineScheduler.now() - this.liveWallClockStartedAt)
      );
    }
    if (state.status === "active" && state.wallClockResumedAt !== undefined) {
      return (
        state.wallClockMs + Math.max(0, Date.now() - state.wallClockResumedAt)
      );
    }
    return state.wallClockMs;
  }

  private liveWallClockMs(state: GoalState): number {
    if (
      state.status === "active" &&
      this.liveWallClockStartedAt !== undefined
    ) {
      return (
        state.wallClockMs +
        Math.max(0, this.deadlineScheduler.now() - this.liveWallClockStartedAt)
      );
    }
    if (state.status === "active" && state.wallClockResumedAt !== undefined) {
      return (
        state.wallClockMs + Math.max(0, Date.now() - state.wallClockResumedAt)
      );
    }
    return state.wallClockMs;
  }

  private statsOf(state: GoalState): GoalChangeStats {
    return {
      turnsUsed: state.turnsUsed,
      tokensUsed: state.tokensUsed,
      wallClockMs: this.liveWallClockMs(state),
    };
  }

  private toSnapshot(state: GoalState): GoalSnapshot {
    const wallClockMs = this.liveWallClockMs(state);
    return {
      goalId: state.goalId,
      objective: state.objective,
      completionCriterion: state.completionCriterion,
      status: state.status,
      turnsUsed: state.turnsUsed,
      tokensUsed: state.tokensUsed,
      wallClockMs,
      budget: computeBudgetReport(state, wallClockMs),
      terminalReason: state.terminalReason,
    };
  }

  private blockIfBudgetReached(state: GoalState): GoalSnapshot | null {
    if (state.status !== "active") return null;
    const reason = goalBudgetBlockReason(this.toSnapshot(state).budget);
    if (reason === undefined) return null;
    return this.applyLifecycle(state, "blocked", reason, "runtime", {
      preserveLiveContinuation: true,
    });
  }

  private refreshWallClockDeadline(state: GoalState): void {
    this.wallClockDeadline.clear();
    const budgetMs = state.budgetLimits.wallClockBudgetMs;
    if (
      state.status !== "active" ||
      budgetMs === undefined ||
      this.liveWallClockStartedAt === undefined
    ) {
      return;
    }
    const remainingMs = Math.max(0, budgetMs - this.liveWallClockMs(state));
    this.wallClockDeadline.value = this.deadlineScheduler.schedule(
      remainingMs,
      () => {
        this.handleWallClockDeadline();
      },
    );
  }

  private handleWallClockDeadline(): void {
    this.wallClockDeadline.clear();
    const state = this.goalState;
    if (state === null || state.status !== "active") return;
    const budgetMs = state.budgetLimits.wallClockBudgetMs;
    if (budgetMs === undefined) return;
    if (this.liveWallClockMs(state) < budgetMs) {
      this.refreshWallClockDeadline(state);
      return;
    }
    const reason = goalBudgetBlockReason(this.toSnapshot(state).budget);
    if (reason === undefined) return;
    const cancellation = abortError(reason);
    const liveTurnId = this.liveTurnId;
    const pendingTurnId = this.pendingContinuation?.turnId;
    this.applyLifecycle(state, "blocked", reason, "runtime", {
      cancellationReason: cancellation,
    });
    if (liveTurnId !== undefined && liveTurnId !== pendingTurnId) {
      this.loopService.cancel(liveTurnId, cancellation);
    }
  }
}

function computeBudgetReport(
  state: GoalState,
  wallClockMs: number,
): GoalBudgetReport {
  const tokenBudget = state.budgetLimits.tokenBudget ?? null;
  const turnBudget = state.budgetLimits.turnBudget ?? null;
  const wallClockBudgetMs = state.budgetLimits.wallClockBudgetMs ?? null;

  const tokenBudgetReached =
    tokenBudget !== null && state.tokensUsed >= tokenBudget;
  const turnBudgetReached =
    turnBudget !== null && state.turnsUsed >= turnBudget;
  const wallClockBudgetReached =
    wallClockBudgetMs !== null && wallClockMs >= wallClockBudgetMs;

  return {
    tokenBudget,
    turnBudget,
    wallClockBudgetMs,
    remainingTokens:
      tokenBudget === null ? null : Math.max(0, tokenBudget - state.tokensUsed),
    remainingTurns:
      turnBudget === null ? null : Math.max(0, turnBudget - state.turnsUsed),
    remainingWallClockMs:
      wallClockBudgetMs === null
        ? null
        : Math.max(0, wallClockBudgetMs - wallClockMs),
    tokenBudgetReached,
    turnBudgetReached,
    wallClockBudgetReached,
    overBudget:
      tokenBudgetReached || turnBudgetReached || wallClockBudgetReached,
  };
}

function matchesGoal(state: GoalState, goalId: string | undefined): boolean {
  return goalId === undefined || state.goalId === goalId;
}

function isGoalMutationTool(toolName: string): boolean {
  return (
    toolName === "CreateGoal" ||
    toolName === "UpdateGoal" ||
    toolName === "SetGoalBudget"
  );
}

function toGoalStartReviewPermissionMode(
  label: string | undefined,
): PermissionMode | undefined {
  if (label === "auto" || label === "yolo" || label === "manual") return label;
  return undefined;
}

function goalBudgetBlockReason(budget: GoalBudgetReport): string | undefined {
  const reached: string[] = [];
  if (budget.turnBudgetReached) {
    reached.push(`turn budget ${budget.turnBudget ?? ""}`.trim());
  }
  if (budget.tokenBudgetReached) {
    reached.push(`token budget ${budget.tokenBudget ?? ""}`.trim());
  }
  if (budget.wallClockBudgetReached) {
    reached.push(
      `wall-clock budget ${budget.wallClockBudgetMs ?? ""}ms`.trim(),
    );
  }
  return reached.length === 0
    ? undefined
    : `${GOAL_BUDGET_BLOCK_PREFIX}: ${reached.join(", ")}`;
}

function budgetTelemetryProperties(
  limits: GoalBudgetLimits,
): GoalBudgetProperties {
  return {
    has_token_budget: limits.tokenBudget !== undefined,
    has_turn_budget: limits.turnBudget !== undefined,
    has_wall_clock_budget: limits.wallClockBudgetMs !== undefined,
  };
}

function normalizeCompletionCriterion(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed?.length) return undefined;
  return trimmed.length > MAX_GOAL_COMPLETION_CRITERION_LENGTH
    ? trimmed.slice(0, MAX_GOAL_COMPLETION_CRITERION_LENGTH)
    : trimmed;
}

function hasStepBudgetRemaining(
  maxSteps: number | undefined,
  currentStep: number,
): boolean {
  return maxSteps === undefined || maxSteps <= 0 || currentStep < maxSteps;
}

function isTerminalUpdateGoalResult(
  toolName: string,
  args: unknown,
  result: ExecutableToolResult,
): boolean {
  if (
    toolName !== "UpdateGoal" ||
    result.isError === true ||
    result.stopTurn !== true
  ) {
    return false;
  }
  if (!isPlainRecord(args)) return false;
  const status = args["status"];
  return status === "complete" || status === "blocked";
}

function isMaxStepsTurnFailure(
  result: Pick<TurnEndedEvent, "reason" | "error">,
): boolean {
  return (
    result.reason === "failed" &&
    normalizeGoalErrorPayload(result.error).code ===
      LoopErrors.codes.LOOP_MAX_STEPS_EXCEEDED
  );
}

function goalFailurePauseReason(error: unknown): string {
  const payload = normalizeGoalErrorPayload(error);
  switch (payload.code) {
    case ErrorCodes.PROVIDER_RATE_LIMIT:
      return GOAL_RATE_LIMIT_PAUSE_REASON;
    case ErrorCodes.PROVIDER_CONNECTION_ERROR:
      return pauseReasonWithMessage(
        GOAL_PROVIDER_CONNECTION_PAUSE_PREFIX,
        payload.message,
      );
    case ErrorCodes.PROVIDER_AUTH_ERROR:
      return pauseReasonWithMessage(
        GOAL_PROVIDER_AUTH_PAUSE_PREFIX,
        payload.message,
      );
    case ErrorCodes.PROVIDER_FILTERED:
      return GOAL_PROVIDER_FILTERED_PAUSE_REASON;
    case ErrorCodes.PROVIDER_API_ERROR:
      return pauseReasonWithMessage(
        GOAL_PROVIDER_API_PAUSE_PREFIX,
        payload.message,
      );
    case ErrorCodes.MODEL_NOT_CONFIGURED:
      return pauseReasonWithMessage(
        GOAL_MODEL_CONFIG_PAUSE_PREFIX,
        LLM_NOT_SET_MESSAGE,
      );
    case ErrorCodes.MODEL_CONFIG_INVALID:
      return pauseReasonWithMessage(
        GOAL_MODEL_CONFIG_PAUSE_PREFIX,
        payload.message,
      );
    default:
      return pauseReasonWithMessage(GOAL_RUNTIME_PAUSE_PREFIX, payload.message);
  }
}

function normalizeGoalErrorPayload(error: unknown): KimiErrorPayload {
  const payload = toKimiErrorPayload(error);
  if (payload.code === ErrorCodes.MODEL_NOT_CONFIGURED) {
    return { ...payload, message: LLM_NOT_SET_MESSAGE };
  }
  return payload;
}

function pauseReasonWithMessage(
  prefix: string,
  message: string | undefined,
): string {
  const trimmed = message?.trim();
  return trimmed === undefined || trimmed.length === 0
    ? prefix
    : `${prefix}: ${trimmed}`;
}

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
 * `toolExecutor`, writes system reminders through `systemReminder`, and checks
 * main-agent eligibility through
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
import {
  isTerminalUpdateGoalResult,
  matchesGoal,
  normalizeCompletionCriterion,
  toGoalStartReviewPermissionMode,
} from "./goalService.support";

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

export class AgentGoalServiceCore
  extends Disposable
  implements IAgentGoalService
{
  declare readonly _serviceBrand: undefined;

  private readonly wallClockDeadline = this._register(
    new MutableDisposable<IDisposable>(),
  );
  private pendingContinuation?: PendingContinuation;

  constructor(
    @IWireService private readonly wire: IWireService,
    @IEventBus private readonly eventBus: IEventBus,
    @IAgentSystemReminderService
    private readonly reminders: IAgentSystemReminderService,    @IAgentContextInjectorService dynamicInjector: IAgentContextInjectorService,
    @IAgentLoopService private readonly loopService: IAgentLoopService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IAgentToolApprovalService
    private readonly toolApproval: IAgentToolApprovalService,
    @IAgentPermissionModeService
    private readonly permissionMode: IAgentPermissionModeService,
    @IAgentUsageService usageService: IAgentUsageService,
    @IConfigService private readonly config: IConfigService,
    @IGoalDeadlineScheduler
    private readonly deadlineScheduler: IGoalDeadlineScheduler,
    @IAgentScopeContext private readonly agentContext: IAgentScopeContext,
    @IAgentStateService private readonly states: IAgentStateService,
  ) {
    super();
    this.states.register(goalLiveTurnIdKey);
    this.states.register(goalGoalDrivenTurnsKey);
    this.states.register(goalCountedGoalTurnsKey);
    this.states.register(goalGoalStarterTurnsKey);
    this.states.register(goalGoalOutcomeToolResultTurnsKey);
    this.states.register(goalGoalOutcomeContinuationTurnsKey);
    this.states.register(goalBudgetGraceTurnsKey);
    this.states.register(goalPendingContinuationGoalsKey);
    this.states.register(goalGoalTurnTargetsKey);
    this.states.register(goalExhaustedTurnBudgetGoalsKey);
    this.states.register(goalLiveWallClockStartedAtKey);
    this.states.register(goalResumeContinuationKey);
    if (!this.isSupportedAgent) return;
    this._register(
      new GoalInjection(
        {
          getGoal: () => this.getGoal().goal,
        },
        dynamicInjector,
      ),
    );
    this._register(
      this.wire.hooks.onDidRestore.register("goal", async (_ctx, next) => {
        this.normalizeAfterReplay();
        await next();
      }),
    );
    this._register(
      this.eventBus.subscribe("turn.started", (e) => {
        this.handleTurnLaunched(e.turnId, e.origin);
      }),
    );
    this._register(
      usageService.onDidRecord((ctx) => this.handleUsageRecorded(ctx)),
    );
    this._register(
      loopService.hooks.onWillBeginStep.register(
        "goal-count-turn",
        async (ctx, next) => {
          await this.handleBeforeStep(ctx);
          await next();
        },
      ),
    );
    this._register(
      loopService.hooks.onDidFinishStep.register(
        "goal-outcome-continuation",
        async (ctx, next) => {
          this.handleAfterStep(ctx);
          await next();
        },
      ),
    );
    this._register(
      toolExecutor.onBeforeExecuteTool((event) => {
        if (
          event.toolCall.name !== "CreateGoal" ||
          this.permissionMode.mode === "auto" ||
          event.execution.display?.kind !== "goal_start"
        ) {
          return;
        }
        event.waitUntil(async () =>
          this.toolApproval.requestToolApproval(
            event,
            {
              kind: "ask",
              resolveApproval: (approval) => {
                if (approval.decision !== "approved") return undefined;
                const mode = toGoalStartReviewPermissionMode(
                  approval.selectedLabel,
                );
                if (mode !== undefined && mode !== this.permissionMode.mode) {
                  this.permissionMode.setMode(mode);
                }
                return undefined;
              },
            },
            "goal-start-review-ask",
          ),
        );
      }),
    );
    this._register(
      toolExecutor.onBeforeExecuteTool((event) => {
        if (this.isStaleGoalToolCall(event)) {
          event.veto({ output: GOAL_STALE_TOOL_RESULT });
          return;
        }
        if (this.budgetGraceTurns.has(event.turnId)) {
          event.veto({ output: GOAL_BUDGET_TOOLS_REJECTED_MESSAGE });
        }
      }),
    );
    this._register(
      toolExecutor.hooks.onDidExecuteTool.register(
        "goal-outcome-tool-result",
        async (ctx, next) => {
          const goalId = this.goalTurnTarget(ctx.turnId);
          if (
            goalId !== undefined &&
            isTerminalUpdateGoalResult(ctx.toolCall.name, ctx.args, ctx.result)
          ) {
            this.goalOutcomeToolResultTurns.set(ctx.turnId, goalId);
          }
          await next();
        },
      ),
    );
    this._register(
      this.eventBus.subscribe("turn.ended", (e) => {
        const goalId = this.goalTurnTarget(e.turnId);
        void this.handleTurnEnded(e.turnId, {
          reason: e.reason,
          error: e.error,
        }).catch((error) =>
          this.settleGoalAfterContinuationFailure(error, goalId),
        );
      }),
    );
  }

  private get liveTurnId(): number | undefined {
    return this.states.get(goalLiveTurnIdKey);
  }

  private set liveTurnId(value: number | undefined) {
    this.states.set(goalLiveTurnIdKey, value);
  }

  private get goalDrivenTurns(): Map<number, string> {
    return this.states.get(goalGoalDrivenTurnsKey);
  }

  private get countedGoalTurns(): Set<number> {
    return this.states.get(goalCountedGoalTurnsKey);
  }

  private get goalStarterTurns(): Set<number> {
    return this.states.get(goalGoalStarterTurnsKey);
  }

  private get goalOutcomeToolResultTurns(): Map<number, string> {
    return this.states.get(goalGoalOutcomeToolResultTurnsKey);
  }

  private get goalOutcomeContinuationTurns(): Set<number> {
    return this.states.get(goalGoalOutcomeContinuationTurnsKey);
  }

  private get budgetGraceTurns(): Set<number> {
    return this.states.get(goalBudgetGraceTurnsKey);
  }

  private get pendingContinuationGoals(): Map<number, string> {
    return this.states.get(goalPendingContinuationGoalsKey);
  }

  private get goalTurnTargets(): Map<number, string> {
    return this.states.get(goalGoalTurnTargetsKey);
  }

  private get exhaustedTurnBudgetGoals(): Map<number, string> {
    return this.states.get(goalExhaustedTurnBudgetGoalsKey);
  }

  private get liveWallClockStartedAt(): number | undefined {
    return this.states.get(goalLiveWallClockStartedAtKey);
  }

  private set liveWallClockStartedAt(value: number | undefined) {
    this.states.set(goalLiveWallClockStartedAtKey, value);
  }

  private get resumeContinuation(): ResumeContinuation | undefined {
    return this.states.get(goalResumeContinuationKey);
  }

  private set resumeContinuation(value: ResumeContinuation | undefined) {
    this.states.set(goalResumeContinuationKey, value);
  }

  private get isSupportedAgent(): boolean {
    return this.agentContext.agentId === "main";
  }

  private assertSupportedAgent(): void {
    if (this.isSupportedAgent) return;
    throw new Error2(
      ErrorCodes.GOAL_UNSUPPORTED_AGENT,
      "Goals are only supported by the main agent",
      { details: { agentId: this.agentContext.agentId } },
    );
  }

  private get goalState(): GoalState | null {
    return this.wire.getModel(GoalModel) as GoalState | null;
  }

  getGoal(): GoalToolResult {
    this.assertSupportedAgent();
    const state = this.goalState;
    return { goal: state === null ? null : this.toSnapshot(state) };
  }

  isGoalToolTarget(turnId: number, goalId: string): boolean {
    this.assertSupportedAgent();
    return this.goalTurnTargets.get(turnId) === goalId;
  }

  async createGoal(
    input: CreateGoalInput,
    actor: GoalActor = "user",
  ): Promise<GoalSnapshot> {
    this.assertSupportedAgent();
    const objective = this.validateObjective(input.objective);
    this.prepareForGoalCreation(input.replace === true);
    const wallClockResumedAt = Date.now();
    this.wire.dispatch(
      createGoal({
        goalId: randomUUID(),
        objective,
        completionCriterion: normalizeCompletionCriterion(
          input.completionCriterion,
        ),
        wallClockResumedAt,
      }),
    );
    this.liveWallClockStartedAt = this.deadlineScheduler.now();
    this.adoptStarterTurn(actor);
    const state = this.requireState();
    this.refreshWallClockDeadline(state);
    this.emitGoalUpdated(this.toSnapshot(state));
    return this.toSnapshot(state);
  }

  private validateObjective(value: string): string {
    const objective = value.trim();
    if (objective.length === 0) {
      throw new Error2(
        ErrorCodes.GOAL_OBJECTIVE_EMPTY,
        "Goal objective cannot be empty",
      );
    }
    if (objective.length > MAX_GOAL_OBJECTIVE_LENGTH) {
      throw new Error2(
        ErrorCodes.GOAL_OBJECTIVE_TOO_LONG,
        `Goal objective cannot exceed ${MAX_GOAL_OBJECTIVE_LENGTH} characters`,
      );
    }
    return objective;
  }

  private prepareForGoalCreation(replace: boolean): void {
    if (this.goalState === null) return;
    if (!replace) {
      throw new Error2(
        ErrorCodes.GOAL_ALREADY_EXISTS,
        "A goal already exists; use replace to start a new one",
      );
    }
    this.clearInternal("system");
  }

  async pauseGoal(
    input: GoalReasonInput = {},
    actor: GoalActor = "user",
  ): Promise<GoalSnapshot> {
    this.assertSupportedAgent();
    const state = this.requireState();
    if (state.status === "paused") return this.toSnapshot(state);
    if (state.status !== "active") {
      throw new Error2(
        ErrorCodes.GOAL_STATUS_INVALID,
        `Cannot pause a goal in status "${state.status}"`,
      );
    }
    return this.applyLifecycle(state, "paused", input.reason, actor);
  }

  async pauseActiveGoal(
    input: GoalReasonInput = {},
    actor: GoalActor = "runtime",
  ): Promise<GoalSnapshot | null> {
    this.assertSupportedAgent();
    const state = this.goalState;
    if (state === null || state.status !== "active") return null;
    return this.applyLifecycle(state, "paused", input.reason, actor);
  }

  async resumeGoal(
    input: ResumeGoalInput = {},
    actor: GoalActor = "user",
  ): Promise<GoalSnapshot> {
    this.assertSupportedAgent();
    const state = this.requireState();
    if (state.status === "active") return this.toSnapshot(state);
    if (state.status !== "paused" && state.status !== "blocked") {
      throw new Error2(
        ErrorCodes.GOAL_NOT_RESUMABLE,
        `Cannot resume a goal in status "${state.status}"`,
      );
    }
    const continuePaused =
      actor === "user" &&
      state.status === "paused" &&
      input.continueIfPaused === true;
    const shouldContinue =
      continuePaused ||
      (actor === "user" &&
        state.status === "blocked" &&
        input.continueIfBlocked === true);
    const snapshot = this.applyLifecycle(state, "active", input.reason, actor);
    if (!shouldContinue) return snapshot;
    const budgetBlocked = this.blockIfBudgetReached(this.requireState());
    if (budgetBlocked !== null) return budgetBlocked;
    if (this.canLaunchContinuation()) {
      try {
        this.launchContinuationTurn(state.goalId);
      } catch (error) {
        await this.settleGoalAfterContinuationFailure(error, state.goalId);
        throw error;
      }
    } else if (continuePaused && this.liveTurnId !== undefined) {
      this.resumeContinuation = {
        turnId: this.liveTurnId,
        goalId: state.goalId,
      };
    }
    return snapshot;
  }

  async setBudgetLimits(
    input: { readonly budgetLimits: GoalBudgetLimits },
    actor: GoalActor = "user",
  ): Promise<GoalSnapshot> {
    this.assertSupportedAgent();
    const state = this.requireState();
    const budgetLimits = { ...state.budgetLimits, ...input.budgetLimits };
    this.wire.dispatch(updateGoal({ budgetLimits }));
    const next = this.requireState();
    this.emitGoalUpdated(this.toSnapshot(next));
    const blocked = this.blockIfBudgetReached(next);
    if (blocked !== null) return blocked;
    this.refreshWallClockDeadline(next);
    return this.toSnapshot(next);
  }

  async cancelGoal(
    _input: GoalReasonInput = {},
    actor: GoalActor = "user",
  ): Promise<GoalSnapshot> {
    this.assertSupportedAgent();
    const state = this.requireState();
    const snapshot = this.toSnapshot(state);
    if (state.status === "active" && this.liveTurnId !== undefined) {
      this.loopService.cancel(this.liveTurnId, abortError("Goal cancelled"));
    }
    this.clearInternal(actor);
    if (actor === "user") {
      this.reminders.appendSystemReminder(GOAL_CANCELLED_REMINDER, {
        kind: "system_trigger",
        name: "goal_cancelled",
      });
    }
    return snapshot;
  }

  async markBlocked(
    input: GoalReasonInput = {},
    actor: GoalActor = "runtime",
  ): Promise<GoalSnapshot | null> {
    this.assertSupportedAgent();
    const state = this.goalState;
    if (state === null || state.status !== "active") return null;
    const snapshot = this.applyLifecycle(
      state,
      "blocked",
      input.reason,
      actor,
      {
        preserveLiveContinuation: true,
      },
    );
    return snapshot;
  }

  async markComplete(
    input: GoalReasonInput = {},
    actor: GoalActor = "model",
  ): Promise<GoalSnapshot | null> {
    this.assertSupportedAgent();
    const state = this.goalState;
    if (state === null || state.status !== "active") return null;
    this.dispatchCompletion(state, input.reason, actor);
    const completed = this.requireState();
    const snapshot = this.toSnapshot(completed);
    this.emitCompletion(completed, snapshot, input.reason, actor);
    this.trackStatusChanged(completed, actor);
    this.clearInternal(actor, { preserveLiveContinuation: true });
    return snapshot;
  }

  private dispatchCompletion(
    state: GoalState,
    reason: string | undefined,
    actor: GoalActor,
  ): void {
    const wallClockMs = this.settleWallClock(state);
    this.wire.dispatch(
      updateGoal({ status: "complete", reason, wallClockMs, actor }),
    );
  }

  private emitCompletion(
    state: GoalState,
    snapshot: GoalSnapshot,
    reason: string | undefined,
    actor: GoalActor,
  ): void {
    this.emitGoalUpdated(snapshot, {
      kind: "completion",
      status: "complete",
      reason,
      stats: this.statsOf(state),
      actor,
    });
  }

  async pauseOnInterrupt(
    input: GoalReasonInput = {},
  ): Promise<GoalSnapshot | null> {
    this.assertSupportedAgent();
    return this.pauseActiveGoal(input, "user");
  }

  async recordTokenUsage(tokenDelta: number): Promise<GoalSnapshot | null> {
    this.assertSupportedAgent();
    return this.accountTokenUsage(tokenDelta);
  }

  private accountTokenUsage(
    tokenDelta: number,
    goalId?: string,
  ): GoalSnapshot | null {
    const state = this.goalState;
    if (
      state === null ||
      state.status !== "active" ||
      !matchesGoal(state, goalId)
    )
      return null;
    const tokensUsed = state.tokensUsed + Math.max(0, tokenDelta);
    this.wire.dispatch(updateGoal({ tokensUsed }));
    const next = this.requireState();
    return this.blockIfBudgetReached(next) ?? this.toSnapshot(next);
  }

  async incrementTurn(): Promise<GoalSnapshot | null> {
    this.assertSupportedAgent();
    return this.incrementGoalTurn();
  }

  private incrementGoalTurn(goalId?: string): GoalSnapshot | null {
    const state = this.goalState;
    if (
      state === null ||
      state.status !== "active" ||
      !matchesGoal(state, goalId)
    )
      return null;
    const turnsUsed = state.turnsUsed + 1;
    this.wire.dispatch(updateGoal({ turnsUsed }));
    const next = this.requireState();
    this.emitGoalUpdated(this.toSnapshot(next));
    return this.toSnapshot(next);
  }

  private handleTurnLaunched(
    turnId: number,
    origin: TurnStartedEvent["origin"],
  ): void {
    this.liveTurnId = turnId;
    this.goalTurnTargets.delete(turnId);
    this.exhaustedTurnBudgetGoals.delete(turnId);
    if (!this.goalDrivenTurns.has(turnId)) {
      const state = this.goalState;
      const continuationGoalId = isGoalContinuationOrigin(origin)
        ? this.pendingContinuationGoals.get(turnId)
        : undefined;
      if (
        continuationGoalId !== undefined &&
        state?.goalId !== continuationGoalId
      ) {
        this.goalDrivenTurns.set(turnId, continuationGoalId);
      } else if (
        state?.status === "active" &&
        this.blockIfBudgetReached(state) === null
      ) {
        this.goalDrivenTurns.set(turnId, state.goalId);
      }
    }
    this.pendingContinuationGoals.delete(turnId);
    this.goalOutcomeToolResultTurns.delete(turnId);
    this.goalOutcomeContinuationTurns.delete(turnId);
  }

  private adoptStarterTurn(actor: GoalActor): void {
    const turnId = this.liveTurnId;
    if (turnId === undefined) return;
    const state = this.goalState;
    if (state === null || state.status !== "active") return;
    const goalId = this.goalDrivenTurns.get(turnId);
    if (actor === "model") this.goalTurnTargets.set(turnId, state.goalId);
    if (this.toSnapshot(state).budget.turnBudgetReached) {
      this.exhaustedTurnBudgetGoals.set(turnId, state.goalId);
    } else {
      this.exhaustedTurnBudgetGoals.delete(turnId);
    }
    if (goalId !== undefined) return;
    this.goalDrivenTurns.set(turnId, state.goalId);
    this.countedGoalTurns.add(turnId);
    this.goalStarterTurns.add(turnId);
  }
}

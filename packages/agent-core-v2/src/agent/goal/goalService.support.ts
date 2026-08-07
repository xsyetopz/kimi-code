/**
 * `goal` domain — goal lifecycle constants, state keys, and helpers.
 */

import { defineState } from "#/_base/state/stateRegistry";
import { defineModel } from "#/wire/wire";
import {
  ErrorCodes,
  isPlainRecord,
  toKimiErrorPayload,
  type KimiErrorPayload,
} from "#/errors";
import { LoopErrors } from "#/agent/loop/errors";
import type { EnqueueReceipt } from "#/agent/loop/loop";
import type { TurnEndedEvent, TurnStartedEvent } from "#/app/telemetry/events";
import type { ContextMessage, PromptOrigin } from "#/agent/contextMemory/types";
import type { PermissionMode } from "#/agent/permissionMode/permissionMode";
import type { ExecutableToolResult } from "#/agent/toolExecutor/toolExecutor";
import type {
  GoalBudgetLimits,
  GoalBudgetProperties,
  GoalBudgetReport,
  GoalState,
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

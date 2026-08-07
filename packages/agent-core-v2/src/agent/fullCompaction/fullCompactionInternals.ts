/**
 * `fullCompaction` domain — compaction state keys and history helpers.
 */

import { defineState } from "#/_base/state/stateRegistry";
import { estimateTokensForMessage } from "#/kosong/contract/tokens";
import { isRealUserInput } from "#/agent/contextMemory/compactionHandoff";
import type { AgentLLMRequestFinish } from "#/agent/llmRequester/llmRequester";
import type { ContextMessage } from "#/agent/contextMemory/types";
import type { Message } from "#/kosong/contract/message";
import {
  APIEmptyResponseError,
  APIStatusError,
} from "#/kosong/contract/errors";
import { inputTotal, type TokenUsage } from "#/kosong/contract/usage";
import type { CompactionFinishedEvent } from "#/app/telemetry/events";
import type { LLMRequestTrace } from "#/kosong/contract/requestTrace";
import type { FullCompactionTask } from "./fullCompaction";

export const MAX_COMPACTION_RETRY_ATTEMPTS = 5;
export const DEFAULT_COMPACTION_MAX_COMPLETION_TOKENS = 128 * 1024;
export const OVERFLOW_CONTEXT_SAFETY_RATIO = 0.85;
export const OVERFLOW_STATUS_RECOVERY_RATIO = 0.5;
export const MAX_COMPACTION_OVERFLOW_SHRINK_ATTEMPTS = 3;
export const COMPACTION_OVERFLOW_SHRINK_RATIOS = [0.7, 0.5, 0.35] as const;
export const EMPTY_TOOL_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {},
};

export const fullCompactionCompactionCountInTurnKey = defineState<number>(
  "fullCompaction.compactionCountInTurn",
  () => 0,
);
export const fullCompactionObservedMaxContextTokensByModelKey = defineState<
  Map<string, number>
>("fullCompaction.observedMaxContextTokensByModel", () => new Map());
export const fullCompactionLastCompactedTokenCountKey = defineState<
  number | null
>("fullCompaction.lastCompactedTokenCount", () => null);
export const fullCompactionConsecutiveOverflowCompactionsKey =
  defineState<number>("fullCompaction.consecutiveOverflowCompactions", () => 0);
export const fullCompactionActiveTurnIdKey = defineState<number | undefined>(
  "fullCompaction.activeTurnId",
  () => undefined as number | undefined,
);

export interface ActiveCompaction extends FullCompactionTask {
  readonly originTurnId?: number;
  trace?: LLMRequestTrace;
  blockedByTurn: boolean;
}

export interface CompactionAttemptResult {
  readonly summary: string;
  readonly usage: TokenUsage | null;
  readonly traceId?: string;
}

export class CompactionTruncatedError extends Error {
  constructor() {
    super(
      "Compaction response was truncated before producing a complete summary.",
    );
    this.name = "CompactionTruncatedError";
  }
}

type CompactionTelemetryProperties = Pick<
  CompactionFinishedEvent,
  "input_tokens" | "output_tokens" | "input_cache_read" | "input_cache_creation"
>;

export function findAPIStatusError(error: unknown): APIStatusError | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current !== undefined && current !== null && !seen.has(current)) {
    if (current instanceof APIStatusError) return current;
    seen.add(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

export function collectSummary(
  finish: AgentLLMRequestFinish,
): CompactionAttemptResult {
  if (finish.providerFinishReason === "truncated") {
    throw new CompactionTruncatedError();
  }

  const summary = finish.message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
  if (summary.length === 0) {
    throw new APIEmptyResponseError(
      "The compaction response did not contain a non-empty summary.",
    );
  }

  return { summary, usage: finish.usage, traceId: finish.traceId };
}

export function historySafeToCompact(
  current: readonly ContextMessage[],
  original: readonly ContextMessage[],
): boolean {
  if (current.length < original.length) return false;
  if (!original.every((message, index) => message === current[index]))
    return false;
  return current.slice(original.length).every(isRealUserInput);
}

export function shrinkCompactionHistoryAfterOverflow<T extends Message>(
  messages: readonly T[],
  attempt: number,
  estimateMessage: (message: T) => number = estimateTokensForMessage,
): T[] {
  if (messages.length <= 1) return messages.slice();
  const ratio =
    COMPACTION_OVERFLOW_SHRINK_RATIOS[
      Math.min(attempt - 1, COMPACTION_OVERFLOW_SHRINK_RATIOS.length - 1)
    ]!;
  let totalTokens = 0;
  for (const message of messages) totalTokens += estimateMessage(message);
  const tokenBudget = Math.floor(totalTokens * ratio);
  return takeRecentMessagesWithinTokenBudget(
    messages,
    tokenBudget,
    estimateMessage,
  );
}

function takeRecentMessagesWithinTokenBudget<T extends Message>(
  messages: readonly T[],
  tokenBudget: number,
  estimateMessage: (message: T) => number = estimateTokensForMessage,
): T[] {
  let start = messages.length;
  let tokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const messageTokens = estimateMessage(messages[i]!);
    if (tokens + messageTokens > tokenBudget) break;
    tokens += messageTokens;
    start = i;
  }
  if (start === 0) start = 1;
  return dropLeadingToolResults(messages.slice(start));
}

export function dropOldestMessageAndLeadingToolResults<
  T extends { readonly role: string },
>(messages: readonly T[]): T[] {
  if (messages.length <= 1) return messages.slice();
  return dropLeadingToolResults(messages.slice(1));
}

function dropLeadingToolResults<T extends { readonly role: string }>(
  messages: readonly T[],
): T[] {
  let start = 0;
  while (start < messages.length && messages[start]!.role === "tool") {
    start += 1;
  }
  return messages.slice(start);
}

export function usageTelemetry(
  usage: TokenUsage | null,
): CompactionTelemetryProperties {
  if (usage === null) return {};
  return {
    input_tokens: inputTotal(usage),
    output_tokens: usage.output,
    input_cache_read: usage.inputCacheRead,
    input_cache_creation: usage.inputCacheCreation,
  };
}

export function compactionCancelledReason(
  active: ActiveCompaction | null,
): Error {
  const reason = active?.abortController.signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error("Compaction cancelled.");
  error.name = "AbortError";
  return error;
}

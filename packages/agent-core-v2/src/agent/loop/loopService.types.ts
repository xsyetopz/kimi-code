/**
 * `loop` domain — loop runtime types and step/turn helpers.
 */

import { createControlledPromise } from '@antfu/utils';
import { isUserCancellation } from '#/_base/utils/abort';
import { ErrorCodes, isError2 } from '#/errors';
import { isMaxStepsExceededError } from './loop';
import type { ContentPart, StreamedMessagePart } from '#/kosong/contract/message';
import type { FinishReason } from '#/kosong/contract/provider';
import type { LoopRunResult, Step, StepResult, Turn, TurnResult } from './loop';
import type { StepRequest, TurnSeed } from './stepRequest';
import type { StepRequestQueue, StepRequestBatch } from './stepRequestQueue';
import type { TurnInterruptReason } from './turnEvents';

export function normalizeFinishReason(reason: FinishReason): string {
  if (reason === 'tool_calls') return 'tool_use';
  if (reason === 'completed') return 'end_turn';
  if (reason === 'truncated') return 'max_tokens';
  return reason;
}

type MutableTurn = {
  -readonly [K in keyof Turn]: Turn[K];
};

type MutableStep = {
  -readonly [K in keyof Step]: Step[K];
} & {
  controller?: AbortController;
  resultControl?: ReturnType<typeof createControlledPromise<StepResult>>;
};

interface TurnJob {
  readonly request: StepRequest;
  readonly seed: TurnSeed;
  readonly controller: AbortController;
  readonly ready: ReturnType<typeof createControlledPromise<void>>;
  readonly result: ReturnType<typeof createControlledPromise<TurnResult>>;
  readonly queue: StepRequestQueue;
  readonly steps: Map<string, MutableStep>;
  readonly turn: MutableTurn;
}

interface HeldAdmission {
  readonly request: StepRequest;
  readonly options?: StepEnqueueOptions;
}

interface LoopRuntime {
  readonly turnId: number;
  readonly turnSignal: AbortSignal;
  readonly job: TurnJob | undefined;
  readonly queue: StepRequestQueue;
  steps: number;
  lastStopReason: FinishReason | undefined;
  current: StepRuntime | undefined;
}

interface StepRuntime {
  readonly number: number;
  readonly uuid: string;
  readonly batch: StepRequestBatch;
  readonly mutableStep: MutableStep | undefined;
  readonly signal: AbortSignal;
}

type BeginStepResult = { readonly step: StepRuntime } | { readonly result: LoopRunResult };

interface StreamPartCollector {
  readonly handle: (part: StreamedMessagePart) => void;
  drainInterruptedContent(): ContentPart[];
}

export function cancelReasonFor(cancellation: unknown): 'user_cancelled' | 'aborted' {
  return isUserCancellation(cancellation) ? 'user_cancelled' : 'aborted';
}

export function interruptReasonFor(
  result: Extract<TurnResult, { readonly type: 'cancelled' | 'failed' }>,
): TurnInterruptReason {
  if (result.type === 'cancelled') {
    return isUserCancellation(result.reason) ? 'user_cancelled' : 'aborted';
  }
  if (isMaxStepsExceededError(result.error)) return 'max_steps';
  if (isError2(result.error) && result.error.code === ErrorCodes.PROVIDER_FILTERED) {
    return 'filtered';
  }
  return 'error';
}

type StepExecutionResult = {
  readonly stopReason: FinishReason;
  readonly hookStopTurn: boolean;
};

type LoopErrorDisposition =
  | { readonly type: 'continue' }
  | { readonly type: 'return'; readonly result: LoopRunResult };

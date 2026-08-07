/**
 * `loop` domain — `IAgentLoopService` implementation.
 *
 * Owns a FIFO of Turn jobs, each with its own `StepRequestQueue`. Admission
 * reserves a stable Turn handle immediately; the head job alone books the
 * agent's work span with the session lifecycle, records `turn.prompt`,
 * publishes `turn.started`, and drains its Steps. Ending unbooks the work span,
 * then publishes `turn.ended` and pumps the next queued Turn. Requests without
 * an active Turn remain in the Loop-owned pending-input queue and bind to the
 * next admitted Turn.
 *
 * The run drains the queue one batch per step: each batch's driver request
 * (plus any mergeable requests folded into it) materializes its context
 * messages, then one LLM step runs (`onWillBeginStep` → streamed request → content
 * parts → tool execution → `step.end` → `onDidFinishStep`). The loop itself never
 * enqueues — it only runs requests and dispatches errors. A failed step is
 * dispatched to the registered error handlers (first match wins); a handler
 * that claims and catches the error has already enqueued the turn's
 * continuation itself, so the loop only learns caught-or-not, while an
 * unclaimed or uncaught error fails the turn. Emits `turn.*` / delta
 * events through `event`, persists loop events through `contextMemory`, and
 * reads the step budget from `config`. The plain-data loop state
 * (`nextReservedTurnId`, `lastRequestTraceId`, `disposing`) is registered
 * into `agentState` (`IAgentStateService`) and read/written through it;
 * `pendingTurns` and `activeTurnJob` stay plain fields because a `lt.TurnJob`
 * holds resources (`AbortController`, controlled promises, a
 * `StepRequestQueue`) that must not be snapshotted, alongside the mechanism
 * resources (`standaloneStepQueue`, `pendingAssignments`, `errorHandlers`,
 * `settleWaiters`, `activeRequestTrace`). Bound at Agent scope.
 */

import { randomUUID } from 'node:crypto';
import { AgentLoopServiceCore } from './loopService.core';


import { createControlledPromise } from '@antfu/utils';

import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/_base/state/stateRegistry';
import { abortError, isAbortError, isUserCancellation, userCancellationReason } from '#/_base/utils/abort';
import { toErrorMessage } from '#/_base/errors/errorMessage';
import { IAgentLLMRequesterService, type AgentLLMRequestFinish } from '#/agent/llmRequester/llmRequester';
import type { LLMRequestTrace } from '#/kosong/contract/requestTrace';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import { type FinishReason } from '#/kosong/contract/provider';
import { mergeInPlace, type ContentPart, type StreamedMessagePart } from '#/kosong/contract/message';
import { type TokenUsage } from '#/kosong/contract/usage';
import { BugIndicatingError, ErrorCodes, Error2, isError2, toKimiErrorPayload } from '#/errors';
import { OrderedHookSlot } from '#/hooks';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { isVacuousContentPart } from '#/agent/contextMemory/vacuousContent';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentTelemetryContextService } from '#/app/telemetry/agentTelemetryContext';
import type {
  TurnEndedEvent as TurnEndedTelemetryEvent,
  TurnInterruptedEvent,
  TurnStartedEvent as TurnStartedTelemetryEvent,
} from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IWireService } from '#/wire/wire';
import { LOOP_CONTROL_SECTION, type LoopControl } from './configSection';
import {
  createMaxStepsExceededError,
  IAgentLoopService,
  isMaxStepsExceededError,
  type AfterStepContext,
  type AgentLoopStatus,
  type EnqueueReceipt,
  type LoopErrorContext,
  type LoopErrorHandler,
  type LoopErrorHandlerRegistrationOptions,
  type LoopRunOptions,
  type LoopRunResult,
  type Step,
  type StepEnqueueOptions,
  type StepResult,
  type Turn,
  type TurnResult,
} from './loop';
import {
  type StepRequest,
  type TurnSeed,
} from './stepRequest';
import { StepRequestQueue, type StepRequestBatch } from './stepRequestQueue';
import { isDisplayablePromptOrigin, turnPromptText, type TurnInterruptReason } from './turnEvents';
import * as lt from './loopService.types';
import { cancelTurn, endTurn, promptTurn, TurnModel } from './turnOps';

export type LoopInterruptReason = 'aborted' | 'max_steps' | 'error';

export const loopNextReservedTurnIdKey = defineState<number | undefined>(
  'loop.nextReservedTurnId',
  () => undefined as number | undefined,
);
export const loopLastRequestTraceIdKey = defineState<string | undefined>(
  'loop.lastRequestTraceId',
  () => undefined as string | undefined,
);
export const loopDisposingKey = defineState<boolean>('loop.disposing', () => false);

export class AgentLoopService extends AgentLoopServiceCore implements IAgentLoopService {
  declare readonly _serviceBrand: undefined;

  async run(options: LoopRunOptions): Promise<LoopRunResult> {
    const runtime = this.createLoopRuntime(options);
    try {
      while (true) {
        try {
          const begun = this.beginLoopStep(runtime);
          if ('result' in begun) return begun.result;
          runtime.current = begun.step;
          const result = await this.executeLoopStep(
            runtime.turnId,
            begun.step.signal,
            runtime.turnSignal,
            begun.step.number,
            begun.step.uuid,
            options.onStarted,
          );
          const completed = this.completeLoopStep(runtime, result);
          if (completed !== undefined) return completed;
        } catch (error) {
          const disposition = await this.handleLoopStepError(runtime, error);
          if (disposition.type === 'return') return disposition.result;
        }
      }
    } finally {
      runtime.queue.abortTurnScoped();
    }
  }

  private createLoopRuntime(options: LoopRunOptions): lt.LoopRuntime {
    const job = this.activeTurnJob?.turn.id === options.turnId ? this.activeTurnJob : undefined;
    return {
      turnId: options.turnId,
      turnSignal: options.signal ?? new AbortController().signal,
      job,
      queue: job?.queue ?? this.standaloneStepQueue,
      steps: 0,
      lastStopReason: undefined,
      current: undefined,
    };
  }

  private beginLoopStep(runtime: lt.LoopRuntime): lt.BeginStepResult {
    runtime.current = undefined;
    runtime.turnSignal.throwIfAborted();
    if (!runtime.queue.hasPendingRequests()) {
      return {
        result: {
          type: 'completed',
          steps: runtime.steps,
          truncated: runtime.lastStopReason === 'truncated',
        },
      };
    }
    const maxSteps = this.config.get<LoopControl>(LOOP_CONTROL_SECTION)?.maxStepsPerTurn;
    if (maxSteps !== undefined && maxSteps > 0 && runtime.steps >= maxSteps) {
      throw createMaxStepsExceededError(maxSteps);
    }
    const batch = runtime.queue.takeNextBatch()!;
    const mutableStep = runtime.job?.steps.get(batch.driver.id);
    if (mutableStep !== undefined) {
      mutableStep.state = 'running';
      mutableStep.controller = new AbortController();
      mutableStep.signal = mutableStep.controller.signal;
    }
    const step: lt.StepRuntime = {
      number: ++runtime.steps,
      uuid: randomUUID(),
      batch,
      mutableStep,
      signal: mutableStep?.controller === undefined
        ? runtime.turnSignal
        : AbortSignal.any([runtime.turnSignal, mutableStep.controller.signal]),
    };
    this.materializeBatch(batch);
    return { step };
  }

  private completeLoopStep(
    runtime: lt.LoopRuntime,
    result: lt.StepExecutionResult,
  ): LoopRunResult | undefined {
    const current = runtime.current!;
    if (current.mutableStep !== undefined) {
      current.mutableStep.state = 'completed';
      current.mutableStep.resultControl?.resolve({ type: 'completed' });
    }
    runtime.current = undefined;
    runtime.lastStopReason = result.stopReason;
    if (result.stopReason === 'filtered') {
      throw new Error2(ErrorCodes.PROVIDER_FILTERED, 'Provider safety policy blocked the response.', {
        name: 'ProviderFilteredError',
        details: { finishReason: 'filtered' },
      });
    }
    if (!result.hookStopTurn) return undefined;
    return { type: 'completed', steps: runtime.steps, truncated: result.stopReason === 'truncated' };
  }

  private async handleLoopStepError(
    runtime: lt.LoopRuntime,
    error: unknown,
  ): Promise<lt.LoopErrorDisposition> {
    const cancellation = this.handleLoopCancellation(runtime, error);
    if (cancellation !== undefined) return cancellation;
    const recovery = await this.tryRecoverLoopError(runtime, error);
    return recovery ?? this.failLoopStep(runtime, error);
  }

  private handleLoopCancellation(
    runtime: lt.LoopRuntime,
    error: unknown,
  ): lt.LoopErrorDisposition | undefined {
    const step = runtime.current?.mutableStep;
    if (!isAbortError(error) && !runtime.turnSignal.aborted && step?.signal.aborted !== true) return undefined;
    const reason = runtime.turnSignal.reason ?? step?.signal.reason ?? error;
    this.emitStepInterrupted(
      runtime.turnId,
      runtime.current?.number,
      'aborted',
      isUserCancellation(reason) ? undefined : toErrorMessage(reason),
    );
    if (!runtime.turnSignal.aborted && step?.state === 'cancelled') {
      runtime.current = undefined;
      return { type: 'continue' };
    }
    return { type: 'return', result: { type: 'cancelled', reason, steps: runtime.steps } };
  }

  private async tryRecoverLoopError(
    runtime: lt.LoopRuntime,
    error: unknown,
  ): Promise<lt.LoopErrorDisposition | undefined> {
    const current = runtime.current;
    const context: LoopErrorContext = {
      currentStep: current?.mutableStep,
      turnId: runtime.turnId,
      step: current?.number,
      stepId: current?.uuid,
      signal: runtime.turnSignal,
      error,
      failedDriver: current?.batch.driver,
      retry: (request, options) => {
        if (runtime.job !== undefined) return this.enqueueStep(runtime.job, request, options);
        runtime.queue.enqueue(request, options?.at ?? 'tail');
        return current?.mutableStep ?? {
          id: request.id,
          turnId: runtime.turnId,
          state: 'queued',
          signal: runtime.turnSignal,
          result: Promise.resolve({ type: 'completed' }),
          cancel: () => request.abort(),
        };
      },
    };
    const handler = this.errorHandlers.find((entry) => entry.match(context));
    if (handler === undefined) return undefined;
    try {
      if (await handler.handle(context)) {
        runtime.current = undefined;
        return { type: 'continue' };
      }
      return undefined;
    } catch (handlerError) {
      return this.handleLoopCancellation(runtime, handlerError) ?? this.failLoopStep(runtime, handlerError);
    }
  }

  private failLoopStep(runtime: lt.LoopRuntime, error: unknown): lt.LoopErrorDisposition {
    const reason: LoopInterruptReason = isMaxStepsExceededError(error) ? 'max_steps' : 'error';
    const interruptedError =
      isError2(error) && error.code === ErrorCodes.INTERNAL && error.cause !== undefined ? error.cause : error;
    this.emitStepInterrupted(runtime.turnId, runtime.current?.number, reason, toErrorMessage(interruptedError));
    return { type: 'return', result: { type: 'failed', error, steps: runtime.steps } };
  }

  private materializeBatch(batch: StepRequestBatch): void {
    this.materializeRequest(batch.driver);
    for (const request of batch.merged) {
      this.materializeRequest(request);
    }
  }

  private materializeRequest(request: StepRequest): void {
    if (request.state !== 'pending') return;
    request.onWillMaterialize();
    const messages = request.resolveContextMessages();
    if (messages.length > 0) {
      this.context.append(...messages);
    }
    request.markMaterialized();
  }

  private async executeLoopStep(
    turnId: number,
    signal: AbortSignal,
    turnSignal: AbortSignal,
    currentStep: number,
    stepUuid: string,
    onStarted: ((step: number) => void) | undefined,
  ): Promise<lt.StepExecutionResult> {
    this.activeRequestTrace = undefined;
    await this.hooks.onWillBeginStep.run({ turnId, step: currentStep, signal });
    const markStepStarted = this.beginStep(turnId, signal, currentStep, stepUuid, onStarted);
    const streamParts = this.createStreamPartHandler(turnId, markStepStarted);
    const request = this.llmRequester.start(
      { source: { type: 'turn', turnId, step: currentStep } },
      streamParts.handle,
      signal,
    );
    this.activeRequestTrace = request.trace;
    let response: AgentLLMRequestFinish;
    try {
      response = await request.result;
    } catch (error) {
      this.appendInterruptedStreamContent(turnId, currentStep, stepUuid, streamParts, turnSignal);
      throw error;
    }
    this.lastRequestTraceId = request.trace.traceId;
    this.appendResponseContent(turnId, currentStep, stepUuid, response);
    const finishReason = await this.executeStepTools(
      turnId,
      signal,
      currentStep,
      stepUuid,
      response,
      request.trace,
    );
    this.finishStep(turnId, signal, currentStep, stepUuid, response, finishReason, markStepStarted);
    const hookStopTurn = await this.runAfterStep(
      turnId,
      signal,
      currentStep,
      response.usage,
      finishReason,
    );
    return { stopReason: finishReason, hookStopTurn };
  }

  private beginStep(
    turnId: number,
    signal: AbortSignal,
    currentStep: number,
    stepUuid: string,
    onStarted: ((step: number) => void) | undefined,
  ): () => void {
    signal.throwIfAborted();
    this.eventBus.publish({ type: 'turn.step.started', turnId, step: currentStep, stepId: stepUuid });
    this.context.appendLoopEvent({
      type: 'step.begin',
      uuid: stepUuid,
      turnId: String(turnId),
      step: currentStep,
    });
    let stepStarted = false;
    return () => {
      if (stepStarted) return;
      stepStarted = true;
      onStarted?.(currentStep);
    };
  }

  private appendResponseContent(
    turnId: number,
    currentStep: number,
    stepUuid: string,
    response: AgentLLMRequestFinish,
  ): void {
    for (const part of response.message.content) {
      this.context.appendLoopEvent({
        type: 'content.part',
        uuid: randomUUID(),
        turnId: String(turnId),
        step: currentStep,
        stepUuid,
        part,
      });
    }
  }

  private appendInterruptedStreamContent(
    turnId: number,
    currentStep: number,
    stepUuid: string,
    streamParts: lt.StreamPartCollector,
    turnSignal: AbortSignal,
  ): void {
    if (!turnSignal.aborted) return;
    for (const part of streamParts.drainInterruptedContent()) {
      this.context.appendLoopEvent({
        type: 'content.part',
        uuid: randomUUID(),
        turnId: String(turnId),
        step: currentStep,
        stepUuid,
        part,
      });
    }
  }

  private async executeStepTools(
    turnId: number,
    signal: AbortSignal,
    currentStep: number,
    stepUuid: string,
    response: AgentLLMRequestFinish,
    trace: LLMRequestTrace,
  ): Promise<FinishReason> {
    let finishReason = response.providerFinishReason ?? 'completed';
    if (response.message.toolCalls.length === 0) {
      return finishReason === 'tool_calls' ? 'other' : finishReason;
    }
    const toolCallUuids = new Map<string, string>();
    let stopTurn = false;
    for await (const toolResult of this.toolExecutor.execute(response.message.toolCalls, {
      signal,
      turnId,
      trace,
      onToolCall: ({ toolCallId, name, args }) => {
        const callUuid = randomUUID();
        toolCallUuids.set(toolCallId, callUuid);
        this.context.appendLoopEvent({
          type: 'tool.call',
          uuid: callUuid,
          turnId: String(turnId),
          step: currentStep,
          stepUuid,
          toolCallId,
          name,
          args,
        });
      },
    })) {
      const { result } = toolResult;
      this.context.appendLoopEvent({
        type: 'tool.result',
        parentUuid: toolCallUuids.get(toolResult.toolCallId) ?? randomUUID(),
        toolCallId: toolResult.toolCallId,
        result: { output: result.output, isError: result.isError, note: result.note },
      });
      if (result.stopTurn === true) stopTurn = true;
    }
    finishReason = stopTurn ? 'completed' : 'tool_calls';
    return finishReason;
  }

  private finishStep(
    turnId: number,
    signal: AbortSignal,
    currentStep: number,
    stepUuid: string,
    response: AgentLLMRequestFinish,
    finishReason: FinishReason,
    markStepStarted: () => void,
  ): void {
    signal.throwIfAborted();
    markStepStarted();
    const timing = response.timing;
    const stepFinishReason = lt.normalizeFinishReason(finishReason);
    this.context.appendLoopEvent({
      type: 'step.end',
      uuid: stepUuid,
      turnId: String(turnId),
      step: currentStep,
      finishReason: stepFinishReason,
      usage: response.usage,
      llmFirstTokenLatencyMs: timing?.firstTokenLatencyMs,
      llmStreamDurationMs: timing?.streamDurationMs,
      llmRequestBuildMs: timing?.requestBuildMs,
      llmServerFirstTokenMs: timing?.serverFirstTokenMs,
      llmServerDecodeMs: timing?.serverDecodeMs,
      llmClientConsumeMs: timing?.clientConsumeMs,
      messageId: response.providerMessageId,
      providerFinishReason: response.providerFinishReason,
      rawFinishReason: response.rawFinishReason,
    });
    this.emitStepCompleted(
      turnId,
      currentStep,
      stepUuid,
      response.usage,
      stepFinishReason,
      response,
    );
  }

  private async runAfterStep(
    turnId: number,
    signal: AbortSignal,
    currentStep: number,
    usage: TokenUsage,
    finishReason: FinishReason,
  ): Promise<boolean> {
    const context: AfterStepContext = {
      turnId,
      step: currentStep,
      signal,
      usage,
      finishReason,
      stopTurn: false,
    };
    try {
      await this.hooks.onDidFinishStep.run(context);
    } catch (error) {
      if (isAbortError(error) || signal.aborted) throw error;
    }
    return context.stopTurn;
  }

  private emitStepCompleted(
    turnId: number,
    step: number,
    stepId: string,
    usage: TokenUsage,
    finishReason: string,
    response: AgentLLMRequestFinish,
  ): void {
    this.eventBus.publish({
      type: 'turn.step.completed',
      turnId,
      step,
      stepId,
      usage,
      finishReason,
      llmFirstTokenLatencyMs: response.timing?.firstTokenLatencyMs,
      llmStreamDurationMs: response.timing?.streamDurationMs,
      llmRequestBuildMs: response.timing?.requestBuildMs,
      llmServerFirstTokenMs: response.timing?.serverFirstTokenMs,
      llmServerDecodeMs: response.timing?.serverDecodeMs,
      llmClientConsumeMs: response.timing?.clientConsumeMs,
      providerFinishReason: response.providerFinishReason,
      rawFinishReason: response.rawFinishReason,
    });
  }

  private emitStepInterrupted(
    turnId: number,
    activeStep: number | undefined,
    reason: LoopInterruptReason,
    message?: string,
  ): void {
    if (activeStep === undefined) return;
    this.eventBus.publish({
      type: 'turn.step.interrupted',
      turnId,
      step: activeStep,
      reason,
      message,
    });
  }

  private createStreamPartHandler(
    turnId: number,
    onResponseEvent: () => void,
  ): lt.StreamPartCollector {
    const callsByIndex = new Map<number | string | undefined, { id: string; name: string }>();
    const partialContent: ContentPart[] = [];
    let forceContentPartBoundary = false;
    const accumulate = (part: ContentPart): void => {
      const last = partialContent.at(-1);
      if (!forceContentPartBoundary && last !== undefined && mergeInPlace(last, part)) return;
      forceContentPartBoundary = false;
      partialContent.push({ ...part });
    };

    return {
      handle: (part) => {
        switch (part.type) {
          case 'text':
            onResponseEvent();
            accumulate(part);
            this.eventBus.publish({ type: 'assistant.delta', turnId, delta: part.text });
            return;
          case 'think':
            onResponseEvent();
            accumulate(part);
            this.eventBus.publish({ type: 'thinking.delta', turnId, delta: part.think });
            return;
          case 'image_url':
          case 'audio_url':
          case 'video_url':
            return;
          case 'function': {
            onResponseEvent();
            forceContentPartBoundary = true;
            callsByIndex.set(part._streamIndex, { id: part.id, name: part.name });
            this.eventBus.publish({
              type: 'tool.call.delta',
              turnId,
              toolCallId: part.id,
              name: part.name,
              argumentsPart: part.arguments ?? undefined,
            });
            return;
          }
          case 'tool_call_part': {
            if (part.argumentsPart === null) return;
            const toolCall = callsByIndex.get(part.index);
            if (toolCall === undefined) return;
            onResponseEvent();
            this.eventBus.publish({
              type: 'tool.call.delta',
              turnId,
              toolCallId: toolCall.id,
              name: toolCall.name,
              argumentsPart: part.argumentsPart,
            });
            return;
          }
          default: {
            const _exhaustive: never = part;
            return _exhaustive;
          }
        }
      },
      drainInterruptedContent: () =>
        partialContent.splice(0).filter((part) => !isVacuousContentPart(part)),
    };
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentLoopService,
  AgentLoopService,
  ScopeActivation.OnScopeCreated,
  'loop',
);

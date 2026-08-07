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

import { randomUUID } from "node:crypto";

import { createControlledPromise } from "@antfu/utils";

import {
  Disposable,
  toDisposable,
  type IDisposable,
} from "#/_base/di/lifecycle";
import {
  LifecycleScope,
  ScopeActivation,
  registerScopedService,
} from "#/_base/di/scope";
import { defineState } from "#/_base/state/stateRegistry";
import {
  abortError,
  isAbortError,
  isUserCancellation,
  userCancellationReason,
} from "#/_base/utils/abort";
import { toErrorMessage } from "#/_base/errors/errorMessage";
import {
  IAgentLLMRequesterService,
  type AgentLLMRequestFinish,
} from "#/agent/llmRequester/llmRequester";
import type { LLMRequestTrace } from "#/kosong/contract/requestTrace";
import { IAgentToolExecutorService } from "#/agent/toolExecutor/toolExecutor";
import { IConfigService } from "#/app/config/config";
import { IEventBus } from "#/app/event/eventBus";
import { type FinishReason } from "#/kosong/contract/provider";
import {
  mergeInPlace,
  type ContentPart,
  type StreamedMessagePart,
} from "#/kosong/contract/message";
import { type TokenUsage } from "#/kosong/contract/usage";
import {
  BugIndicatingError,
  ErrorCodes,
  Error2,
  isError2,
  toKimiErrorPayload,
} from "#/errors";
import { OrderedHookSlot } from "#/hooks";

import { IAgentContextMemoryService } from "#/agent/contextMemory/contextMemory";
import { isVacuousContentPart } from "#/agent/contextMemory/vacuousContent";
import { IAgentStateService } from "#/agent/state/agentState";
import { IAgentTelemetryContextService } from "#/app/telemetry/agentTelemetryContext";
import type {
  TurnEndedEvent as TurnEndedTelemetryEvent,
  TurnInterruptedEvent,
  TurnStartedEvent as TurnStartedTelemetryEvent,
} from "#/app/telemetry/events";
import { ITelemetryService } from "#/app/telemetry/telemetry";
import { IWireService } from "#/wire/wire";
import { LOOP_CONTROL_SECTION, type LoopControl } from "./configSection";
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
} from "./loop";
import { type StepRequest, type TurnSeed } from "./stepRequest";
import { StepRequestQueue, type StepRequestBatch } from "./stepRequestQueue";
import {
  isDisplayablePromptOrigin,
  turnPromptText,
  type TurnInterruptReason,
} from "./turnEvents";
import * as lt from "./loopService.types";
import { cancelTurn, endTurn, promptTurn, TurnModel } from "./turnOps";

export type LoopInterruptReason = "aborted" | "max_steps" | "error";

export const loopNextReservedTurnIdKey = defineState<number | undefined>(
  "loop.nextReservedTurnId",
  () => undefined as number | undefined,
);
export const loopLastRequestTraceIdKey = defineState<string | undefined>(
  "loop.lastRequestTraceId",
  () => undefined as string | undefined,
);
export const loopDisposingKey = defineState<boolean>(
  "loop.disposing",
  () => false,
);

export class AgentLoopServiceCore
  extends Disposable
  implements IAgentLoopService
{
  declare readonly _serviceBrand: undefined;

  readonly hooks: IAgentLoopService["hooks"] = {
    onWillBeginStep: new OrderedHookSlot(),
    onDidFinishStep: new OrderedHookSlot(),
  };

  private readonly standaloneStepQueue = new StepRequestQueue();
  private readonly pendingAssignments = new Map<
    StepRequest,
    ReturnType<typeof createControlledPromise<import("./loop").StepAssignment>>
  >();
  private readonly errorHandlers: LoopErrorHandler[] = [];
  private readonly pendingTurns: lt.TurnJob[] = [];
  private readonly heldAdmissions: lt.HeldAdmission[] = [];
  private activeTurnJob: lt.TurnJob | undefined;
  private readonly settleWaiters: Array<() => void> = [];
  private quiescenceDepth = 0;
  private activeRequestTrace: LLMRequestTrace | undefined;

  constructor(
    @IAgentContextMemoryService
    private readonly context: IAgentContextMemoryService,
    @IAgentLLMRequesterService
    private readonly llmRequester: IAgentLLMRequesterService,
    @IEventBus private readonly eventBus: IEventBus,
    @IAgentToolExecutorService
    private readonly toolExecutor: IAgentToolExecutorService,
    @IConfigService private readonly config: IConfigService,
    @IWireService private readonly wire: IWireService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentTelemetryContextService
    private readonly telemetryContext: IAgentTelemetryContextService,
    @IAgentStateService private readonly states: IAgentStateService,
  ) {
    super();
    this.states.register(loopNextReservedTurnIdKey);
    this.states.register(loopLastRequestTraceIdKey);
    this.states.register(loopDisposingKey);
  }

  private get nextReservedTurnId(): number | undefined {
    return this.states.get(loopNextReservedTurnIdKey);
  }

  private set nextReservedTurnId(value: number | undefined) {
    this.states.set(loopNextReservedTurnIdKey, value);
  }

  private get lastRequestTraceId(): string | undefined {
    return this.states.get(loopLastRequestTraceIdKey);
  }

  private set lastRequestTraceId(value: string | undefined) {
    this.states.set(loopLastRequestTraceIdKey, value);
  }

  private get disposing(): boolean {
    return this.states.get(loopDisposingKey);
  }

  private set disposing(value: boolean) {
    this.states.set(loopDisposingKey, value);
  }

  override dispose(): void {
    if (this.disposing) return;
    this.disposing = true;
    const reason = abortError("Agent loop disposed");
    for (const job of this.pendingTurns.slice())
      this.cancel(job.turn.id, reason);
    this.activeTurnJob?.turn.cancel(reason);
    for (const request of this.standaloneStepQueue.drain()) {
      request.abort();
      this.rejectAssignment(request, reason);
    }
    for (const { request } of this.heldAdmissions.splice(0)) {
      request.abort();
      this.rejectAssignment(request, reason);
    }
    this.maybeSettle();
    super.dispose();
  }

  enqueue(request: StepRequest, options?: StepEnqueueOptions): EnqueueReceipt {
    if (this.disposing) throw abortError("Agent loop disposed");
    const assignment =
      createControlledPromise<import("./loop").StepAssignment>();
    void assignment.catch(() => undefined);
    this.pendingAssignments.set(request, assignment);

    if (this.quiescenceDepth > 0) {
      this.heldAdmissions.push({ request, options });
    } else {
      this.admit(request, options);
    }
    return {
      assigned: assignment,
      abort: (reason) => this.abortRequest(request, reason),
    };
  }

  private admit(request: StepRequest, options?: StepEnqueueOptions): void {
    const active = this.activeTurnJob;
    switch (request.admission) {
      case "newTurn":
        this.createAndQueueTurn(request);
        break;
      case "activeOrNewTurn":
        if (active === undefined) this.createAndQueueTurn(request);
        else this.assignStep(active, request, options);
        break;
      case "activeOrNextTurn":
        if (active === undefined)
          this.standaloneStepQueue.enqueue(request, options?.at ?? "tail");
        else this.assignStep(active, request, options);
        break;
      case "activeTurnOnly":
        if (active === undefined) {
          const error = new BugIndicatingError(
            `Step request "${request.kind}" requires an active turn`,
          );
          this.rejectAssignment(request, error);
          throw error;
        }
        this.assignStep(active, request, options);
        break;
    }
  }

  private createAndQueueTurn(request: StepRequest): void {
    const seed = request.turnSeed;
    if (seed === undefined) {
      const error = new BugIndicatingError(
        `Step request "${request.kind}" cannot start a turn without turnSeed`,
      );
      this.rejectAssignment(request, error);
      throw error;
    }
    const job = this.createPendingTurn(request, seed);
    this.pendingTurns.push(job);
    this.pumpTurns();
  }

  status(): AgentLoopStatus {
    return {
      state: this.activeTurnJob === undefined ? "idle" : "running",
      activeTurnId: this.activeTurnJob?.turn.id,
      pendingTurnIds: this.pendingTurns.map((job) => job.turn.id),
      hasPendingRequests: this.hasPendingRequests(),
      activeTraceId: this.activeRequestTrace?.traceId,
    };
  }

  cancel(turnId?: number, reason?: unknown): boolean {
    const cancellation = reason ?? userCancellationReason();
    return (
      this.cancelActiveTurn(turnId, cancellation) ||
      (turnId !== undefined && this.cancelQueuedTurn(turnId, cancellation))
    );
  }

  tryAcquireQuiescence(): IDisposable | undefined {
    if (this.disposing) throw abortError("Agent loop disposed");
    if (this.activeTurnJob !== undefined || this.hasPendingRequests())
      return undefined;
    this.quiescenceDepth += 1;
    return toDisposable(() => this.releaseQuiescence());
  }

  private releaseQuiescence(): void {
    if (this.quiescenceDepth === 0) return;
    this.quiescenceDepth -= 1;
    if (this.quiescenceDepth > 0 || this.disposing) return;
    this.pumpTurns();
    for (const admission of this.heldAdmissions.splice(0)) {
      if (admission.request.aborted) continue;
      try {
        this.admit(admission.request, admission.options);
      } catch (error) {
        admission.request.abort();
        this.rejectAssignment(admission.request, error);
      }
    }
    this.pumpTurns();
  }

  private cancelActiveTurn(
    turnId: number | undefined,
    cancellation: unknown,
  ): boolean {
    const job = this.activeTurnJob;
    if (job === undefined || (turnId !== undefined && job.turn.id !== turnId))
      return false;
    if (job.controller.signal.aborted) return true;
    this.wire.dispatch(
      cancelTurn({
        turnId: job.turn.id,
        target: "active",
        reason: lt.cancelReasonFor(cancellation),
      }),
    );
    job.controller.abort(cancellation);
    return true;
  }

  private cancelQueuedTurn(turnId: number, cancellation: unknown): boolean {
    const index = this.pendingTurns.findIndex((job) => job.turn.id === turnId);
    if (index < 0) return false;
    const [job] = this.pendingTurns.splice(index, 1);
    if (job === undefined || job.turn.state !== "queued") return false;
    this.wire.dispatch(
      cancelTurn({
        turnId,
        target: "queued",
        reason: lt.cancelReasonFor(cancellation),
      }),
    );
    for (const step of job.steps.values()) step.cancel(cancellation);
    job.controller.abort(cancellation);
    job.turn.state = "cancelled";
    job.ready.reject(
      cancellation instanceof Error
        ? cancellation
        : abortError("Turn cancelled"),
    );
    job.result.resolve({ type: "cancelled", steps: 0, reason: cancellation });
    this.maybeSettle();
    return true;
  }

  hasPendingRequests(): boolean {
    return (
      this.activeTurnJob?.queue.hasPendingRequests() === true ||
      this.standaloneStepQueue.hasPendingRequests() ||
      this.pendingTurns.length > 0 ||
      this.heldAdmissions.some(({ request }) => !request.aborted)
    );
  }

  settled(): Promise<void> {
    if (
      this.activeTurnJob === undefined &&
      this.pendingTurns.length === 0 &&
      this.heldAdmissions.length === 0
    ) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.settleWaiters.push(resolve);
    });
  }

  private maybeSettle(): void {
    if (
      this.activeTurnJob !== undefined ||
      this.pendingTurns.length > 0 ||
      this.heldAdmissions.length > 0
    )
      return;
    if (this.settleWaiters.length === 0) return;
    const waiters = this.settleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  private createPendingTurn(request: StepRequest, seed: TurnSeed): lt.TurnJob {
    const id = this.reserveTurnId();
    const controller = new AbortController();
    const ready = createControlledPromise<void>();
    const result = createControlledPromise<TurnResult>();
    const queue = new StepRequestQueue();
    const steps = new Map<string, lt.MutableStep>();
    void ready.catch(() => undefined);
    const turn: lt.MutableTurn = {
      id,
      state: "queued",
      signal: controller.signal,
      ready,
      result,
      cancel: (reason) => this.cancel(id, reason),
    };
    const job = {
      request,
      seed,
      controller,
      ready,
      result,
      queue,
      steps,
      turn,
    };
    this.assignStep(job, request);
    this.moveStandaloneStepsTo(job);
    return job;
  }

  private reserveTurnId(): number {
    const modelNextId = this.wire.getModel(TurnModel).nextTurnId;
    const id = Math.max(modelNextId, this.nextReservedTurnId ?? modelNextId);
    this.nextReservedTurnId = id + 1;
    return id;
  }

  private moveStandaloneStepsTo(job: lt.TurnJob): void {
    for (const pending of this.standaloneStepQueue.drain()) {
      if (!pending.aborted) this.assignStep(job, pending);
    }
  }

  private assignStep(
    job: lt.TurnJob,
    request: StepRequest,
    options?: StepEnqueueOptions,
  ): Step {
    const step = this.enqueueStep(job, request, options);
    const assignment = this.pendingAssignments.get(request);
    assignment?.resolve({ turn: job.turn, step });
    this.pendingAssignments.delete(request);
    return step;
  }

  private rejectAssignment(request: StepRequest, reason: unknown): void {
    const assignment = this.pendingAssignments.get(request);
    assignment?.reject(
      reason instanceof Error ? reason : abortError("Step request aborted"),
    );
    this.pendingAssignments.delete(request);
  }

  private abortRequest(request: StepRequest, reason?: unknown): boolean {
    const heldIndex = this.heldAdmissions.findIndex(
      (entry) => entry.request === request,
    );
    if (heldIndex >= 0) {
      this.heldAdmissions.splice(heldIndex, 1);
      if (!request.abort()) return false;
      this.rejectAssignment(request, reason ?? userCancellationReason());
      this.maybeSettle();
      return true;
    }
    for (const job of [this.activeTurnJob, ...this.pendingTurns]) {
      if (job === undefined) continue;
      if (job.turn.state === "queued" && job.request === request) {
        return this.cancel(job.turn.id, reason);
      }
      const step = job.steps.get(request.id);
      if (step !== undefined) return step.cancel(reason);
    }
    if (!request.abort()) return false;
    this.rejectAssignment(request, reason ?? userCancellationReason());
    return true;
  }

  private enqueueStep(
    job: lt.TurnJob,
    request: StepRequest,
    options?: StepEnqueueOptions,
  ): Step {
    const existing = job.steps.get(request.id);
    if (existing !== undefined && existing.state !== "cancelled") {
      job.queue.enqueue(request, options?.at ?? "tail");
      existing.state = "queued";
      return existing;
    }
    const controller = new AbortController();
    const result = createControlledPromise<StepResult>();
    const step: lt.MutableStep = {
      id: request.id,
      turnId: job.turn.id,
      state: "queued",
      signal: controller.signal,
      result,
      controller,
      resultControl: result,
      cancel: (reason) => this.cancelStep(job, step, request, reason),
    };
    job.steps.set(step.id, step);
    job.queue.enqueue(request, options?.at ?? "tail");
    return step;
  }

  private cancelStep(
    job: lt.TurnJob,
    step: lt.MutableStep,
    request: StepRequest,
    reason?: unknown,
  ): boolean {
    if (
      step.state === "completed" ||
      step.state === "failed" ||
      step.state === "cancelled"
    )
      return false;
    const cancellation = reason ?? userCancellationReason();
    step.state = "cancelled";
    request.abort();
    step.controller?.abort(cancellation);
    step.resultControl?.resolve({ type: "cancelled", reason: cancellation });
    return true;
  }

  private pumpTurns(): void {
    if (
      this.disposing ||
      this.quiescenceDepth > 0 ||
      this.activeTurnJob !== undefined
    )
      return;
    const job = this.pendingTurns.shift();
    if (job === undefined) {
      this.maybeSettle();
      return;
    }
    this.startTurn(job);
  }

  private startTurn(job: lt.TurnJob): void {
    const origin = job.seed.origin;
    this.wire.dispatch(promptTurn({ input: job.seed.input, origin }));
    job.turn.state = "running";
    this.activeTurnJob = job;
    this.eventBus.publish({
      type: "turn.started",
      turnId: job.turn.id,
      origin,
      prompt: isDisplayablePromptOrigin(origin)
        ? turnPromptText(job.seed.input)
        : undefined,
    });
    void this.runTurn(job.turn, job.ready).then(
      job.result.resolve,
      job.result.reject,
    );
  }

  private async runTurn(
    turn: Turn,
    ready: ReturnType<typeof createControlledPromise<void>>,
  ): Promise<TurnResult> {
    const startedAt = Date.now();
    this.telemetryContext.set({ turn_id: turn.id });
    const telemetryContext = this.telemetryContext.get();
    const turnTelemetry = this.telemetry.withContext(telemetryContext);
    const { mode, provider_type, protocol } = telemetryContext;
    let thinkingEffort: string | undefined;
    let result: TurnResult | undefined;
    try {
      thinkingEffort = this.llmRequester.prepareTurnConfig(
        turn.id,
      )?.thinkingEffort;
      const started: TurnStartedTelemetryEvent = {
        turn_id: turn.id,
        mode,
        provider_type,
        protocol,
        thinking_effort: thinkingEffort,
      };
      turnTelemetry.track2("turn_started", started);
      result = await this.run({
        turnId: turn.id,
        signal: turn.signal,
        onStarted: () => ready.resolve(),
      });
      return result;
    } catch (error) {
      result = this.resultFromTurnError(turn, error);
      return result;
    } finally {
      this.settleTurnReady(ready, result);
      this.releaseActiveTurn(turn, result);
      const traceId =
        result?.type === "completed"
          ? this.lastRequestTraceId
          : this.activeRequestTrace?.traceId;
      if (result !== undefined) {
        const error =
          result.type === "failed"
            ? toKimiErrorPayload(result.error)
            : undefined;
        const interruptReason =
          result.type === "completed"
            ? undefined
            : lt.interruptReasonFor(result);
        const durationMs = Date.now() - startedAt;
        this.wire.dispatch(
          endTurn({ turnId: turn.id, reason: result.type, error, durationMs }),
        );
        this.eventBus.publish({
          type: "turn.ended",
          turnId: turn.id,
          reason: result.type,
          error,
          durationMs,
          interruptReason,
        });
        if (error !== undefined)
          this.eventBus.publish({ type: "error", ...error });
        if (interruptReason !== undefined) {
          const interrupted: TurnInterruptedEvent = {
            turn_id: turn.id,
            at_step: result.steps,
            mode,
            interrupt_reason: interruptReason,
            provider_type,
            protocol,
            thinking_effort: thinkingEffort,
            trace_id: traceId,
          };
          turnTelemetry.track2("turn_interrupted", interrupted);
        }
      }
      const ended: TurnEndedTelemetryEvent = {
        turn_id: turn.id,
        reason: result?.type ?? "failed",
        duration_ms: Date.now() - startedAt,
        mode,
        provider_type,
        protocol,
        thinking_effort: thinkingEffort,
        trace_id: traceId,
      };
      turnTelemetry.track2("turn_ended", ended);
      this.activeRequestTrace = undefined;
      this.lastRequestTraceId = undefined;
      this.pumpTurns();
    }
  }

  private resultFromTurnError(turn: Turn, error: unknown): TurnResult {
    const signal = turn.signal;
    if (!signal?.aborted) return { type: "failed", error, steps: 0 };
    return { type: "cancelled", steps: 0, reason: signal.reason ?? error };
  }

  private settleTurnReady(
    ready: ReturnType<typeof createControlledPromise<void>>,
    result: TurnResult | undefined,
  ): void {
    if (result?.type === "failed") {
      ready.reject(result.error);
    } else if (result?.type === "cancelled") {
      ready.reject(
        result.reason instanceof Error
          ? result.reason
          : abortError("Turn cancelled"),
      );
    } else {
      ready.reject(
        new Error2(ErrorCodes.INTERNAL, "Turn ended before first step"),
      );
    }
  }

  private releaseActiveTurn(turn: Turn, result: TurnResult | undefined): void {
    (turn as lt.MutableTurn).state = result?.type ?? "failed";
    const job =
      this.activeTurnJob?.turn === turn ? this.activeTurnJob : undefined;
    if (job === undefined) return;
    const reason =
      result?.type === "cancelled" ? result.reason : abortError("Turn ended");
    for (const step of job.steps.values()) {
      if (step.state === "queued" || step.state === "running")
        step.cancel(reason);
    }
    this.activeTurnJob = undefined;
    this.maybeSettle();
  }

  registerLoopErrorHandler(
    handler: LoopErrorHandler,
    options: LoopErrorHandlerRegistrationOptions = {},
  ): IDisposable {
    if (options.before !== undefined && options.after !== undefined) {
      throw new BugIndicatingError(
        "Loop error handler registration cannot specify both before and after",
      );
    }
    this.deleteErrorHandler(handler.id);
    const target = options.before ?? options.after;
    if (target === undefined) {
      this.errorHandlers.push(handler);
    } else {
      const targetIndex = this.errorHandlers.findIndex(
        (entry) => entry.id === target,
      );
      if (targetIndex < 0) {
        throw new BugIndicatingError(
          `Loop error handler target "${target}" is not registered`,
        );
      }
      const insertAt =
        options.before !== undefined ? targetIndex : targetIndex + 1;
      this.errorHandlers.splice(insertAt, 0, handler);
    }
    return toDisposable(() => {
      this.deleteErrorHandler(handler.id);
    });
  }

  private deleteErrorHandler(id: string): boolean {
    const index = this.errorHandlers.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    this.errorHandlers.splice(index, 1);
    return true;
  }
}

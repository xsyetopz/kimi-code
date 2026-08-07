import type { StepHeader, TranscriptFrame, TranscriptOperation, TurnHeader } from "@moonshot-ai/transcript";
import { mapTurnEndState, mapTurnOrigin, nowIso } from "./projectorMappings";
import type { OpenTextFrame, ProjectorLookups, ToolFrameRecord } from "./projectorTypes";

export abstract class ProjectorTurnFrames {
  protected currentTurn: TurnHeader | undefined;
  protected currentStep: StepHeader | undefined;
  protected readonly stepOrdinals = new Map<string, number>();
  protected frameOrdinal = 0;
  protected openText: OpenTextFrame | undefined;
  protected openThinking: OpenTextFrame | undefined;
  protected readonly lookups?: ProjectorLookups;

  constructor(lookups?: ProjectorLookups) {
    this.lookups = lookups;
  }

  protected onTurnStarted(event: {
    turnId: number;
    origin: unknown;
    prompt?: string;
  }): TranscriptOperation[] {
    const n = event.turnId;
    const turnId = `t${n}`;
    this.currentTurn = {
      kind: "turn",
      turnId,
      ordinal: n,
      state: "running",
      origin: mapTurnOrigin(event.origin),
      prompt: event.prompt,
      startedAt: nowIso(),
    };
    this.currentStep = undefined;
    this.openText = undefined;
    this.openThinking = undefined;
    return [{ op: "turn.upsert", turn: this.currentTurn }];
  }

  protected onTurnEnded(event: {
    turnId: number;
    reason: "completed" | "cancelled" | "failed" | "blocked";
    error?: { message: string };
    durationMs?: number;
    interruptReason?: string;
  }): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [];
    this.flushOpenFrames(ops);
    const turnId = `t${event.turnId}`;
    // Defensive: a step left running is closed with the turn (the normal path
    // closes it via `turn.step.completed` / `turn.step.interrupted` first).
    if (
      this.currentStep !== undefined &&
      this.currentStep.state === "running"
    ) {
      const step: StepHeader = {
        ...this.currentStep,
        state: "interrupted",
        endedAt: nowIso(),
      };
      this.currentStep = step;
      ops.push({ op: "step.upsert", turnId: step.turnId, step });
    }
    const prev =
      this.currentTurn?.turnId === turnId ? this.currentTurn : undefined;
    const state = mapTurnEndState(event.reason);
    this.currentTurn = {
      kind: "turn",
      turnId,
      ordinal: event.turnId,
      state,
      origin: prev?.origin ?? { kind: "other" },
      prompt: prev?.prompt,
      startedAt: prev?.startedAt,
      endedAt: nowIso(),
      durationMs: event.durationMs,
      error: event.error?.message,
      usage: this.takeTurnUsage(turnId),
    };
    ops.push({ op: "turn.upsert", turn: this.currentTurn });
    this.currentStep = undefined;
    // The user-facing counterpart of the (hidden) context reminder: a
    // deliberate user interrupt gets a timeline marker, mirroring the cold
    // fold's `turn.cancel` handling. Programmatic aborts already surface
    // through the turn's error field or goal/task state.
    if (
      event.reason === "cancelled" &&
      event.interruptReason === "user_cancelled"
    ) {
      ops.push(
        this.markerOp("interruption", {
          turnId: event.turnId,
          reason: event.interruptReason,
        }),
      );
    }
    return ops;
  }

  /**
   * Fold this turn's accumulated step usages into the turn header's
   * `TranscriptUsage` and drop the accumulator. Step usages are the engine's
   * four-component `TokenUsage`; the header maps them to the render vocabulary
   * (`inputTokens = inputOther + inputCacheCreation`,
   * `cachedTokens = inputCacheRead`, `outputTokens = output`). A turn whose
   * steps all reported no usage gets no `usage` at all (the components have
   * no data either way — the wire never omits a single component).
   */
  protected takeTurnUsage(turnId: string): TranscriptUsage | undefined {
    const usages = this.stepUsageByTurn.get(turnId);
    this.stepUsageByTurn.delete(turnId);
    if (usages === undefined || usages.length === 0) return undefined;
    let inputOther = 0;
    let output = 0;
    let inputCacheRead = 0;
    let inputCacheCreation = 0;
    for (const usage of usages) {
      inputOther += usage.inputOther;
      output += usage.output;
      inputCacheRead += usage.inputCacheRead;
      inputCacheCreation += usage.inputCacheCreation;
    }
    return {
      inputTokens: inputOther + inputCacheCreation,
      cachedTokens: inputCacheRead,
      outputTokens: output,
    };
  }

  protected onStepStarted(event: {
    turnId: number;
    step: number;
  }): TranscriptOperation[] {
    const turnId = `t${event.turnId}`;
    const stepId = `${turnId}.${event.step}`;
    this.stepOrdinals.set(turnId, event.step);
    this.currentStep = {
      kind: "step",
      stepId,
      turnId,
      ordinal: event.step,
      state: "running",
      startedAt: nowIso(),
    };
    this.frameOrdinal = 0;
    // Stray open frames from an interrupted previous step are dropped without
    // a flush — their step's own completion event owns the flush.
    this.openText = undefined;
    this.openThinking = undefined;
    return [{ op: "step.upsert", turnId, step: this.currentStep }];
  }

  protected onStepCompleted(event: {
    turnId: number;
    step: number;
    usage?: StepUsage;
    finishReason?: string;
    rawFinishReason?: string;
    providerFinishReason?: string;
    llmFirstTokenLatencyMs?: number;
    llmStreamDurationMs?: number;
    llmRequestBuildMs?: number;
    llmServerFirstTokenMs?: number;
    llmServerDecodeMs?: number;
    llmClientConsumeMs?: number;
  }): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [];
    this.flushOpenFrames(ops);
    const turnId = `t${event.turnId}`;
    const stepId = `${turnId}.${event.step}`;
    const prev =
      this.currentStep?.stepId === stepId ? this.currentStep : undefined;
    if (event.usage !== undefined) {
      const usages = this.stepUsageByTurn.get(turnId) ?? [];
      usages.push(event.usage);
      this.stepUsageByTurn.set(turnId, usages);
    }
    this.currentStep = {
      kind: "step",
      stepId,
      turnId,
      ordinal: event.step,
      state: "completed",
      startedAt: prev?.startedAt,
      endedAt: nowIso(),
      usage: event.usage,
      finishReason:
        event.finishReason ??
        event.rawFinishReason ??
        event.providerFinishReason,
      // The header always carries the timing object; the wire omits the
      // latency fields it never measured, which land as absent keys.
      timing: {
        llmFirstTokenLatencyMs: event.llmFirstTokenLatencyMs,
        llmStreamDurationMs: event.llmStreamDurationMs,
        llmRequestBuildMs: event.llmRequestBuildMs,
        llmServerFirstTokenMs: event.llmServerFirstTokenMs,
        llmServerDecodeMs: event.llmServerDecodeMs,
        llmClientConsumeMs: event.llmClientConsumeMs,
      },
    };
    ops.push({ op: "step.upsert", turnId, step: this.currentStep });
    return ops;
  }

  protected onStepFinished(event: {
    type: "turn.step.interrupted";
    turnId: number;
    step: number;
    reason: string;
    message?: string;
  }): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [];
    this.flushOpenFrames(ops);
    const turnId = `t${event.turnId}`;
    const stepId = `${turnId}.${event.step}`;
    const prev =
      this.currentStep?.stepId === stepId ? this.currentStep : undefined;
    this.currentStep = {
      kind: "step",
      stepId,
      turnId,
      ordinal: event.step,
      state: "interrupted",
      startedAt: prev?.startedAt,
      endedAt: nowIso(),
      endReason: event.reason,
      endMessage: event.message,
    };
    ops.push({ op: "step.upsert", turnId, step: this.currentStep });
    return ops;
  }

  /**
   * `turn.step.retrying` — a claimed provider failure is being retried on the
   * same step. The step stays 'running' with the retry detail on the header;
   * the terminal step upsert simply carries no `retry`, which clears it
   * (step.upsert replaces the whole header).
   */
  protected onStepRetrying(event: {
    turnId: number;
    step: number;
    failedAttempt: number;
    nextAttempt: number;
    maxAttempts: number;
    delayMs: number;
    errorName: string;
    errorMessage: string;
    statusCode?: number;
  }): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [];
    const turnId = `t${event.turnId}`;
    const stepId = `${turnId}.${event.step}`;
    const prev =
      this.currentStep?.stepId === stepId ? this.currentStep : undefined;
    this.currentStep = {
      kind: "step",
      stepId,
      turnId,
      ordinal: event.step,
      state: "running",
      startedAt: prev?.startedAt,
      retry: {
        failedAttempt: event.failedAttempt,
        nextAttempt: event.nextAttempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        errorName: event.errorName,
        errorMessage: event.errorMessage,
        statusCode: event.statusCode,
      },
    };
    ops.push({ op: "step.upsert", turnId, step: this.currentStep });
    return ops;
  }

  protected onTextDelta(
    turnNumber: number,
    kind: "assistant" | "thinking",
    delta: string,
  ): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [];
    const turnId = `t${turnNumber}`;
    const step = this.ensureStep(turnId, ops);
    let open = kind === "assistant" ? this.openText : this.openThinking;
    // Mid-stream attach: the backfill may have seeded this step's stream
    // frame already — adopt it instead of opening an empty one.
    open ??= this.adoptStreamFrame(turnId, step.stepId, kind);
    if (open === undefined) {
      const frameId = `${step.stepId}.f${++this.frameOrdinal}`;
      open = { frameId, offset: 0, text: "" };
      ops.push({
        op: "frame.upsert",
        turnId,
        stepId: step.stepId,
        frame:
          kind === "assistant"
            ? { kind: "text", frameId, role: "assistant", text: "" }
            : { kind: "thinking", frameId, text: "" },
      });
    }
    // Known limitation: one open text frame per step per stream kind — if the
    // model emits multiple disjoint text parts in one step they are
    // concatenated into the single frame (the wire `assistant.delta` stream is
    // cumulative per turn and carries no part boundary).
    ops.push({
      op: "append",
      target: {
        type: "frame",
        turnId,
        stepId: step.stepId,
        frameId: open.frameId,
      },
      offset: open.offset,
      text: delta,
    });
    open.offset += delta.length;
    open.text += delta;
    if (kind === "assistant") this.openText = open;
    else this.openThinking = open;
    return ops;
  }

  /**
   * Mid-stream attach adoption. When the projector starts streaming a step it
   * has never seen, the history backfill may already have seeded that step's
   * stream frame with the text persisted so far (the in-flight turn's deltas
   * are persisted upstream). Opening a fresh frame here would emit an empty
   * `frame.upsert` that clobbers the seeded text, followed by offset-0
   * appends that cannot land past it — corrupting the live transcript until
   * the next cold rebuild. Instead adopt the seeded frame: continue its id
   * and offset (the persisted text is a prefix of the same stream), and
   * advance `frameOrdinal` past the step's existing `.fN` frames so later
   * frames cannot collide. Known limitation: deltas observed between bind
   * and the backfill landing still open a fresh frame (the backfill's later
   * upsert then replaces it wholesale).
   */
  protected adoptStreamFrame(
    turnId: string,
    stepId: string,
    kind: "assistant" | "thinking",
  ): OpenTextFrame | undefined {
    const frames = this.lookups?.stepFrames?.(turnId, stepId);
    if (frames === undefined || frames.length === 0) return undefined;
    for (const frame of frames) {
      const match = /\.f(\d+)$/.exec(frame.frameId);
      if (match !== null) {
        this.frameOrdinal = Math.max(this.frameOrdinal, Number(match[1]));
      }
    }
    for (let i = frames.length - 1; i >= 0; i -= 1) {
      const frame = frames[i];
      if (frame === undefined) continue;
      if (
        kind === "assistant" &&
        frame.kind === "text" &&
        frame.role === "assistant"
      ) {
        return {
          frameId: frame.frameId,
          offset: frame.text.length,
          text: frame.text,
        };
      }
      if (kind === "thinking" && frame.kind === "thinking") {
        return {
          frameId: frame.frameId,
          offset: frame.text.length,
          text: frame.text,
        };
      }
    }
    return undefined;
  }

  /** Re-emit every open text/thinking frame with its full text (the 'block'-grade convergence point). */
  protected flushOpenFrames(ops: TranscriptOperation[]): void {
    const step = this.currentStep;
    for (const open of [this.openText, this.openThinking]) {
      if (open === undefined || step === undefined) continue;
      const isText = open === this.openText;
      ops.push({
        op: "frame.upsert",
        turnId: step.turnId,
        stepId: step.stepId,
        frame: isText
          ? {
              kind: "text",
              frameId: open.frameId,
              role: "assistant",
              text: open.text,
            }
          : { kind: "thinking", frameId: open.frameId, text: open.text },
      });
    }
    this.openText = undefined;
    this.openThinking = undefined;
  }

  /**
   * Resolve the step a content event belongs to. When the projector missed
   * `turn.step.started` (mid-stream attach), prefer the engine-reported
   * active step from the activity view; then the latest step this projector
   * saw; only then the `t<N>.1` fallback (the store skeleton-fills anything
   * still missing). Without the lookup a late attach at step ≥ 2 would
   * stream into the wrong step.
   */
  protected ensureStep(turnId: string, ops: TranscriptOperation[]): StepHeader {
    if (this.currentStep !== undefined && this.currentStep.turnId === turnId) {
      return this.currentStep;
    }
    const ordinal =
      this.lookups?.stepOrdinal?.(turnId) ?? this.stepOrdinals.get(turnId) ?? 1;
    this.currentStep = {
      kind: "step",
      stepId: `${turnId}.${ordinal}`,
      turnId,
      ordinal,
      state: "running",
      startedAt: nowIso(),
    };
    ops.push({ op: "step.upsert", turnId, step: this.currentStep });
    return this.currentStep;
  }

  // ---------------------------------------------------------------- tools

  /**
   * `tool.call.delta` — raw argument streaming. The deltas accumulate into the
   * frame's `inputText` (the verbatim counterpart of the parsed `input`). A
   * delta can arrive before `tool.call.started` (the stream reports arguments
   * as they generate): the frame is then created here, and the later started
   * event fills in name/input/display while keeping the accumulated text.
   */
}

import type { AgentUsageMeta, TranscriptInteraction, TranscriptOperation, TranscriptPrompt, TranscriptTask, TranscriptUsage } from "@moonshot-ai/transcript";
import type { PlanRevisionEvent, ProjectorInteraction, ProjectorPromptSubmittedEvent } from "./projectorTypes";
import type { PromptAbortedEvent, PromptCompletedEvent, PromptSteeredEvent } from "./projectorTypes";
import { mapInteractionEndState, nowIso, restOf } from "./projectorMappings";
import { toLegacyPhase } from "../legacyStatus/legacyStatus";
import type { ToolCallFrame } from "@moonshot-ai/transcript";
import { ProjectorTasks } from "./projectorTasks";

export abstract class ProjectorMetaPrompts extends ProjectorTasks {
  protected readonly interactions = new Map<string, TranscriptInteraction>();
  protected readonly prompts = new Map<string, TranscriptPrompt>();
  protected readonly stepUsageByTurn = new Map<string, import("@moonshot-ai/transcript").StepUsage[]>();
  protected markerSeq = 0;
  protected planModeActive = false;

  constructor(lookups?: import("./projectorTypes").ProjectorLookups) {
    super(lookups);
  }

  protected onGoalUpdated(event: {
    readonly type: string;
    snapshot: {
      objective: string;
      status: "active" | "paused" | "blocked" | "complete";
      completionCriterion?: string;
      tokensUsed: number;
      budget: { tokenBudget: number | null };
    } | null;
  }): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [];
    const snapshot = event.snapshot;
    if (snapshot !== null) {
      ops.push({
        op: "meta.merge",
        meta: {
          goal: {
            objective: snapshot.objective,
            status: snapshot.status,
            completionCriterion: snapshot.completionCriterion,
            budgetUsed: snapshot.tokensUsed,
            budgetLimit: snapshot.budget.tokenBudget ?? undefined,
          },
        },
      });
    }
    // Known limitation: a cleared goal (`snapshot: null`) cannot be expressed
    // by `meta.merge` (absent keys keep prior state) — the 'goal' marker
    // lands, and `meta.goal` refreshes on the next reset.
    ops.push(this.markerOp("goal", restOf(event)));
    return ops;
  }

  protected onAgentStatusUpdated(event: {
    planMode?: boolean;
    swarmMode?: boolean;
    model?: string;
    thinkingEffort?: string;
    usage?: AgentUsageMeta;
    contextTokens?: number;
    maxContextTokens?: number;
    contextUsage?: number;
    permission?: "manual" | "yolo" | "auto";
  }): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [];
    // Only the exact `planMode` / `swarmMode` fields drive the mode badges
    // (the status slices arrive independently — see `agent/usage/usageOps.ts`).
    // A mode exit (`false`) clears the badge: `null` deletes the key in the
    // reducer, so clients never keep showing a mode that already ended.
    const modes: {
      plan?: Record<string, never> | null;
      swarm?: Record<string, never> | null;
    } = {};
    if (event.planMode === true) {
      modes.plan = {};
      this.planModeActive = true;
    } else if (event.planMode === false) {
      modes.plan = null;
      this.planModeActive = false;
    }
    if (event.swarmMode === true) modes.swarm = {};
    else if (event.swarmMode === false) modes.swarm = null;
    if (modes.plan !== undefined || modes.swarm !== undefined) {
      ops.push({ op: "meta.merge", meta: { modes } });
    }
    // Every other arrived slice mirrors into `meta.agent`. The reducer
    // shallow-merges that key, so only the arrived fields may appear on the
    // payload — an explicit `undefined` entry would erase the previous
    // slice's value. (`contextUsage` / `permission` ride the wire schema but
    // are not on the v2 `DomainEventMap` declaration yet — projected whenever
    // they arrive.)
    const agent: {
      model?: string;
      thinkingEffort?: string;
      usage?: AgentUsageMeta;
      contextTokens?: number;
      maxContextTokens?: number;
      contextUsage?: number;
      permission?: "manual" | "yolo" | "auto";
    } = {};
    let hasStatusSlice = false;
    if (event.model !== undefined) {
      agent.model = event.model;
      hasStatusSlice = true;
    }
    if (event.thinkingEffort !== undefined) {
      agent.thinkingEffort = event.thinkingEffort;
      hasStatusSlice = true;
    }
    if (event.usage !== undefined) {
      agent.usage = event.usage;
      hasStatusSlice = true;
    }
    if (event.contextTokens !== undefined) {
      agent.contextTokens = event.contextTokens;
      hasStatusSlice = true;
    }
    if (event.maxContextTokens !== undefined) {
      agent.maxContextTokens = event.maxContextTokens;
      hasStatusSlice = true;
    }
    if (event.contextUsage !== undefined) {
      agent.contextUsage = event.contextUsage;
      hasStatusSlice = true;
    }
    if (event.permission !== undefined) {
      agent.permission = event.permission;
      hasStatusSlice = true;
    }
    if (hasStatusSlice) {
      ops.push({ op: "meta.merge", meta: { agent } });
    }
    return ops;
  }

  /**
   * `agent.activity.updated` — the engine's folded activity view. Projected
   * through `toLegacyPhase` (the same v1 phase projection the WS edge uses —
   * see `sessionEventBroadcaster.ts`) into `meta.agent.phase`; `disposing` /
   * `disposed` states map to `undefined` and emit nothing, as at the edge.
   */
  protected onAgentActivityUpdated(
    event: AgentActivityUpdatedEvent,
  ): TranscriptOperation[] {
    const phase = toLegacyPhase(event);
    if (phase === undefined) return [];
    return [{ op: "meta.merge", meta: { agent: { phase } } }];
  }

  /**
   * `plan.revision` — a plan content version was offloaded on review
   * submission. Always lands as a 'plan.revision' timeline marker (it stays
   * after plan mode exits); while plan mode is still active it also refines
   * the plan badge with the revision reference (`exit`/`cancel` later clear
   * the badge via the `planMode: false` slice, as before).
   */
  protected onPlanRevision(event: PlanRevisionEvent): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [
      this.markerOp("plan.revision", restOf(event)),
    ];
    if (this.planModeActive) {
      ops.push({
        op: "meta.merge",
        meta: {
          modes: { plan: { reviewPath: event.path, version: event.version } },
        },
      });
    }
    return ops;
  }

  protected markerOp(marker: string, payload: unknown): TranscriptOperation {
    this.markerSeq += 1;
    const item: TranscriptMarker = {
      kind: "marker",
      // Live markers use their own namespace: the cold rebuild numbers its
      // markers `m1…` from zero too, and a colliding id would make the
      // store's upsert REPLACE the historical marker with the live one (or
      // vice versa) instead of appending.
      markerId: `live-m${this.markerSeq}`,
      marker,
      payload,
      at: nowIso(),
    };
    return { op: "marker.upsert", item };
  }

  protected noticeOp(
    level: "error" | "warning" | "info",
    message: string,
    eventPayload: unknown,
  ): TranscriptOperation {
    return this.markerOp("notice", { level, message, event: eventPayload });
  }

  // ---------------------------------------------------------------- prompts

  protected onPromptSubmitted(
    event: ProjectorPromptSubmittedEvent,
  ): TranscriptOperation[] {
    const prompt = this.upsertPrompt(event.promptId, () => ({
      promptId: event.promptId,
      status: event.status,
      userMessageId: event.userMessageId,
      content: event.content,
      createdAt: event.createdAt,
    }));
    return [{ op: "prompt.upsert", prompt }];
  }

  protected onPromptCompleted(
    event: PromptCompletedEvent,
  ): TranscriptOperation[] {
    const prompt = this.upsertPrompt(event.promptId, (prev) => ({
      // Late attach: `prompt.submitted` was missed (or never published — the
      // v2 bus does not emit it), so synthesize the minimal entity from the
      // terminal event's fields.
      promptId: event.promptId,
      status: event.reason ?? "completed",
      userMessageId: prev?.userMessageId,
      content: prev?.content,
      createdAt: prev?.createdAt ?? event.finishedAt,
      finishedAt: event.finishedAt,
      steeredAt: prev?.steeredAt,
    }));
    return [{ op: "prompt.upsert", prompt }];
  }

  protected onPromptAborted(event: PromptAbortedEvent): TranscriptOperation[] {
    const prompt = this.upsertPrompt(event.promptId, (prev) => ({
      promptId: event.promptId,
      status: "aborted",
      userMessageId: prev?.userMessageId,
      content: prev?.content,
      createdAt: prev?.createdAt ?? event.abortedAt,
      finishedAt: event.abortedAt,
      steeredAt: prev?.steeredAt,
    }));
    return [{ op: "prompt.upsert", prompt }];
  }

  /**
   * `prompt.steered` — queued prompts were merged into the running prompt's
   * turn (`AgentPromptService.steer`). The active prompt keeps running with
   * the merged content and the steer timestamp; the absorbed prompts leave
   * the queue — the engine marks them 'steered' and later settles them with
   * the active prompt's outcome, so the transcript settles them as
   * 'completed' (their content was delivered, not aborted).
   */
  protected onPromptSteered(event: PromptSteeredEvent): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [];
    const active = this.upsertPrompt(event.activePromptId, (prev) => ({
      promptId: event.activePromptId,
      status: prev?.status ?? "running",
      userMessageId: prev?.userMessageId,
      content: event.content,
      createdAt: prev?.createdAt ?? event.steeredAt,
      finishedAt: prev?.finishedAt,
      steeredAt: event.steeredAt,
    }));
    ops.push({ op: "prompt.upsert", prompt: active });
    for (const promptId of event.promptIds) {
      const steered = this.upsertPrompt(promptId, (prev) => ({
        promptId,
        status: "completed",
        userMessageId: prev?.userMessageId,
        content: prev?.content,
        createdAt: prev?.createdAt ?? event.steeredAt,
        finishedAt: event.steeredAt,
        steeredAt: event.steeredAt,
      }));
      ops.push({ op: "prompt.upsert", prompt: steered });
    }
    return ops;
  }

  protected upsertPrompt(
    promptId: string,
    build: (prev: TranscriptPrompt | undefined) => TranscriptPrompt,
  ): TranscriptPrompt {
    const prompt = build(this.prompts.get(promptId));
    this.prompts.set(promptId, prompt);
    return prompt;
  }

  // ---------------------------------------------------------------- interactions

  /**
   * `requested` — entity-only emission: the global interaction entity
   * (`interaction.upsert`), addressed by id, pagination-proof, visible at
   * 'turn' grade. Interactions never appear as inline step frames. The
   * entity's `toolCallId` (the timeline anchor) is read from the payload
   * when present and omitted otherwise; an unanchored interaction renders
   * floating in consumers.
   */
  mapInteractionRequested(
    interaction: ProjectorInteraction,
  ): TranscriptOperation[] {
    const payload = interaction.payload as { toolCallId?: unknown };
    const toolCallId =
      typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
    const entity: TranscriptInteraction = {
      interactionId: interaction.id,
      interactionKind: interaction.kind,
      toolCallId,
      state: "pending",
      request: interaction.payload,
    };
    this.interactions.set(interaction.id, entity);
    return [{ op: "interaction.upsert", interaction: entity }];
  }

  /**
   * `resolved` — terminal state plus the raw engine response on the entity;
   * when the linked tool call is known, re-emit its frame with the
   * `approvalId` back-link.
   */
  mapInteractionResolved(id: string, response: unknown): TranscriptOperation[] {
    const record = this.interactions.get(id);
    if (record === undefined) return [];
    this.interactions.delete(id);
    const state = mapInteractionEndState(record.interactionKind, response);
    const ops: TranscriptOperation[] = [
      { op: "interaction.upsert", interaction: { ...record, state, response } },
    ];
    const toolCallId = record.toolCallId;
    if (toolCallId !== undefined) {
      // Adopt the seeded frame when the call predates this projector, so the
      // back-link still lands after a mid-bind attach.
      const hit =
        this.toolFrames.get(toolCallId) ?? this.adoptToolFrame(toolCallId);
      if (hit !== undefined) {
        const toolFrame: ToolCallFrame = { ...hit.frame, approvalId: id };
        this.toolFrames.set(toolCallId, { ...hit, frame: toolFrame });
        ops.push({
          op: "frame.upsert",
          turnId: hit.turnId,
          stepId: hit.stepId,
          frame: toolFrame,
        });
      }
    }
    return ops;
  }
}

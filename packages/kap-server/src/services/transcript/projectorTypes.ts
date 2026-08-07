import type { DomainEvent } from "@moonshot-ai/agent-core-v2";
import type { ToolCallFrame, TranscriptFrame } from "@moonshot-ai/transcript";

export interface ProjectorInteraction {
  readonly id: string;
  readonly kind: "approval" | "question";
  /** In-process `ApprovalRequest` / `QuestionRequest`, passed through as-is. */
  readonly payload: unknown;
  readonly origin: { readonly agentId?: string; readonly turnId?: number };
}

/**
 * The plan domain's `plan.revision` event (agent-core-v2 `planOps.ts` — the
 * persisted op's `toEvent`): one per ExitPlanMode review submission, carrying
 * the reference to the offloaded plan file version. Derived from `DomainEvent`
 * so a shape drift on the engine side fails the compile here.
 */
export type PlanRevisionEvent = Extract<DomainEvent, { type: "plan.revision" }>;

export type AgentActivityUpdatedEvent = Extract<
  DomainEvent,
  { type: "agent.activity.updated" }
>;
export type PromptCompletedEvent = Extract<DomainEvent, { type: "prompt.completed" }>;
export type PromptAbortedEvent = Extract<DomainEvent, { type: "prompt.aborted" }>;
export type PromptSteeredEvent = Extract<DomainEvent, { type: "prompt.steered" }>;

/**
 * The v1-wire `prompt.submitted` shape (kap-server `protocol/events-zod.ts`).
 * The v2 bus never publishes it (see `agent/prompt/promptService.ts`, which
 * emits only completed / aborted / steered), so it is declared here rather
 * than derived from `DomainEvent`; `map` accepts it so an edge that learns
 * about a submission (REST prompt path, a future engine event) can project it
 * through the same entry point.
 */
export interface ProjectorPromptSubmittedEvent {
  readonly type: "prompt.submitted";
  readonly promptId: string;
  readonly userMessageId: string;
  readonly status: "running" | "queued" | "blocked";
  readonly content?: unknown;
  readonly createdAt: string;
}

/**
 * Read access to one step's current frames (the producer store). Used for
 * mid-stream attach adoption — see `adoptStreamFrame`.
 */
export type ProjectorFrameLookup = (
  turnId: string,
  stepId: string,
) => readonly TranscriptFrame[] | undefined;

/**
 * Locate a tool frame by its toolCallId across the producer store. Used for
 * mid-bind result adoption — see `adoptToolFrame`.
 */
export type ProjectorToolFrameLookup = (
  toolCallId: string,
) => ToolFrameRecord | undefined;

/**
 * The engine-reported current step ordinal for a turn (the activity view).
 * Used to place deltas correctly when the projector attached after
 * `turn.step.started` for a later step — see `ensureStep`.
 */
export type ProjectorStepOrdinalLookup = (turnId: string) => number | undefined;

/** Optional producer-store lookups that let the projector adopt seeded state. */
export interface ProjectorLookups {
  readonly stepFrames?: ProjectorFrameLookup;
  readonly toolFrame?: ProjectorToolFrameLookup;
  readonly stepOrdinal?: ProjectorStepOrdinalLookup;
}

export interface OpenTextFrame {
  readonly frameId: string;
  offset: number;
  text: string;
}

export interface ToolFrameRecord {
  readonly turnId: string;
  readonly stepId: string;
  readonly frame: ToolCallFrame;
}

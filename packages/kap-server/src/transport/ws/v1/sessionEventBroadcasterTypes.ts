import type {
  InteractionKind,
  SessionActivityState,
} from "@moonshot-ai/agent-core-v2";
import type { SessionCursor } from "../../../protocol/ws-control";
import type { InFlightTurn, SnapshotSubagent } from "../../../protocol/rest-snapshot";
import type { TranscriptGradeSpec, TranscriptStore } from "@moonshot-ai/transcript";
import type { EventEnvelope } from "./sessionEventJournal";
import { InFlightTurnTracker } from "./inFlightTurnTracker";
import { SubagentRosterTracker } from "./subagentRosterTracker";
import { SessionEventJournal } from "./sessionEventJournal";

export type ResyncReason =
  | "buffer_overflow"
  | "session_recreated"
  | "epoch_changed";

export interface BufferedSinceResult {
  events: Array<{ seq: number; envelope: EventEnvelope }>;
  /** When set, the client must rebuild from the snapshot and re-subscribe. */
  resyncRequired: ResyncReason | false;
  currentSeq: number;
  epoch: string;
}

export interface SessionSnapshotState {
  seq: number;
  epoch: string;
  inFlightTurn: InFlightTurn | null;
  subagents: SnapshotSubagent[];
}

/** Internal transport lane: only subscription traffic enters the timed buffer. */
export type BroadcastDelivery = "subscription" | "immediate";

/** A connection (or test double) that receives sequenced envelopes. */
export interface BroadcastTarget {
  send(envelope: EventEnvelope, delivery?: BroadcastDelivery): void;
}

/**
 * Per-subscription agent allowlist for fine-grained v1 event delivery.
 * `undefined` (or omitted) means "receive every agent" — the legacy
 * session-grained behavior. A `ReadonlySet` restricts delivery to the listed
 * agent ids; global events ({@link isGlobalEvent}) bypass the filter entirely.
 */
export type AgentFilter = ReadonlySet<string> | undefined;

/**
 * What one connection wants from a session: two independent dimensions. The
 * legacy agent allowlist gates `session_event` delivery only; the opt-in
 * per-agent transcript grades (`Record<agentId|'*', grade>`; absent = all
 * 'off' — legacy clients see no transcript frames at all) alone decide which
 * agents' transcript frames the connection receives — the allowlist does NOT
 * gate the transcript stream.
 */
export interface TargetSubscription {
  readonly agentFilter?: AgentFilter;
  readonly transcriptGrades?: TranscriptGradeSpec;
}

/** Per-session transcript streaming state (shared across all targets). */
interface TranscriptStream {
  /** The store this stream's listeners are attached to — a rebuilt store (session reload) forces re-attachment. */
  readonly store: TranscriptStore;
  /** Agents already seeded (roster de-dup for the reset fan-out). */
  readonly knownAgents: Set<string>;
}

interface SessionState {
  readonly sessionId: string;
  readonly journal: SessionEventJournal;
  readonly tracker: InFlightTurnTracker;
  readonly roster: SubagentRosterTracker;
  /**
   * The session's work aggregate is owned by the core's `ISessionActivityView`
   * — this is only the latest `turn_ended`-caused state, buffered so the
   * `work_changed(busy:false)` frame can be emitted AFTER the corresponding
   * `turn.ended` frame. The agent bus fires full-stream subscribers before
   * per-type ones, so the view's change is reported AFTER the edge's own
   * `turn.ended` handling within the same synchronous publish — the buffer is
   * flushed from a microtask, which still lands after the `turn.ended` frame
   * was enqueued (see attachWorkView).
   */
  deferredWork?: SessionActivityState;
  /** Recent durable envelopes for in-memory replay. */
  readonly tail: Array<{ seq: number; envelope: EventEnvelope }>;
  /** Connections subscribed to this session, each with its subscription view. */
  readonly targets: Map<BroadcastTarget, TargetSubscription>;
  /** Per-session dispatch queue — serializes stamp / journal / fan-out. */
  queue: Promise<void>;
  /** agentId → sink subscription. */
  readonly agentDisposables: Map<string, IDisposable>;
  readonly lifecycleDisposables: IDisposable[];
  /** Interactions already announced (or pre-existing at activation): id → kind + owning agent (for the resolved event). */
  readonly knownInteractions: Map<
    string,
    { readonly kind: InteractionKind; readonly agentId: string }
  >;
  /** Attached on first transcript-grade subscription for this session. */
  transcriptStream?: TranscriptStream;
  /** Connections whose transcript baseline reset has landed — the ops fan-out is gated on it. */
  readonly transcriptSeeded: Set<BroadcastTarget>;
  /** Resets deferred until the connection's cursor replay completes (ordering: backlog before baseline). */
  readonly deferredTranscriptSeeds: Map<
    BroadcastTarget,
    {
      readonly spec: TranscriptGradeSpec;
      readonly transcriptSince?: Record<string, number>;
    }
  >;
}

export const DEFAULT_MAX_BUFFER_SIZE = 1000;
export const TRANSCRIPT_RESET_TAIL_TURNS = 0;

export async function disposeSessionState(state: SessionState): Promise<void> {
  for (const d of state.lifecycleDisposables) d.dispose();
  for (const d of state.agentDisposables.values()) d.dispose();
  await state.journal.close();
}

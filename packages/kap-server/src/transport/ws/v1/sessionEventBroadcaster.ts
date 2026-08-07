/**
 * `SessionEventBroadcaster` — per-session single fan-out point that turns agent
 * events (via the per-agent `IEventBus`) into a sequenced,
 * journaled, replayable `/api/v1/ws` event stream (the `{seq, epoch}` watermark).
 *
 * Port of v1's `WSBroadcastService` (`packages/server/.../wsBroadcastService.ts`),
 * adapted to v2 where agent events live on the per-agent `IEventBus`
 * (not a Core firehose). For each session it:
 *
 *   1. Subscribes to every agent's `IEventBus` via
 *      `IAgentLifecycleService` reach-down-via-handle (and `onDidCreate` /
 *      `onDidDispose` for late agents); `record` emissions are persisted and not
 *      broadcast (see step 3). The same lifecycle callbacks fan durable
 *      `agent.created` / `agent.disposed` facts out at session granularity
 *      (they bypass per-subscription agent allowlists but never leave the
 *      session). Also subscribes to the session's
 *      `ISessionInteractionService` and synthesizes the v1 approval/question
 *      protocol events from pending-set changes and resolutions.
 *   2. Attaches `agentId`/`sessionId` to build the wire `Event`.
 *   3. Classifies durable vs volatile — `isVolatileSignal` for the agent
 *      wire-emission path (`isVolatileEventType` remains for the global/model path).
 *   4. Durable events: assign the next per-session `seq` (monotonic across
 *      restarts), persist to the `SessionEventJournal`, cache in an in-memory
 *      tail, fan out.
 *   5. Volatile events: fan out live with the current durable watermark as
 *      `seq` and `volatile: true`. Never journaled, never replayed.
 *   6. Exposes replay (`getBufferedSince`) keyed by `{seq, epoch}` cursors and
 *      an atomic `getSnapshotState` for the snapshot route.
 *
 * A session is activated (journaling starts) on first `subscribe` /
 * `getSnapshotState` / `getCursor` and stays active for the process lifetime so
 * the journal is continuous from first activation onward.
 *
 * Fan-out split: global events ({@link isGlobalEvent} — `session.meta.updated`
 * plus the `event.session.*` / `event.workspace.*` / `event.config.*`
 * families, including every session's `event.session.work_changed`) are pushed
 * to EVERY established connection (registered via
 * {@link SessionEventBroadcaster.addGlobalTarget}, no subscription needed)
 * union every subscribed target. Session/agent events only reach connections
 * subscribed to that session, subject to the per-subscription agent allowlist
 * and the transcript suppression below. Transcript frames (`transcript.reset`
 * / `transcript.ops`) are a separate channel: they are governed by the
 * per-agent transcript grades alone and bypass the agent allowlist entirely.
 *
 * Transcript dedup: a connection subscribed to the transcript protocol
 * (grade ≠ 'off' for the emitting agent) no longer receives the
 * `session_event`s the transcript already projects — see
 * {@link TRANSCRIPT_PROJECTED_EVENT_TYPES}. Suppression is a per-connection
 * send-view crop only: the journal and tail keep recording every event, and
 * connections without a transcript spec are unaffected.
 */
import type { Scope, IDisposable } from "@moonshot-ai/agent-core-v2";
import { IEventService, ISessionIndex, getLiveSessionById } from "@moonshot-ai/agent-core-v2";
import { sessionJournalPath, SessionEventJournal, type JournalLogger } from "./sessionEventJournal";
import type { TranscriptService } from "../../../services/transcript/transcriptService";
import { InFlightTurnTracker } from "./inFlightTurnTracker";
import { SubagentRosterTracker } from "./subagentRosterTracker";
import { SessionEventDispatch } from "./sessionEventDispatch";
import {
  DEFAULT_MAX_BUFFER_SIZE,
  disposeSessionState,
  type BroadcastTarget,
  type SessionState,
} from "./sessionEventBroadcasterTypes";
import { GLOBAL_SESSION_ID, matchesAgentFilter, suppressedByTranscript } from "./sessionEventWireMapping";

export * from "./sessionEventBroadcasterTypes";
export { isGlobalEvent, matchesAgentFilter, suppressedByTranscript, TRANSCRIPT_PROJECTED_EVENT_TYPES } from "./sessionEventWireMapping";

export class SessionEventBroadcaster extends SessionEventDispatch {
  protected readonly sessions = new Map<string, SessionState>();
  /**
   * Every established connection, subscribed or not. Global events
   * ({@link isGlobalEvent}) fan out to this set (union the per-session
   * targets) so a freshly connected client sees session-level facts —
   * `event.session.created`, `session.meta.updated`, and every activated
   * session's `event.session.work_changed` — without subscribing to anything.
   */
  protected readonly globalTargets = new Set<BroadcastTarget>();
  /**
   * Single-flight guard for session activation: without it, two concurrent
   * activations (WS subscribe racing a REST snapshot / replay / resync) each
   * built their own SessionState, bus subscriptions, and journal writer. The
   * leaked listeners all route through `onAgentEvent`, which looks up the
   * current state by session id, so they advance the SAME tracker and journal:
   * one source delta is emitted at consecutive offsets and adjacent durable
   * events receive distinct consecutive seqs. WS coalescing then folds the
   * adjacent delta copies into one doubled payload, producing the observed
   * per-chunk `AABBCC` stream while every seq and offset still looks valid.
   */
  private readonly pendingStates = new Map<
    string,
    Promise<SessionState | undefined>
  >();
  protected readonly maxBufferSize: number;
  private readonly coreEventSubscription: IDisposable;
  protected closed = false;

  constructor(
    protected readonly opts: {
      readonly eventsDir: string;
      readonly core: Scope;
      readonly logger?: JournalLogger;
      readonly maxBufferSize?: number;
      /**
       * Optional transcript owner; when present, `subscribe` with transcript
       * grades activates per-agent op streaming for live sessions. Absent =
       * transcript disabled (tests / minimal embeds).
       */
      readonly transcriptService?: TranscriptService;
    },
  ) {
    this.maxBufferSize = opts.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
    this.coreEventSubscription = opts.core.accessor
      .get(IEventService)
      .subscribe((event) => this.onCoreEvent(event));
  }

  /**
   * Register a freshly established connection for global-event fan-out. The
   * connection receives every global event ({@link isGlobalEvent}) from this
   * point on, with no per-session subscription required. Idempotent.
   */
  addGlobalTarget(target: BroadcastTarget): void {
    this.globalTargets.add(target);
  }

  /** Drop a closed connection from the global fan-out set. Idempotent. */
  removeGlobalTarget(target: BroadcastTarget): void {
    this.globalTargets.delete(target);
  }
  async subscribe(
    sessionId: string,
    target: BroadcastTarget,
    filter?: AgentFilter,
    transcriptGrades?: TranscriptGradeSpec,
    opts?: {
      deferTranscriptReset?: boolean;
      transcriptSince?: Record<string, number>;
    },
  ): Promise<boolean> {
    const state = await this.ensureState(sessionId);
    if (state === undefined) return false;
    const prev = state.targets.get(target);
    state.targets.set(target, { agentFilter: filter, transcriptGrades });
    if (transcriptGrades !== undefined) {
      if (opts?.deferTranscriptReset === true) {
        // The baseline rides `flushTranscriptSeed` (after the caller's cursor
        // replay), so the reset's seq always follows the replayed backlog.
        state.transcriptSeeded.delete(target);
        state.deferredTranscriptSeeds.set(target, {
          spec: transcriptGrades,
          transcriptSince: opts.transcriptSince,
        });
      } else {
        state.deferredTranscriptSeeds.delete(target);
        // Gate the ops fan-out only while a replacement baseline is actually
        // on its way — a no-reset resubscribe must not black out the stream.
        const gated = this.willSendTranscriptReset(
          state,
          transcriptGrades,
          prev,
        );
        if (gated) state.transcriptSeeded.delete(target);
        await this.subscribeTranscript(
          state,
          target,
          transcriptGrades,
          prev?.transcriptGrades,
          opts?.transcriptSince,
        );
        // A no-reset subscription owes no baseline — the target is seeded
        // either way (a fresh session with an empty roster must still
        // receive roster resets and ops once agents appear).
        if (state.targets.has(target)) state.transcriptSeeded.add(target);
      }
    }
    return true;
  }

  /**
   * Whether `subscribeTranscript` will send at least one reset for this
   * (target, spec) pair right now — an upgrade over the previous grades.
   */
  private willSendTranscriptReset(
    state: SessionState,
    spec: TranscriptGradeSpec,
    prev: TargetSubscription | undefined,
  ): boolean {
    const service = this.opts.transcriptService;
    if (service === undefined) return false;
    const store = service.forSessionLive(state.sessionId);
    if (store === undefined) return false;
    for (const descriptor of store.agents()) {
      const grade = gradeFor(spec, descriptor.agentId);
      if (grade === "off") continue;
      if (
        needsResetOnTransition(
          gradeFor(prev?.transcriptGrades, descriptor.agentId),
          grade,
        )
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Send the transcript baseline deferred by `subscribe(deferTranscriptReset)`
   * — callers run it after their cursor replay so the reset never lands ahead
   * of the replayed (lower-seq) backlog. The baseline is forced for every
   * admitted agent (no previous grades): volatile ops fanned out while the
   * target sat unseeded were dropped, so only a full reset closes that gap —
   * unless the subscription carried a `transcriptSince` cursor the journal
   * still covers, in which case replaying exactly the missed batches closes
   * it and no reset is sent for that agent.
   */
  async flushTranscriptSeed(
    sessionId: string,
    target: BroadcastTarget,
  ): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return;
    const deferred = state.deferredTranscriptSeeds.get(target);
    if (deferred === undefined) return;
    state.deferredTranscriptSeeds.delete(target);
    await this.subscribeTranscript(
      state,
      target,
      deferred.spec,
      undefined,
      deferred.transcriptSince,
    );
    if (state.targets.has(target)) state.transcriptSeeded.add(target);
  }

  unsubscribe(sessionId: string, target: BroadcastTarget): void {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return;
    state.targets.delete(target);
    state.transcriptSeeded.delete(target);
    state.deferredTranscriptSeeds.delete(target);
  }

  /**
   * Detach one connection's transcript grade stream — agent-grained. With
   * `agentIds`, only the listed agents drop to an explicit 'off' (a listed
   * '*' removes the wildcard default); without it, the whole stream goes.
   * Non-activating and idempotent: unknown sessions/targets are no-ops. A
   * detached agent stops streaming on the next ops batch and its legacy
   * session_events resume automatically (both paths re-read the per-agent
   * grade); when no non-'off' grade remains the spec collapses to
   * `undefined`, the seeded/deferred baselines are dropped, and any in-flight
   * `subscribeTranscript` aborts on its grade re-read.
   */
  unsubscribeTranscript(
    sessionId: string,
    target: BroadcastTarget,
    agentIds?: readonly string[],
  ): void {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return;
    const sub = state.targets.get(target);
    if (sub === undefined) return;
    const next =
      agentIds === undefined
        ? undefined
        : detachGrades(sub.transcriptGrades, agentIds);
    if (next === undefined) {
      state.targets.set(target, {
        agentFilter: sub.agentFilter,
        transcriptGrades: undefined,
      });
      state.transcriptSeeded.delete(target);
      state.deferredTranscriptSeeds.delete(target);
    } else {
      state.targets.set(target, {
        agentFilter: sub.agentFilter,
        transcriptGrades: next,
      });
    }
  }
  async getBufferedSince(
    sessionId: string,
    cursor: SessionCursor,
    filter?: AgentFilter,
    transcriptGrades?: TranscriptGradeSpec,
  ): Promise<BufferedSinceResult> {
    const state = await this.ensureState(sessionId);
    if (state === undefined) {
      return {
        events: [],
        resyncRequired: "session_recreated",
        currentSeq: 0,
        epoch: "",
      };
    }
    // Drain so the cursor reflects everything dispatched so far.
    await state.queue;
    const { journal, tail } = state;
    const currentSeq = journal.seq;
    const { epoch } = journal;

    if (cursor.epoch !== undefined && cursor.epoch !== epoch) {
      return { events: [], resyncRequired: "epoch_changed", currentSeq, epoch };
    }
    if (cursor.seq > currentSeq) {
      // Stale / foreign cursor (e.g. from a different epoch or a pre-journal client).
      return { events: [], resyncRequired: "epoch_changed", currentSeq, epoch };
    }
    if (cursor.seq === currentSeq) {
      return { events: [], resyncRequired: false, currentSeq, epoch };
    }
    if (currentSeq - cursor.seq > this.maxBufferSize) {
      return {
        events: [],
        resyncRequired: "buffer_overflow",
        currentSeq,
        epoch,
      };
    }

    // Filter is a view crop over the session's single durable sequence: the
    // watermark and overflow checks above stay global, only the returned
    // envelopes are narrowed to the subscriber's agent allowlist — and, for a
    // transcript subscriber, stripped of the events the transcript already
    // projects. The journal itself keeps every event, so re-subscribing
    // without a transcript spec replays the complete history.
    const applyFilter = (
      entries: Array<{ seq: number; envelope: EventEnvelope }>,
    ): Array<{ seq: number; envelope: EventEnvelope }> =>
      filter === undefined && transcriptGrades === undefined
        ? entries
        : entries.filter(
      const events = applyFilter(tail.filter((e) => e.seq > cursor.seq));
      return { events, resyncRequired: false, currentSeq, epoch };
    }
    const fromDisk = await journal.readSince(cursor.seq, this.maxBufferSize);
    return {
      events: applyFilter(fromDisk),
      resyncRequired: false,
      currentSeq,
      epoch,
    };
  }
  private ensureState(sessionId: string): Promise<SessionState | undefined> {
    if (this.closed) return Promise.resolve(undefined);
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) return Promise.resolve(existing);
    let pending = this.pendingStates.get(sessionId);
    if (pending === undefined) {
      pending = this.createSessionState(sessionId).finally(() => {
        if (this.pendingStates.get(sessionId) === pending) {
          this.pendingStates.delete(sessionId);
        }
      });
      this.pendingStates.set(sessionId, pending);
    }
    return pending;
  }

  private async createSessionState(
    sessionId: string,
  ): Promise<SessionState | undefined> {
    if (this.closed) return undefined;

    const session = getLiveSessionById(this.opts.core.accessor, sessionId);
    if (session === undefined) return undefined;

    const journal = await SessionEventJournal.open(
      sessionJournalPath(this.opts.eventsDir, sessionId),
      this.opts.logger,
    );
    if (this.closed) {
      await journal.close();
      return undefined;
    }
    const state: SessionState = {
      sessionId,
      journal,
      tracker: new InFlightTurnTracker(),
      roster: new SubagentRosterTracker(),
      tail: [],
      targets: new Map(),
      queue: Promise.resolve(),
      agentDisposables: new Map(),
      lifecycleDisposables: [],
      knownInteractions: new Map(),
      transcriptSeeded: new Set(),
      deferredTranscriptSeeds: new Map(),
    };
    this.sessions.set(sessionId, state);
    try {
      this.attachWorkView(session, state);
      this.attachAgents(sessionId, session, state);
      this.attachInteractions(sessionId, session, state);
    } catch (error) {
      this.sessions.delete(sessionId);
      await disposeSessionState(state);
      if (
        error instanceof Error &&
        error.message === "InstantiationService has been disposed"
      )
        return undefined;
      throw error;
    }
    return state;
  }

  private ensureGlobalState(): Promise<SessionState> {
    const existing = this.sessions.get(GLOBAL_SESSION_ID);
    if (existing !== undefined) return Promise.resolve(existing);
    let pending = this.pendingStates.get(GLOBAL_SESSION_ID);
    if (pending === undefined) {
      pending = this.createGlobalState().finally(() => {
        if (this.pendingStates.get(GLOBAL_SESSION_ID) === pending) {
          this.pendingStates.delete(GLOBAL_SESSION_ID);
        }
      });
      this.pendingStates.set(GLOBAL_SESSION_ID, pending);
    }
    return pending as Promise<SessionState>;
  }

  private async createGlobalState(): Promise<SessionState> {
    const journal = await SessionEventJournal.open(
      sessionJournalPath(this.opts.eventsDir, GLOBAL_SESSION_ID),
      this.opts.logger,
    );
    const state: SessionState = {
      sessionId: GLOBAL_SESSION_ID,
      journal,
      tracker: new InFlightTurnTracker(),
      roster: new SubagentRosterTracker(),
      tail: [],
      targets: new Map(),
      queue: Promise.resolve(),
      agentDisposables: new Map(),
      lifecycleDisposables: [],
      knownInteractions: new Map(),
      transcriptSeeded: new Set(),
      deferredTranscriptSeeds: new Map(),
    };
    this.sessions.set(GLOBAL_SESSION_ID, state);
    return state;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.coreEventSubscription.dispose();
    for (const [sessionId, state] of this.sessions) {
      await disposeSessionState(state);
      // Transcript bindings die with the session stream (its store
      // subscriptions were disposed above; the producer binding goes here).
      this.opts.transcriptService?.dropSession(sessionId);
    }
    this.sessions.clear();
  }

  protected *allTargets(): Iterable<BroadcastTarget> {
    for (const state of this.sessions.values()) {
      for (const target of state.targets.keys()) yield target;
    }
  }
}

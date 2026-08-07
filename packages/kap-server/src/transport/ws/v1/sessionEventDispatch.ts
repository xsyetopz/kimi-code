import type { AgentActivityState, DomainEvent, GlobalEvent, IAgentScopeHandle, IDisposable, ISessionScopeHandle, SessionActivityState } from "@moonshot-ai/agent-core-v2";
import { IAgentLifecycleService, IEventBus, ISessionActivityView, ISessionInteractionService, MAIN_AGENT_ID } from "@moonshot-ai/agent-core-v2";
import type { Event } from "./events";
import { isVolatileEventType } from "./events";
import { readLegacyStatus, toLegacyPhase } from "../../../services/legacyStatus/legacyStatus";
import type { EventEnvelope } from "./sessionEventJournal";
import type { BroadcastTarget, SessionState } from "./sessionEventBroadcasterTypes";
import { GLOBAL_SESSION_ID, configWarningPayload, interactionRequestedEvent, interactionResolvedEvent, isGlobalEvent, isVolatileSignal, legacyTaskEvent, matchesAgentFilter, sessionCreatedPayload, sessionMetaUpdatedPayload, sessionMetaUpdatedSessionId, suppressedByTranscript } from "./sessionEventWireMapping";
import { SessionEventTranscriptStream } from "./sessionEventTranscriptStream";

export abstract class SessionEventDispatch extends SessionEventTranscriptStream {
  protected abstract readonly globalTargets: Set<BroadcastTarget>;
  protected abstract readonly maxBufferSize: number;
  protected abstract readonly sessions: Map<string, SessionState>;
  protected abstract *allTargets(): Iterable<BroadcastTarget>;

  protected onCoreEvent(event: GlobalEvent): void {
    if (event.type === "event.session.created") {
      const payload = sessionCreatedPayload(event.payload);
      if (payload === undefined) return;
      // Forward creation to every connection (`isGlobalEvent` already matches
      // `event.session.*`), routed through the real session so the envelope
      // carries the real `session_id` (not the `__global__` watermark) — exactly
      // like `session.meta.updated` below. Without this, clients that didn't
      // issue the create never learn the session exists, so a later
      // `sessionStatusChanged` reducer is a no-op for the unknown session and
      // kimi-web's Stop button (gated on session.status === 'running') never
      // renders. Mirrors v1's `isGlobalSessionEvent` broadcast of creation.
      void this.dispatchSessionEvent(payload.sessionId, {
        type: "event.session.created",
        session: payload.session,
        agentId: "main",
        sessionId: payload.sessionId,
      } as Event).catch((error: unknown) =>
        this.logDispatchError(
          payload.sessionId,
          "event.session.created",
          error,
        ),
      );
      return;
    }
    if (event.type === "session.meta.updated") {
      const payload = sessionMetaUpdatedPayload(event.payload);
      if (payload === undefined) return;
      // The originating session id travels on the core payload (the v1 protocol
      // event itself carries only title/patch). Recover it so the WS envelope is
      // addressed to the real session: routing through the global state would
      // stamp `session_id = '__global__'`, and clients would fail to match the
      // event to any sidebar session — so the auto-generated title (or a rename
      // from another client) would never appear. `isGlobalEvent` still fans the
      // dispatch out to every connection, so non-subscribed clients stay in sync
      // exactly like v1.
      const sessionId = sessionMetaUpdatedSessionId(event.payload);
      if (sessionId === undefined) return;
      void this.dispatchSessionEvent(sessionId, {
        type: "session.meta.updated",
        ...payload,
        agentId: "main",
        sessionId,
      } as Event).catch((error: unknown) =>
        this.logDispatchError(sessionId, "session.meta.updated", error),
      );
      return;
    }
    if (event.type === "event.config.warning") {
      const payload = configWarningPayload(event.payload);
      if (payload === undefined) return;
      // Global fan-out: every established connection learns the current config
      // warning set (deprecated keys/env vars in use, invalid sections) without
      // subscribing to anything. Delivery is live-only — late joiners pull the
      // diagnostics RPC surface instead.
      void this.dispatchGlobal({
        type: "event.config.warning",
        warnings: payload.warnings,
        agentId: "main",
        sessionId: GLOBAL_SESSION_ID,
      } as Event).catch((error: unknown) =>
        this.logDispatchError(GLOBAL_SESSION_ID, "event.config.warning", error),
      );
    }
  }

  protected async dispatchGlobal(event: Event): Promise<void> {
    const state = await this.ensureGlobalState();
    state.queue = state.queue
      .then(() => this.dispatch(state, event, isVolatileEventType(event.type)))
      .catch((error: unknown) =>
        this.logDispatchDropped(state.sessionId, event.type, error),
      );
  }

  /**
   * Dispatch an event through a real session's state so the WS envelope carries
   * the real `session_id` (not the global `'__global__'` watermark). Used for
   * session-scoped core events that must still fan out to every connection
   * (e.g. `session.meta.updated`); `isGlobalEvent` keeps the fan-out global.
   */
  protected async dispatchSessionEvent(
    sessionId: string,
    event: Event,
  ): Promise<void> {
    let state: SessionState | undefined;
    try {
      state = await this.ensureState(sessionId);
    } catch (error) {
      // The session's core scope can be disposed mid-dispatch during shutdown;
      // the event is moot once its session is gone. Same guard as ensureState
      // applies around attach*, extended to the accessor reads above it.
      if (
        error instanceof Error &&
        error.message === "InstantiationService has been disposed"
      ) {
        return;
      }
      throw error;
    }
    if (state === undefined) return;
    state.queue = state.queue
      .then(() => this.dispatch(state, event, isVolatileEventType(event.type)))
      .catch((error: unknown) =>
        this.logDispatchDropped(state.sessionId, event.type, error),
      );
  }

  /**
   * Bridge the core's session work aggregate (`ISessionActivityView`) onto
   * the v1 `event.session.work_changed` frame. The view owns the fold and
   * its change dedup; the edge only schedules the wire emission. Every cause
   * except `turn_ended` emits immediately. A `turn_ended` change must land
   * after the matching `turn.ended` frame, but the agent bus fires
   * full-stream subscribers (the edge's own handler) before per-type ones
   * (the activity view chain that reports this change) — so the state is
   * buffered and flushed from a microtask: the microtask runs after the
   * whole synchronous publish, by which time the `turn.ended` frame is
   * already enqueued on the session queue, and the emission can never be
   * stranded behind a flush that already ran.
   */
  protected attachWorkView(
    session: ISessionScopeHandle,
    state: SessionState,
  ): void {
    const workView = session.accessor.get(ISessionActivityView);
    // The view is a Delayed service: an event subscription alone never
    // constructs it — touch `state()` so the fold is live from activation on.
    workView.state();
    state.lifecycleDisposables.push(
      workView.onDidChange(({ state: work, cause }) => {
        if (cause === "turn_ended") {
          state.deferredWork = work;
          queueMicrotask(() => {
            // The session may have been torn down meanwhile.
            if (this.sessions.get(state.sessionId) !== state) return;
            this.flushDeferredWork(state);
          });
          return;
        }
        this.flushDeferredWork(state);
        this.enqueueWorkChanged(state, work);
      }),
    );
  }

  protected flushDeferredWork(state: SessionState): void {
    const deferred = state.deferredWork;
    if (deferred === undefined) return;
    state.deferredWork = undefined;
    this.enqueueWorkChanged(state, deferred);
  }

  protected attachAgents(
    sessionId: string,
    session: ISessionScopeHandle,
    state: SessionState,
  ): void {
    const agents = session.accessor.get(IAgentLifecycleService);
    const subscribeAgent = (handle: IAgentScopeHandle): void => {
      if (state.agentDisposables.has(handle.id)) return;
      state.agentDisposables.set(
        handle.id,
        this.attachAgent(sessionId, handle),
      );
    };
    for (const handle of agents.list()) subscribeAgent(handle);
    state.lifecycleDisposables.push(
      agents.onDidCreate((handle) => {
        subscribeAgent(handle);
        // Session-grained lifecycle fact, ahead of any of the agent's own
        // events: `onDidCreate` fires before the agent's eager services
        // ignite, so this enqueue lands first in the queue.
        this.enqueueDurable(state, {
          type: "agent.created",
          agentId: handle.id,
          sessionId,
        });
      }),
      agents.onDidDispose((agentId) => {
        const d = state.agentDisposables.get(agentId);
        if (d !== undefined) {
          d.dispose();
          state.agentDisposables.delete(agentId);
          this.enqueueDurable(state, {
            type: "agent.disposed",
            agentId,
            sessionId,
          });
        }
      }),
    );
  }

  protected attachAgent(
    sessionId: string,
    handle: IAgentScopeHandle,
  ): IDisposable {
    const eventBus = handle.accessor.get(IEventBus);
    let lastLegacyStatus: string | undefined;
    const emitLegacyStatus = (): void => {
      const snapshot = readLegacyStatus(handle);
      if (snapshot === undefined) return;
      const key = JSON.stringify(snapshot);
      if (key === lastLegacyStatus) return;
      lastLegacyStatus = key;
      this.onAgentEvent(sessionId, MAIN_AGENT_ID, {
        type: "agent.status.updated",
        ...snapshot,
      });
    };
    const disposables: IDisposable[] = [
      eventBus.subscribe((event) => {
        let projected = event;
        if (event.type === "agent.status.updated") {
          // v2 emits status in slices, and the model slice rides only the
          // bind-time emission — for a subagent that lands before the client
          // has seen `subagent.spawned` and is dropped there, leaving the
          // subagent card without a model. Fold the full legacy snapshot
          // (usage + context + model) into every agent's status event so the
          // v1 combined-payload contract holds regardless of slice timing.
          const snapshot = readLegacyStatus(handle);
          if (snapshot !== undefined) {
            lastLegacyStatus = JSON.stringify(snapshot);
            projected = { ...event, ...snapshot };
          }
        }
        if (handle.id === MAIN_AGENT_ID && event.type === "context.spliced") {
          emitLegacyStatus();
        }
        this.onAgentEvent(sessionId, handle.id, projected);
      }),
    ];

    return {
      dispose: () => disposables.forEach((disposable) => disposable.dispose()),
    };
  }

  protected onAgentEvent(
    sessionId: string,
    agentId: string,
    event: DomainEvent,
  ): void {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return;

    // Map the native v2 activity state to the legacy v1 `agent.status.updated`
    // phase slice at the edge, so the v1 channel picks up the corrected
    // semantics (approval-set, idle-after-ended) without the core engine
    // carrying v1 compatibility. The core's own `agent.status.updated` phase
    // slice is dropped here to avoid duplicate phase events; other slices
    // (usage / context / plan / swarm) flow through unchanged. The session's
    // work aggregate (busy / last_turn_reason) is the core
    // `ISessionActivityView`'s job — see attachWorkView.
    if (event.type === "agent.activity.updated") {
      const snapshot = event as unknown as AgentActivityState;
      const phase = toLegacyPhase(snapshot);
      if (phase !== undefined) {
        const wireEvent = {
          type: "agent.status.updated",
          phase,
          agentId,
          sessionId,
        } as unknown as Event;
        state.queue = state.queue
          .then(() => this.dispatch(state, wireEvent, true))
          .catch((error: unknown) =>
            this.logDispatchDropped(state.sessionId, wireEvent.type, error),
          );
      }
      return;
    }
    if (
      event.type === "agent.status.updated" &&
      (event as { phase?: unknown }).phase !== undefined
    ) {
      return;
    }

    // The migrated agent events are AgentEvent-shaped by construction (they were
    // ported from the former `record.signal(agentEvent)` call sites); the declared
    // `DomainEventMap` payload types are deliberately wider than the protocol
    // contract, hence the assertion via `unknown`.
    const wireEvent = { ...event, agentId, sessionId } as unknown as Event;
    const volatile = isVolatileSignal(event.type);
    state.queue = state.queue
      .then(() => this.dispatch(state, wireEvent, volatile))
      .catch((error: unknown) =>
        this.logDispatchDropped(state.sessionId, wireEvent.type, error),
      );
    // v1 wire compat: fan the legacy `background.task.*` spelling out next to
    // the native `task.*` event (see `legacyTaskEvent`) so unchanged v1 clients
    // keep working while v2-shaped clients ignore the alias. Same volatility as
    // the native event so replay/journal/filter stay coherent between the two.
    const legacy = legacyTaskEvent(event, agentId, sessionId);
    if (legacy !== undefined) {
      state.queue = state.queue
        .then(() => this.dispatch(state, legacy, volatile))
        .catch((error: unknown) =>
          this.logDispatchDropped(state.sessionId, legacy.type, error),
        );
    }
  }

  /**
   * Bridge the session's interaction kernel (approvals / questions) onto the
   * v1 event stream. The kernel only emits in-process notifications
   * (`onDidChangePending` / `onDidResolve`), so the v1 protocol events are
   * synthesized here.
   */
  protected attachInteractions(
    sessionId: string,
    session: ISessionScopeHandle,
    state: SessionState,
  ): void {
    const interactions = session.accessor.get(ISessionInteractionService);
    // Seed silently: interactions already pending at activation are surfaced
    // by the snapshot route (`pending_questions` / `pending_approvals`).
    for (const i of interactions.listPending()) {
      state.knownInteractions.set(i.id, {
        kind: i.kind,
        agentId: i.origin.agentId ?? "main",
      });
    }
    state.lifecycleDisposables.push(
      interactions.onDidChangePending(() => {
        // The session's pending-interaction work slice is recomputed by the
        // core `ISessionActivityView` off this same notification — here only
        // the protocol events for newly pending requests are synthesized.
        for (const i of interactions.listPending()) {
          if (state.knownInteractions.has(i.id)) continue;
          state.knownInteractions.set(i.id, {
            kind: i.kind,
            agentId: i.origin.agentId ?? "main",
          });
          const event = interactionRequestedEvent(i, sessionId);
          if (event !== undefined) {
            this.enqueueDurable(state, event);
          }
        }
      }),
      interactions.onDidResolve(({ id, response }) => {
        const known = state.knownInteractions.get(id);
        if (known === undefined) return;
        state.knownInteractions.delete(id);
        const event = interactionResolvedEvent(
          known.kind,
          id,
          response,
          sessionId,
          known.agentId,
        );
        if (event !== undefined) {
          this.enqueueDurable(state, event);
        }
      }),
    );
  }

  protected enqueueDurable(state: SessionState, event: Event): void {
    state.queue = state.queue
      .then(() => this.dispatch(state, event, false))
      .catch((error: unknown) =>
        this.logDispatchDropped(state.sessionId, event.type, error),
      );
  }

  /**
   * Emit `event.session.work_changed` for one aggregate change announced by
   * the core `ISessionActivityView` (the view already dedups — every call
   * here is a real tuple change).
   */
  protected enqueueWorkChanged(
    state: SessionState,
    work: SessionActivityState,
  ): void {
    state.queue = state.queue
      .then(() =>
        this.dispatch(
          state,
          {
            type: "event.session.work_changed",
            busy: work.busy,
            main_turn_active: work.mainTurnActive,
            pending_interaction: work.pendingInteraction,
            last_turn_reason: work.lastTurnReason,
            agentId: "main",
            sessionId: state.sessionId,
          } as Event,
          false,
        ),
      )
      .catch((error: unknown) =>
        this.logDispatchDropped(
          state.sessionId,
          "event.session.work_changed",
          error,
        ),
      );
  }

  /**
   * Log a rejected `dispatchSessionEvent` promise — the session's scope was
   * torn down mid-dispatch, or a non-disposed error escaped `ensureState`.
   */
  protected logDispatchError(
    sessionId: string,
    eventType: string,
    error: unknown,
  ): void {
    const logger = this.opts.logger;
    if (logger === undefined) return;
    if (logger.error !== undefined) {
      logger.error(
        { sessionId, eventType, err: error },
        "session event dispatch failed",
      );
    } else {
      logger.warn(
        { sessionId, eventType, err: error },
        "session event dispatch failed",
      );
    }
  }

  /**
   * A queued dispatch rejected: the event is permanently lost (and, for durable
   * events, the seq is skipped). Warn instead of swallowing it silently.
   */
  protected logDispatchDropped(
    sessionId: string,
    eventType: string,
    error: unknown,
  ): void {
    this.opts.logger?.warn(
      { sessionId, eventType, err: error },
      "session event dispatch failed; event dropped",
    );
  }

  protected async dispatch(
    state: SessionState,
    event: Event,
    volatile: boolean,
  ): Promise<void> {
    const { journal, tracker, roster, tail, targets, sessionId } = state;
    const annotation = tracker.apply(sessionId, event);
    // Same queue-discipline as the in-flight tracker: snapshot rebuilds must
    // see exactly the roster as of the durable watermark.
    roster.apply(sessionId, event);

    let envelope: EventEnvelope;
    if (volatile) {
      envelope = this.buildEnvelope(journal.seq, sessionId, event, {
        epoch: journal.epoch,
        volatile: true,
        ...(annotation.offset !== undefined
          ? { offset: annotation.offset }
          : {}),
      });
    } else {
      const seq = journal.nextSeq();
      envelope = this.buildEnvelope(seq, sessionId, event, {
        epoch: journal.epoch,
      });
      journal.append(seq, envelope);
      tail.push({ seq, envelope });
      while (tail.length > this.maxBufferSize) tail.shift();
    }

    if (isGlobalEvent(event.type)) {
      // Global events (session/workspace/config) are not agent events — fan
      // out to every established connection (globalTargets) union every
      // subscribed target, regardless of any agent filter. The union keeps
      // targets that subscribed without a global registration (test doubles,
      // minimal embeds) on the legacy delivery path.
      const recipients = new Set<BroadcastTarget>(this.globalTargets);
      for (const target of this.allTargets()) recipients.add(target);
      for (const target of recipients) {
        try {
          target.send(envelope, "immediate");
        } catch {
          // best-effort fan-out; a broken target is dropped, not fatal
        }
      }
    } else {
      for (const [target, sub] of targets) {
        if (!matchesAgentFilter(envelope, sub.agentFilter)) continue;
        // Transcript subscribers already receive the projected equivalent of
        // this event — drop the duplicate session_event on their send view.
        if (suppressedByTranscript(envelope, sub.transcriptGrades)) continue;
        try {
          target.send(envelope);
        } catch {
          // best-effort fan-out; a broken target is dropped, not fatal
        }
      }
    }
  }

  protected buildEnvelope(
    seq: number,
    sessionId: string,
    event: Event,
    extras: { epoch?: string; volatile?: boolean; offset?: number },
  ): EventEnvelope {
    return {
      type: event.type,
      seq,
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      payload: event,
      ...extras,
    };
  }

  protected *allTargets(): Iterable<BroadcastTarget> {
    for (const state of this.sessions.values()) {
      for (const target of state.targets.keys()) yield target;
    }
  }
}

import type { BroadcastTarget, SessionState } from "./sessionEventBroadcasterTypes";
import { TRANSCRIPT_RESET_TAIL_TURNS } from "./sessionEventBroadcasterTypes";
import type { TranscriptService } from "../../../services/transcript/transcriptService";
import {
  detachGrades, filterOpsForGrade, gradeFor, needsResetOnTransition, redactSnapshotForGrade,
  type AgentTranscript, type TranscriptGrade, type TranscriptGradeSpec, type TranscriptOperation,
  type TranscriptOpsEvent, type TranscriptResetEvent, type TranscriptStore,
} from "@moonshot-ai/transcript";
import type { EventEnvelope } from "./sessionEventJournal";

export abstract class SessionEventTranscriptStream {
  protected abstract readonly opts: {
    readonly eventsDir: string;
    readonly transcriptService?: TranscriptService;
  };
  protected abstract readonly sessions: Map<string, SessionState>;

  protected willSendTranscriptReset(
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

  // ---------------------------------------------------------------------------
  // Transcript streaming (v1 incremental add-on; the durable event path is
  // untouched — transcript frames never advance seq and never touch the journal)
  // ---------------------------------------------------------------------------

  /**
   * Handle one connection's transcript subscription: attach the shared
   * per-session stream on first use and send `transcript.reset` snapshots for
   * every known agent admitted by `spec` that is an upgrade over the
   * connection's previous grade. A cold session (not live in this process)
   * silently skips streaming — cold transcripts stay REST-only. Live sessions
   * first await the initial wire-records backfill, so the seeded resets carry
   * the established main-agent transcript. Explicitly graded agents AND roster
   * agents admitted via the wildcard get their persisted history replayed
   * before their first reset — a roster agent whose `AgentTranscript` was
   * never materialized has nothing to snapshot, so without the backfill its
   * baseline is silently skipped. Grades are re-read from `state.targets`
   * after the awaits: subscribe work runs asynchronously, and a newer
   * subscribe/unsubscribe must not be answered with stale resets.
   */
  protected async subscribeTranscript(
    state: SessionState,
    target: BroadcastTarget,
    spec: TranscriptGradeSpec,
    prev: TranscriptGradeSpec | undefined,
    transcriptSince?: Record<string, number>,
  ): Promise<void> {
    const service = this.opts.transcriptService;
    if (service === undefined) return;
    const store = service.forSessionLive(state.sessionId);
    if (store === undefined) return;
    await service.whenReady(state.sessionId);
    const backfill = new Set(
      Object.keys(spec).filter(
        (agentId) => agentId !== "*" && gradeFor(spec, agentId) !== "off",
      ),
    );
    for (const descriptor of store.agents()) {
      if (gradeFor(spec, descriptor.agentId) !== "off")
        backfill.add(descriptor.agentId);
    }
    await Promise.all(
      [...backfill].map((agentId) =>
        service.ensureAgentHistory(state.sessionId, agentId),
      ),
    );
    // A newer subscribe/unsubscribe may have replaced this target's grades
    // while history was loading — only the latest subscription is owed resets.
    const current = state.targets.get(target);
    if (current?.transcriptGrades === undefined) return;
    const currentSpec = current.transcriptGrades;
    this.ensureTranscriptStream(state, store);
    for (const descriptor of store.agents()) {
      const grade = gradeFor(currentSpec, descriptor.agentId);
      if (grade === "off") continue;
      const transcript = store.getAgent(descriptor.agentId);
      if (transcript === undefined) continue;
      // A catch-up cursor the journal still covers replaces the baseline
      // reset: replay exactly the batches past the cursor (grade-filtered, in
      // seq order) and the connection converges without a snapshot. Anything
      // the journal cannot vouch for falls through to the ordinary reset.
      const since =
        transcriptSince?.[descriptor.agentId] ?? transcriptSince?.["*"];
      if (since !== undefined) {
        const catchup = service.getOpsSince(
          state.sessionId,
          descriptor.agentId,
          since,
        );
        if (catchup !== undefined && catchup.complete) {
          this.replayTranscriptOps(
            state,
            target,
            descriptor.agentId,
            grade,
            catchup.batches,
          );
          continue;
        }
      }
      if (!needsResetOnTransition(gradeFor(prev, descriptor.agentId), grade)) {
        continue;
      }
      this.sendTranscriptReset(state, target, transcript, grade);
    }
  }

  /**
   * Replay journaled op batches to one connection (the `transcript_since`
   * catch-up path), grade-filtered like the live fan-out and stamped with
   * their original batch seqs.
   */
  protected replayTranscriptOps(
    state: SessionState,
    target: BroadcastTarget,
    agentId: string,
    grade: TranscriptGrade,
    batches: readonly { seq: number; ops: readonly TranscriptOperation[] }[],
  ): void {
    for (const batch of batches) {
      const filtered = filterOpsForGrade(grade, batch.ops);
      if (filtered.length === 0) continue;
      try {
        target.send(
          this.buildTranscriptEnvelope(state, "transcript.ops", {
            agent_id: agentId,
            ops: filtered,
            seq: batch.seq,
          }),
        );
      } catch {
        // best-effort fan-out; a broken target is dropped, not fatal
      }
    }
  }

  /**
   * Attach the session's shared transcript fan-out: one mapped-ops
   * subscription for the whole session (grade filtering happens per target at
   * fan-out). New agents appearing later seed a `transcript.reset` for every
   * connected target whose grade admits them. The attachment is pinned to the
   * store instance: when the engine session closes, the service drops the
   * store together with its ops listener set while this session state
   * survives, so a subscribe after an in-daemon session resume must
   * re-register the fan-out against the rebuilt store — returning early on
   * any stale stream would deliver resets but never the live ops.
   */
  protected ensureTranscriptStream(
    state: SessionState,
    store: TranscriptStore,
  ): void {
    if (state.transcriptStream?.store === store) return;
    const service = this.opts.transcriptService;
    if (service === undefined) return;
    const stream: TranscriptStream = {
      store,
      knownAgents: new Set(store.agents().map((d) => d.agentId)),
    };
    state.transcriptStream = stream;

    const opsDisposable = service.onSessionOps(
      state.sessionId,
      ({ agentId, ops }, seq) => {
        for (const [target, sub] of state.targets) {
          // No ops before the baseline reset (see subscribe).
          if (!state.transcriptSeeded.has(target)) continue;
          const grade = gradeFor(sub.transcriptGrades, agentId);
          const filtered = filterOpsForGrade(grade, ops);
          if (filtered.length === 0) continue;
          try {
            target.send(
              this.buildTranscriptEnvelope(state, "transcript.ops", {
                agent_id: agentId,
                ops: filtered,
                seq,
              }),
            );
          } catch {
            // best-effort fan-out; a broken target is dropped, not fatal
          }
        }
      },
    );
    if (opsDisposable !== undefined)
      state.lifecycleDisposables.push(opsDisposable);

    state.lifecycleDisposables.push(
      store.onRosterChange((agents) => {
        for (const descriptor of agents) {
          if (stream.knownAgents.has(descriptor.agentId)) continue;
          stream.knownAgents.add(descriptor.agentId);
          const transcript = store.getAgent(descriptor.agentId);
          if (transcript === undefined) continue;
          for (const [target, sub] of state.targets) {
            if (!state.transcriptSeeded.has(target)) continue;
            const grade = gradeFor(sub.transcriptGrades, descriptor.agentId);
            if (grade === "off") continue;
            try {
              this.sendTranscriptReset(state, target, transcript, grade);
            } catch {
              // best-effort fan-out; a broken target is dropped, not fatal
            }
          }
        }
      }),
    );
  }

  /**
   * Volatile `transcript.reset` baseline: an items-empty snapshot (global
   * state only, redacted to the target's grade) plus the seq watermark.
   * History is paged over REST; live ops stream from the watermark.
   */
  protected sendTranscriptReset(
    state: SessionState,
    target: BroadcastTarget,
    transcript: AgentTranscript,
    grade: TranscriptGrade,
  ): void {
    const snapshot = redactSnapshotForGrade(
      grade,
      transcript.snapshot({ tailTurns: TRANSCRIPT_RESET_TAIL_TURNS }),
    );
    target.send(
      this.buildTranscriptEnvelope(state, "transcript.reset", {
        agent_id: transcript.agentId,
        snapshot,
        has_more_older: snapshot.hasMoreOlder ?? false,
        // Watermark: the snapshot includes every op batch dispatched so far.
        seq: this.opts.transcriptService?.getSeqWatermark(
          state.sessionId,
          transcript.agentId,
        ),
      }),
    );
  }

  /**
   * All transcript frames are volatile and carry the current durable watermark
   * as `seq` (they never advance it and are never journaled or replayed). The
   * payload is the flat protocol event (`{ type, agent_id, … }`), matching the
   * `transcriptResetEventSchema` / `transcriptOpsEventSchema` shapes.
   */
  protected buildTranscriptEnvelope(
    state: SessionState,
    type: "transcript.reset" | "transcript.ops",
    payload:
      | Omit<TranscriptResetEvent, "type">
      | Omit<TranscriptOpsEvent, "type">,
  ): EventEnvelope {
    return {
      type,
      seq: state.journal.seq,
      epoch: state.journal.epoch,
      volatile: true,
      session_id: state.sessionId,
      timestamp: new Date().toISOString(),
      payload: { type, ...payload },
    };
  }
}

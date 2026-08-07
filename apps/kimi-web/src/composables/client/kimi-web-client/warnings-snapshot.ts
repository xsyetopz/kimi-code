import { i18n } from "../../../i18n";
import { traceKeyEvent } from "../../../debug/trace";
import { getKimiWebApi } from "../../../api";
import { isDaemonApiError, isDaemonNetworkError } from "../../../api/errors";
import { createCoalescedAsyncRunner } from "../../../lib/snapshotSync";
import { mergeSnapshotMessages } from "../../../lib/snapshotMessages";
import { mergeSnapshotSubagents } from "../../../lib/taskMerge";
import { isPlaceholderSessionUsage } from "../../../api/daemon/mappers";
import type {
  AppNotice,
  AppNoticeDetail,
  AppWarning,
} from "../../../api/types";
import {
  rawState,
  eventConn,
  epochBySession,
  sessionsRequiringSnapshot,
  sessionsRetryingStaleSnapshot,
  sessionWarningsPulled,
  wsSubscriptionOrder,
  sessionsWithStaleCursor,
  SESSION_NOT_FOUND_CODE,
  GOAL_ERROR_KEYS,
  MAX_WS_SUBSCRIPTIONS,
  workspaceState,
  enqueueEvent,
} from "./runtime";
import {
  forgetSession,
  updateSession,
  setSessionMessages,
  setActiveSessionId,
} from "./session-mutations";
import { refreshSessionStatus } from "./session-refresh";
import { connectEventsIfNeeded } from "./event-connection";

export function isSessionNotFoundError(err: unknown): boolean {
  if (isDaemonApiError(err) && err.code === SESSION_NOT_FOUND_CODE) return true;
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === SESSION_NOT_FOUND_CODE
  );
}

export function warningDetail(
  labelKey: string,
  value: unknown,
): AppNoticeDetail | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return {
    label: i18n.global.t(`warnings.details.${labelKey}`),
    value: formatDetailValue(value),
  };
}

export function formatDetailValue(value: unknown): string {
  if (value instanceof Error) {
    // A stack already starts with "Name: message" and carries the frames the
    // plain name/message would throw away, so prefer it when present.
    if (typeof value.stack === "string" && value.stack) return value.stack;
    return value.message ? `${value.name}: ${value.message}` : value.name;
  }
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function errorName(err: unknown): string | undefined {
  return err instanceof Error
    ? err.name
    : typeof err === "object" &&
        err !== null &&
        typeof (err as { name?: unknown }).name === "string"
      ? (err as { name: string }).name
      : undefined;
}

export function errorMessage(err: unknown): string | undefined {
  return err instanceof Error
    ? err.message
    : typeof err === "object" &&
        err !== null &&
        typeof (err as { message?: unknown }).message === "string"
      ? (err as { message: string }).message
      : undefined;
}

export function errorStack(err: unknown): string | undefined {
  return err instanceof Error && typeof err.stack === "string" && err.stack
    ? err.stack
    : undefined;
}

export function formatTimestamp(ms: number | undefined): string | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

export function formatDuration(ms: number | undefined): string | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return undefined;
  return `${Math.round(ms)}ms`;
}

export function errorDetails(
  operation: string,
  err: unknown,
  sessionId?: string,
): AppNoticeDetail[] {
  const network = isDaemonNetworkError(err);
  const api = isDaemonApiError(err);
  // Daemon errors carry the failure moment + round-trip time captured in the
  // HTTP layer; fall back to "now" for client-side errors that have neither.
  const timestamp = network || api ? err.timestamp : undefined;
  const durationMs = network || api ? err.durationMs : undefined;

  const details: Array<AppNoticeDetail | undefined> = [
    warningDetail("operation", operation),
    // Many call sites don't pass a session id; the active session is the best
    // guess and is what the user was looking at when the failure happened.
    warningDetail("sessionId", sessionId ?? rawState.activeSessionId),
    warningDetail("connection", rawState.connection),
    warningDetail("timestamp", formatTimestamp(timestamp ?? Date.now())),
  ];

  if (network) {
    details.push(
      warningDetail("duration", formatDuration(durationMs)),
      warningDetail("request", `${err.method} ${err.path}`),
      warningDetail("endpoint", err.url),
      warningDetail("requestId", err.requestId),
      warningDetail("phase", err.phase),
      warningDetail("timeout", `${err.timeoutMs}ms`),
      warningDetail(
        "status",
        err.status === undefined
          ? undefined
          : `${err.status} ${err.statusText ?? ""}`.trim(),
      ),
      warningDetail("contentType", err.contentType),
      warningDetail("responsePreview", err.bodyPreview),
      warningDetail("cause", err.cause),
    );
  } else if (api) {
    details.push(
      warningDetail("duration", formatDuration(durationMs)),
      warningDetail("code", err.code),
      warningDetail("requestId", err.requestId),
      warningDetail("message", err.message),
      warningDetail("details", err.details),
    );
  } else {
    details.push(
      warningDetail("errorName", errorName(err)),
      warningDetail("message", errorMessage(err) ?? formatDetailValue(err)),
      warningDetail("stack", errorStack(err)),
    );
  }

  return details.filter(
    (detail): detail is AppNoticeDetail => detail !== undefined,
  );
}

export function operationFailureNotice(
  operation: string,
  err: unknown,
  opts: { title?: string; message?: string; sessionId?: string } = {},
): AppNotice {
  const network = isDaemonNetworkError(err);
  const api = isDaemonApiError(err);
  const title =
    opts.title ??
    (network
      ? i18n.global.t("warnings.daemonNetworkTitle")
      : api
        ? i18n.global.t("warnings.daemonApiTitle")
        : i18n.global.t("warnings.operationFailedTitle"));
  const message =
    opts.message ??
    (network
      ? i18n.global.t("warnings.daemonNetworkMessage")
      : api
        ? err.message
        : i18n.global.t("warnings.operationFailedMessage"));
  return {
    severity: "error",
    title,
    message,
    details: errorDetails(operation, err, opts.sessionId),
  };
}

export function pushWarning(warning: AppWarning): void {
  rawState.warnings = [...rawState.warnings, warning];
}

// Drop every "Realtime connection error" notice pushed by the WS onError
// handler. Matched by severity + the localized wsTitle (the same i18n instance
// used to push it), so other errors are left untouched.
export function dismissWsError(): void {
  const title = i18n.global.t("warnings.wsTitle");
  const next = rawState.warnings.filter(
    (w) =>
      !(
        typeof w === "object" &&
        w !== null &&
        w.severity === "error" &&
        w.title === title
      ),
  );
  if (next.length !== rawState.warnings.length) {
    rawState.warnings = next;
  }
}

export function pushOperationFailure(
  operation: string,
  err: unknown,
  opts?: { title?: string; message?: string; sessionId?: string },
): void {
  // Always-on logging: a surfaced failure must be diagnosable from the console
  // and from the exported web log (session export), not just from the toast.
  console.error(`[kimi-web] operation failed: ${operation}`, err);
  const api = isDaemonApiError(err);
  const network = isDaemonNetworkError(err);
  traceKeyEvent("operation:failed", {
    sessionId: opts?.sessionId,
    status: "failed",
    operation,
    errorName: err instanceof Error ? err.name : typeof err,
    errorCode: api ? err.code : undefined,
    requestId: api || network ? err.requestId : undefined,
    phase: network ? err.phase : undefined,
    httpStatus: network ? err.status : undefined,
  });
  pushWarning(operationFailureNotice(operation, err, opts));
}

// Goal-specific protocol error codes (40913–40918). The daemon now returns
// these instead of a bare 500, so map them to a friendly explanation rather
// than dumping the raw envelope message on the user.

export function goalErrorMessage(err: unknown): string | undefined {
  if (!isDaemonApiError(err)) return undefined;
  const key = GOAL_ERROR_KEYS[err.code];
  return key ? i18n.global.t(key) : undefined;
}

export async function handleSessionNotFound(sessionId: string): Promise<void> {
  forgetSession(sessionId);

  if (rawState.activeSessionId !== sessionId) return;

  const next = rawState.sessions[0];
  if (next) {
    await workspaceState!.selectSession(next.id, { urlMode: "replace" });
  } else {
    setActiveSessionId(undefined);
    rawState.sessionLoading = false;
    workspaceState!.writeSessionUrl(undefined, "replace");
  }
}


export async function pullSessionWarnings(sessionId: string): Promise<void> {
  if (sessionWarningsPulled.has(sessionId)) return;
  sessionWarningsPulled.add(sessionId);
  try {
    const warnings = await getKimiWebApi().getSessionWarnings(sessionId);
    const label = i18n.global.t("warnings.noteLabel");
    for (const warning of warnings) {
      pushWarning(`${label}: ${warning.message}`);
    }
  } catch {
    // best-effort: never block session sync on warning retrieval.
  }
}

export async function syncSessionFromSnapshot(
  sessionId: string,
): Promise<SyncSessionResult> {
  // A snapshot that races a local turn start must not overwrite that turn.
  const turnStartAtRequest = workspaceState!.localTurnStartState(sessionId);
  try {
    const api = getKimiWebApi();
    const snap = await api.getSessionSnapshot(sessionId);
    if (!rawState.sessions.some((session) => session.id === sessionId))
      return "ok";

    // Drain any queued streaming deltas before the snapshot replaces
    // messagesBySession[sessionId]. The snapshot is authoritative (it already
    // contains everything up to asOfSeq); applying stale queued deltas on top
    // of it would duplicate text / tool output. Flushing here applies them to
    // the pre-snapshot array, which the snapshot then overwrites.
    enqueueEvent.flush();

    // Do not let an old snapshot overwrite state that moved forward while the
    // request was in flight. Retry once to recover volatile text at a fresh
    // cursor; resync/LRU rebuilds must always apply because their projector or
    // subscription was deliberately reset.
    const currentSeq = rawState.lastSeqBySession[sessionId] ?? 0;
    const knownEpoch = epochBySession[sessionId];
    const mustApplySnapshot =
      sessionsRequiringSnapshot.has(sessionId) ||
      sessionsWithStaleCursor.has(sessionId);
    if (
      !mustApplySnapshot &&
      knownEpoch !== undefined &&
      knownEpoch === snap.epoch &&
      currentSeq > snap.asOfSeq
    ) {
      if (sessionsRetryingStaleSnapshot.delete(sessionId)) return "ok";
      sessionsRetryingStaleSnapshot.add(sessionId);
      snapshotSyncRunner.request(sessionId);
      return "ok";
    }
    if (
      !workspaceState!.isLocalTurnSnapshotCurrent(sessionId, turnStartAtRequest)
    ) {
      workspaceState!.afterLocalTurnStartsSettle(sessionId, () => {
        snapshotSyncRunner.request(sessionId);
      });
      return "ok";
    }

    const snapUsagePlaceholder = isPlaceholderSessionUsage(snap.session.usage);
    updateSession(sessionId, (s) => ({
      ...snap.session,
      model:
        snap.session.model && snap.session.model.length > 0
          ? snap.session.model
          : s.model,
      // The wire session's usage is a placeholder (both engines return zeros
      // for the heavy fields); keep the live usage folded in from /status and
      // the WS status stream instead of zeroing it on every snapshot sync.
      usage: snapUsagePlaceholder ? s.usage : snap.session.usage,
    }));
    // The snapshot only carries the most recent page; keep any older pages the
    // user already loaded so reopening does not reset scrollback.
    setSessionMessages(
      sessionId,
      mergeSnapshotMessages(
        rawState.messagesBySession[sessionId] ?? [],
        snap.messages,
      ),
    );
    // Seed the live subagent roster so swarm cards survive a page refresh
    // (their member rows otherwise only exist from non-replayed WS events).
    // loadTasksForSession's keepLiveSubagents preserves these across REST
    // reloads; the roster stays authoritative until then.
    rawState.tasksBySession = {
      ...rawState.tasksBySession,
      [sessionId]: mergeSnapshotSubagents(
        snap.subagents,
        rawState.tasksBySession[sessionId] ?? [],
      ),
    };
    rawState.messagesHasMoreBySession = {
      ...rawState.messagesHasMoreBySession,
      [sessionId]: snap.hasMoreMessages,
    };
    rawState.approvalsBySession = {
      ...rawState.approvalsBySession,
      [sessionId]: snap.pendingApprovals,
    };
    // Preserve plan_review paths from the snapshot so the ExitPlanMode tool
    // card can link to the plan file even after a reload.
    for (const a of snap.pendingApprovals) {
      const display = a.display as
        | { kind?: unknown; plan?: unknown; path?: unknown }
        | null
        | undefined;
      if (
        display?.kind === "plan_review" &&
        typeof display.plan === "string" &&
        display.plan.length > 0
      ) {
        rawState.planReviewByToolCallId = {
          ...rawState.planReviewByToolCallId,
          [a.toolCallId]: {
            plan: display.plan,
            path: typeof display.path === "string" ? display.path : undefined,
          },
        };
      }
    }
    rawState.questionsBySession = {
      ...rawState.questionsBySession,
      [sessionId]: snap.pendingQuestions,
    };
    rawState.lastSeqBySession = {
      ...rawState.lastSeqBySession,
      [sessionId]: snap.asOfSeq,
    };
    epochBySession[sessionId] = snap.epoch;
    sessionsRequiringSnapshot.delete(sessionId);
    sessionsRetryingStaleSnapshot.delete(sessionId);

    // Resync replaces the missed event stream, so a terminal snapshot must
    // also clear the local in-flight flag that normally ends with the turn.
    workspaceState!.handleSessionSnapshot(sessionId, {
      inFlightTurn: snap.inFlightTurn,
      busy: snap.session.busy,
    });

    // The snapshot's inFlightTurn is main-agent-only — seed the moon's
    // liveness flag from it (the projector was reset by the resync, so no
    // turn.ended may ever arrive for a turn that was live before it). Gated
    // on the snapshot's busy fact: the live tracker can hold a stale turn
    // whose turn.ended was lost (abrupt agent disposal) — the server-side
    // busy read is the reconciler, so a dead turn never relights the moon.
    {
      const next = { ...rawState.turnActiveBySession };
      const mainTurnActive =
        snap.session.mainTurnActive ??
        (snap.inFlightTurn !== null && snap.session.busy);
      if (mainTurnActive) next[sessionId] = true;
      else delete next[sessionId];
      rawState.turnActiveBySession = next;
    }

    connectEventsIfNeeded();
    if (eventConn) {
      // Seed BEFORE subscribing: the in-flight assistant message must exist
      // before live deltas (aligned by wire offset) start appending to it.
      eventConn.seedSnapshot(sessionId, snap);
      eventConn.subscribe(sessionId, { seq: snap.asOfSeq, epoch: snap.epoch });
      retainWsSubscription(sessionId);
    }
    sessionsWithStaleCursor.delete(sessionId);
    // The snapshot carries placeholder usage, so a preserved cached value may
    // itself be stale — resync / stale-socket recovery reach here without
    // selectSession's sidecar refresh, and the volatile status frames that
    // would update it were exactly what the resync replaced. Re-read /status
    // so the ring converges on the live value.
    if (snapUsagePlaceholder) void refreshSessionStatus(sessionId);
    void pullSessionWarnings(sessionId);
    return "ok";
  } catch (err) {
    if (isSessionNotFoundError(err)) {
      await handleSessionNotFound(sessionId);
      return "not-found";
    }
    pushOperationFailure("getSessionSnapshot", err, {
      title: i18n.global.t("warnings.sessionSnapshotTitle"),
      message: i18n.global.t("warnings.sessionSnapshotMessage"),
      sessionId,
    });
    return "failed";
  }
}

export const snapshotSyncRunner = createCoalescedAsyncRunner(syncSessionFromSnapshot);

export function hasLoadedMessages(sessionId: string): boolean {
  return Object.prototype.hasOwnProperty.call(
    rawState.messagesBySession,
    sessionId,
  );
}

// ---------------------------------------------------------------------------
// WS subscription cap (LRU eviction)
// ---------------------------------------------------------------------------
//
// Every opened session subscribes to its WS event stream, and the socket keeps
// subscriptions across reconnects (re-sending them in `client_hello`). Without
// a cap, a user who has opened hundreds of sessions stays subscribed to all of
// them: every background session's status/meta/usage event then flows through
// the reducer and dirties the sidebar computeds — the root cause of "the UI
// gets sluggish once I have a lot of sessions".
//
// Keep only the most-recently-opened sessions subscribed (MRU order, index 0 =
// newest). The active session is always retained.
//
// Eviction drops the live WS subscription but keeps the session's cursor so a
// quick re-open can resume cheaply. However, a cursor kept across an eviction
// can go stale: some session events (`event.session.status_changed`,
// `session.meta.updated`, ...) are broadcast to EVERY connection (see
// `isGlobalSessionEvent` on the server) and still advance `lastSeqBySession`
// for an unsubscribed session. If a session emits per-session durable events
// while evicted and then a global event, the cursor jumps past the missed
// events. Evicted sessions are therefore tracked in `sessionsWithStaleCursor`;
// when one is re-opened we rebuild from a snapshot (see `reopenSession`) rather
// than resume from a cursor that may have skipped events.

export function retainWsSubscription(sessionId: string): void {
  const idx = wsSubscriptionOrder.indexOf(sessionId);
  if (idx !== -1) wsSubscriptionOrder.splice(idx, 1);
  wsSubscriptionOrder.unshift(sessionId);
  // Evict the oldest entries past the cap, skipping the active session. The
  // active session is NOT guaranteed to sit at the front: first-time opens only
  // retain after an awaited snapshot, so rapid clicks can complete out of order
  // and leave the active session at the tail. Skipping it (rather than breaking
  // when the tail is active) keeps the cap effective.
  while (wsSubscriptionOrder.length > MAX_WS_SUBSCRIPTIONS) {
    let victimIdx = -1;
    for (let i = wsSubscriptionOrder.length - 1; i >= 0; i--) {
      if (wsSubscriptionOrder[i] !== rawState.activeSessionId) {
        victimIdx = i;
        break;
      }
    }
    if (victimIdx === -1) break;
    const [victim] = wsSubscriptionOrder.splice(victimIdx, 1);
    if (victim === undefined) break;
    eventConn?.unsubscribe(victim);
    sessionsWithStaleCursor.add(victim);
  }
}

export function dropWsSubscription(sessionId: string): void {
  const idx = wsSubscriptionOrder.indexOf(sessionId);
  if (idx !== -1) wsSubscriptionOrder.splice(idx, 1);
  sessionsWithStaleCursor.delete(sessionId);
}

/** Re-open an already-loaded session: always rebuild from a fresh snapshot.
 *
 *  Volatile `assistant.delta` frames are never journaled or replayed: if a
 *  transport hiccup covered the tail of a turn while the user was away, the
 *  local transcript silently lost the model's final text, and a cursor
 *  resubscribe has nothing to recover it with. Always fetching the authoritative
 *  snapshot keeps the logic trivially correct (no freshness heuristics, no
 *  races to reason about); the snapshot is cheap server-side (LRU on the wire
 *  file). Trade-off: a snapshot GET in flight during a steep local send can
 *  momentarily overwrite that optimistic message — the user notices immediately
 *  and the next re-open (or a refresh) reconciles. */
export async function reopenSession(sessionId: string): Promise<SyncSessionResult> {
  return syncSessionFromSnapshot(sessionId);
}

export type SyncSessionResult = "ok" | "not-found" | "failed";

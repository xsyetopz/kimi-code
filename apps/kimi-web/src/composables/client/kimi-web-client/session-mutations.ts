import { forgetLocalTurnState } from "../useWorkspaceState";
import { STORAGE_KEYS, loadUnread, saveUnread } from "../../../lib/storage";
import type { AppMessage, AppSession } from "../../../api/types";
import { traceClientEvent, traceKeyEvent } from "../../../debug/trace";
import {
  rawState,
  eventConn,
  epochBySession,
  sessionsRequiringSnapshot,
  sessionsRetryingStaleSnapshot,
  sessionsKnownEmpty,
  enqueueEvent,
} from "./runtime";
import {
  savePlanModeToStorage,
  saveSwarmModeToStorage,
  saveGoalModeToStorage,
} from "./storage-helpers";
import { dropWsSubscription, snapshotSyncRunner } from "./warnings-snapshot";

export function setSessions(next: AppSession[]): void {
  rawState.sessions = next;
}
/** Replace one session in place (matched by id); no-op if it isn't loaded. */
export function updateSession(
  id: string,
  update: (session: AppSession) => AppSession,
): void {
  rawState.sessions = rawState.sessions.map((s) =>
    s.id === id ? update(s) : s,
  );
}
/** Add or move a session to the front (recency order), de-duped by id. */
export function upsertSessionFront(session: AppSession): void {
  rawState.sessions = [
    session,
    ...rawState.sessions.filter((s) => s.id !== session.id),
  ];
}
/** Append a session to the end (e.g. a deep-linked older session). */
export function appendSession(session: AppSession): void {
  rawState.sessions = [...rawState.sessions, session];
}
/** Drop a session from the list by id. */
export function removeSession(id: string): void {
  rawState.sessions = rawState.sessions.filter((s) => s.id !== id);
}

// Cross-tab sync: when another tab writes the unread key, adopt its value so a
// clear on one tab doesn't get overwritten by this tab's stale in-memory map.
//
// The session this tab is actively viewing is also cleared (only while visible):
// its unread bit may have been set by a tab where it was in the background, and
// we don't want the on-screen session to light up a dot. The same clear runs when
// a hidden tab becomes visible again, so a dot that arrived while hidden is
// dropped once the user is actually looking.
export function clearActiveUnread(): void {
  const active = rawState.activeSessionId;
  if (
    active &&
    rawState.unreadBySession[active] &&
    typeof document !== "undefined" &&
    document.visibilityState === "visible"
  ) {
    rawState.unreadBySession = { ...rawState.unreadBySession, [active]: false };
    saveUnread({ [active]: false });
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEYS.unread) {
      rawState.unreadBySession = loadUnread();
      clearActiveUnread();
    }
  });
}

/**
 * When the tab returns to the foreground, the WebSocket may be a silent
 * half-open: the browser still reports OPEN (so no auto-reconnect) yet no
 * frames have arrived for a while (frozen background tab, dropped NAT mapping,
 * daemon restart). On such a socket live streaming tokens freeze mid-turn with
 * no recovery short of a full page reload.
 *
 * If the socket looks stale, force a clean reconnect — the handshake
 * re-subscribes at the last durable cursor — then refresh the active session
 * from its authoritative snapshot to re-seed the volatile streaming tokens lost
 * during the gap.
 */
export function recoverStaleConnection(): void {
  if (eventConn === null) return;
  if (!eventConn.health().stale) return;
  traceKeyEvent("ws:stale-reconnect", {
    sessionId: rawState.activeSessionId,
    status: "stale",
  });
  traceClientEvent("ws: stale socket on focus, reconnecting", {
    activeSessionId: rawState.activeSessionId,
  });
  eventConn.reconnect();
  const active = rawState.activeSessionId;
  if (active) snapshotSyncRunner.request(active);
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      clearActiveUnread();
      recoverStaleConnection();
    }
  });
}
if (typeof window !== "undefined") {
  window.addEventListener("focus", recoverStaleConnection);
  window.addEventListener("online", recoverStaleConnection);
}

// ---------------------------------------------------------------------------
// rawState.activeSessionId — single mutation funnel.
// ---------------------------------------------------------------------------
/** Set the active session (or clear it with undefined). */
export function setActiveSessionId(id: string | undefined): void {
  rawState.activeSessionId = id;
}

// ---------------------------------------------------------------------------
// rawState.messagesBySession — single mutation funnel.
// ---------------------------------------------------------------------------
/** Replace the whole messages map (e.g. from the reducer snapshot). */
export function setMessagesBySession(next: Record<string, AppMessage[]>): void {
  rawState.messagesBySession = next;
}
/** Set one session's message list. */
export function setSessionMessages(sessionId: string, messages: AppMessage[]): void {
  rawState.messagesBySession = {
    ...rawState.messagesBySession,
    [sessionId]: messages,
  };
}
/** Update one session's message list via a function of the current list. */
export function updateSessionMessages(
  sessionId: string,
  update: (messages: AppMessage[]) => AppMessage[],
): void {
  rawState.messagesBySession = {
    ...rawState.messagesBySession,
    [sessionId]: update(rawState.messagesBySession[sessionId] ?? []),
  };
}
/** Remove one session's message list. */
export function removeSessionMessages(sessionId: string): void {
  const { [sessionId]: _removed, ...rest } = rawState.messagesBySession;
  void _removed;
  rawState.messagesBySession = rest;
}

// ---------------------------------------------------------------------------
// Session teardown — single place that wipes a session and all its per-session
// sidecar state. Both removal entry points (not-found + archive) go through
// this, so adding a new per-session map only ever needs one new line here.
// ---------------------------------------------------------------------------
export function forgetSession(sessionId: string): void {
  // Stop receiving events for this session BEFORE clearing its state: a late or
  // buffered event for this id would otherwise be reduced and recreate the very
  // per-session maps we are about to delete.
  eventConn?.unsubscribe(sessionId);
  dropWsSubscription(sessionId);
  // Drop this session's queued render AND control events. Flushing them here is
  // unsafe: a delayed idle event can drain a queued prompt into the session
  // after the archive request succeeded. Other sessions keep their own ordered
  // backlog and scheduled continuation.
  enqueueEvent.discard(({ meta }) => meta.sessionId === sessionId);
  removeSession(sessionId);
  removeSessionMessages(sessionId);
  delete rawState.approvalsBySession[sessionId];
  delete rawState.questionsBySession[sessionId];
  delete rawState.tasksBySession[sessionId];
  delete rawState.goalBySession[sessionId];
  delete rawState.gitStatusBySession[sessionId];
  delete rawState.lastSeqBySession[sessionId];
  delete rawState.compactionBySession[sessionId];
  delete rawState.messagesLoadingMoreBySession[sessionId];
  delete rawState.messagesHasMoreBySession[sessionId];
  delete rawState.messagesLoadMoreErrorBySession[sessionId];
  delete epochBySession[sessionId];
  sessionsRequiringSnapshot.delete(sessionId);
  sessionsRetryingStaleSnapshot.delete(sessionId);
  sessionsKnownEmpty.delete(sessionId);
  // In-flight / queued prompt state: drop these too so a queued follow-up
  // can't be submitted to a session that was just archived when its turn later
  // ends (onMainTurnEnd drains queuedBySession[sid] without re-checking
  // that the session still exists).
  forgetLocalTurnState(sessionId);
  delete rawState.queuedBySession[sessionId];
  delete rawState.promptIdBySession[sessionId];
  delete rawState.inFlightBySession[sessionId];
  delete rawState.turnActiveBySession[sessionId];
  // Drop per-session mode toggles and re-persist so a deleted session's entry
  // doesn't linger in localStorage.
  delete rawState.planModeBySession[sessionId];
  delete rawState.swarmModeBySession[sessionId];
  delete rawState.goalModeBySession[sessionId];
  delete rawState.thinkingBySession[sessionId];
  savePlanModeToStorage(rawState.planModeBySession);
  saveSwarmModeToStorage(rawState.swarmModeBySession);
  saveGoalModeToStorage(rawState.goalModeBySession);
}

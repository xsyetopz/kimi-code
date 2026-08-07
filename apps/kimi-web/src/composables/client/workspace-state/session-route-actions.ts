import { getKimiWebApi } from "../../../api";
import { i18n } from "../../../i18n";
import { useConfirmDialog } from "../../useConfirmDialog";
import { isDaemonApiError } from "../../../api/errors";
import { SERVER_AUTH_UNAUTHORIZED_CODE } from "../../../api/daemon/http";
import { isPlaceholderSessionUsage } from "../../../api/daemon/mappers";
import type {
  AppConfig,
  AppInFlightTurn,
  AppMessage,
  AppSession,
  AppWorkspace,
  ApprovalDecision,
  ApprovalResponse,
  FsEntry,
  KimiEventConnection,
  QuestionResponse,
} from "../../../api/types";
import {
  loadWorkspaceNameOverrides,
  safeRemove,
  saveWorkspaceNameOverrides,
  STORAGE_KEYS,
} from "../../../lib/storage";
import { parseDiff } from "../../../lib/parseDiff";
import { workspaceRootKey } from "../../../lib/rootKey";
import { sessionExportTraceToJsonl, traceKeyEvent } from "../../../debug/trace";
import { readSessionIdFromLocation, sessionUrl } from "../../../lib/sessionRoute";
import type { SessionUrlMode } from "../../../lib/sessionRoute";
import type {
  ActivityState,
  ConversationStatus,
  DiffViewLine,
  PermissionMode,
  WorkspaceView,
} from "../../../types";
import type { ExtendedState, PromptAttachment } from "../kimi-web-client/types";
import type { UseWorkspaceStateDeps } from "./types";
import type { WorkspaceStateCtx } from "./context";
import {
  beginLocalTurn,
  settleLocalTurn,
  localTurnStartState,
  isLocalTurnSnapshotCurrent,
  afterLocalTurnStartsSettle,
} from "./local-turn-state";
import {
  MESSAGES_PAGE_SIZE,
  SESSIONS_INITIAL_PAGE_SIZE,
  PROMPT_NOT_FOUND_CODE,
  WORKSPACE_NOT_FOUND_CODE,
  ALREADY_RESOLVED_CODE,
  FIRST_LOAD_AUTH_RETRY_MS,
  TASK_ALREADY_FINISHED_CODE,
  MAX_QUEUE_FLUSH_FAILURES,
  isAlreadyResolvedError,
  isTaskAlreadyFinishedError,
  pendingQuestionActions,
  pendingApprovalActions,
  pendingTaskCancellations,
  startingFirstPromptWorkspaces,
  queueFlushFailures,
  nextQueueEntryId,
  type AuthCheckResult,
} from "./shared";

export function createSessionRouteActions(
  rawState: ExtendedState,
  deps: UseWorkspaceStateDeps,
  ctx: WorkspaceStateCtx,
) {
  const { t } = i18n.global;
  const { confirm } = useConfirmDialog();
  const {
    taskPoller,
    sideChat,
    modelProvider,
    pushOperationFailure,
    activity,
    sessionsKnownEmpty,
    setSessions,
    updateSession,
    upsertSessionFront,
    appendSession,
    forgetSession,
    setActiveSessionId,
    updateSessionMessages,
    nextOptimisticMsgId,
    getEventConn,
    syncSessionFromSnapshot,
    reopenSession,
    hasLoadedMessages,
    refreshSessionStatus,
    refreshSessionGoal,
    persistSessionProfile,
    mergedWorkspaces,
    workspacesView,
    status,
    workspaceIdForSession,
    savePermissionToStorage,
    savePlanModeToStorage,
    saveSwarmModeToStorage,
    saveGoalModeToStorage,
    draftModes,
    saveUnread,
    saveActiveWorkspaceToStorage,
    saveHiddenWorkspacesToStorage,
    goalErrorMessage,
    resetFastMoon,
    initialized,
    connectIssue,
    selectedDiffPath,
    fileDiffLines,
    fileDiffLoading,
  } = deps;
  let exportInFlight = false;

  function writeSessionUrl(
    sessionId: string | undefined,
    mode: SessionUrlMode,
  ): void {
    if (mode === "none") return;
    if (typeof window === "undefined" || !window.history) return;
    const target = sessionUrl(sessionId);
    if (window.location.pathname === target) return;
    try {
      if (mode === "push") window.history.pushState(null, "", target);
      else window.history.replaceState(null, "", target);
    } catch {
      // history API unavailable (e.g. sandboxed iframe) — URL sync is best-effort
    }
  }

  /** Fetch a session that is not in the loaded list (deep link beyond the first
      page) and append it. Returns false when the daemon doesn't know it. */
  async function fetchSessionIntoList(sessionId: string): Promise<boolean> {
    try {
      const session = await getKimiWebApi().getSession(sessionId);
      if (!rawState.sessions.some((s) => s.id === session.id)) {
        // Append, not prepend: the list is recency-ordered and a deep-linked old
        // session shouldn't displace the most-recent ones at the top.
        appendSession(session);
      }
      return true;
    } catch {
      return false;
    }
  }

  function onSessionRoutePopState(): void {
    const id = readSessionIdFromLocation(window.location);
    if (id === undefined) {
      // Back/forward landed on '/' — no active session.
      setActiveSessionId(undefined);
      return;
    }
    if (id === rawState.activeSessionId) return;
    if (rawState.sessions.some((s) => s.id === id)) {
      void ctx.selectSession(id, { urlMode: "none" });
      return;
    }
    // A history entry can point at a session that has since been deleted (or one
    // outside the loaded page): try to fetch it; on failure fall back to the most
    // recent session and FIX the URL so the bad entry doesn't stick around.
    void (async () => {
      if (await fetchSessionIntoList(id)) {
        await ctx.selectSession(id, { urlMode: "none" });
        return;
      }
      const next = rawState.sessions[0];
      if (next) {
        await ctx.selectSession(next.id, { urlMode: "replace" });
      } else {
        setActiveSessionId(undefined);
        writeSessionUrl(undefined, "replace");
      }
    })();
  }

  let sessionRouteBound = false;
  function bindSessionRoute(): void {
    if (sessionRouteBound || typeof window === "undefined") return;
    sessionRouteBound = true;
    window.addEventListener("popstate", onSessionRoutePopState);
  }

  async function selectSession(
    sessionId: string,
    opts?: { urlMode?: SessionUrlMode },
  ): Promise<void> {
    const messagesLoaded = hasLoadedMessages(sessionId);
    // Only sessions created locally in this client are trusted to be empty.
    // The daemon-reported messageCount can be stale for old sessions, so relying
    // on it causes the empty-composer to flash before the real snapshot arrives.
    // A locally created session has no history to load: show the empty composer
    // immediately by skipping the `sessionLoading` flag (no flash), while the
    // snapshot still loads in the background like any other first open.
    const knownEmpty = !messagesLoaded && sessionsKnownEmpty.has(sessionId);
    // Single-use: after this select resolves the session is no longer "known empty".
    sessionsKnownEmpty.delete(sessionId);
    try {
      // Write the URL synchronously (before any await) so rapid clicks lay down
      // history entries in click order.
      writeSessionUrl(sessionId, opts?.urlMode ?? "push");
      rawState.sessionLoading = !messagesLoaded && !knownEmpty;
      setActiveSessionId(sessionId);
      resetFastMoon();
      // Opening a session clears its unread dot.
      if (rawState.unreadBySession[sessionId]) {
        rawState.unreadBySession = {
          ...rawState.unreadBySession,
          [sessionId]: false,
        };
        saveUnread({ [sessionId]: false });
      }
      // A diff belongs to the session it was loaded from — drop it on switch.
      ctx.clearFileDiff();

      // NOTE: persisted sessions are directly promptable on the current daemon —
      // selecting one and sending a message just works, no re-activation needed.

      // Keep the active workspace in sync with the selected session.
      const selected = rawState.sessions.find((s) => s.id === sessionId);
      if (selected) {
        const wid = workspaceIdForSession(selected);
        if (rawState.activeWorkspaceId !== wid) ctx.selectWorkspace(wid);
      }

      if (!messagesLoaded) {
        // First open: full snapshot → seed → subscribe(asOfSeq).
        const result = await syncSessionFromSnapshot(sessionId);
        if (result === "not-found") return;
      } else {
        // Re-open: rebuild from a fresh snapshot rather than resuming from the
        // tracked cursor — the daemon only replays durable events, so volatile
        // streamed deltas lost to a WS hiccup would otherwise stay missing.
        const result = await reopenSession(sessionId);
        if (result === "not-found") return;
      }

      // Refresh sidecars AFTER the snapshot settles so status/usage updates
      // aren't overwritten by syncSessionFromSnapshot.
      ctx.refreshSessionSidecars(sessionId);
    } catch (err) {
      pushOperationFailure("selectSession", err, { sessionId });
    } finally {
      if (rawState.activeSessionId === sessionId) {
        rawState.sessionLoading = false;
      }
    }
  }

  /** Internal: submit a prompt to a specific session, bypassing the queue check.
      Returns 'ok' when the daemon accepted the prompt, 'rejected' on a
      definitive refusal (structured API error — the server holds nothing, so
      re-queueing is safe), and 'uncertain' when the failure was ambiguous
      (dropped response, network error): the merged prompt may already be
      queued server-side, and callers must NOT re-queue or they'd duplicate it. */
  return {
    writeSessionUrl,
    fetchSessionIntoList,
    onSessionRoutePopState,
    bindSessionRoute,
    selectSession,
  };
}

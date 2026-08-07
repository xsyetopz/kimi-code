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

export function createGitDiffActions(
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

  async function loadOlderMessages(sessionId: string): Promise<void> {
    if (rawState.messagesLoadingMoreBySession[sessionId]) return;
    const current = rawState.messagesBySession[sessionId];
    if (!current || current.length === 0) return;

    const beforeId = current[0]!.id;
    rawState.messagesLoadingMoreBySession = {
      ...rawState.messagesLoadingMoreBySession,
      [sessionId]: true,
    };
    rawState.messagesLoadMoreErrorBySession = {
      ...rawState.messagesLoadMoreErrorBySession,
      [sessionId]: false,
    };
    try {
      const page = await getKimiWebApi().listMessages(sessionId, {
        beforeId,
        pageSize: MESSAGES_PAGE_SIZE,
      });
      // Server returns newest-first; the UI keeps messages in chronological order.
      const older = [...page.items].reverse();
      // Live events may have appended messages while the request was in flight;
      // the updater receives the latest array so those messages are not overwritten.
      updateSessionMessages(sessionId, (latest) => [...older, ...latest]);
      rawState.messagesHasMoreBySession = {
        ...rawState.messagesHasMoreBySession,
        [sessionId]: page.hasMore,
      };
    } catch (err) {
      rawState.messagesLoadMoreErrorBySession = {
        ...rawState.messagesLoadMoreErrorBySession,
        [sessionId]: true,
      };
      pushOperationFailure("loadOlderMessages", err, { sessionId });
    } finally {
      rawState.messagesLoadingMoreBySession = {
        ...rawState.messagesLoadingMoreBySession,
        [sessionId]: false,
      };
    }
  }

  function refreshSessionSidecars(sessionId: string): void {
    void taskPoller.loadTasksForSession(sessionId);
    void loadGitStatus(sessionId);
    void refreshSessionStatus(sessionId);
    void refreshSessionGoal(sessionId);
    if (
      !Object.prototype.hasOwnProperty.call(
        modelProvider.skillsBySession.value,
        sessionId,
      )
    ) {
      void modelProvider.loadSkillsForSession(sessionId);
    }
  }

  async function loadFileDiff(path: string): Promise<void> {
    const sid = rawState.activeSessionId;
    if (!sid) return;
    selectedDiffPath.value = path;
    fileDiffLines.value = [];
    fileDiffLoading.value = true;
    try {
      const api = getKimiWebApi();
      const result = await api.getFileDiff(sid, path);
      // Guard against a stale response when the user tapped another file.
      if (selectedDiffPath.value !== path) return;
      fileDiffLines.value = parseDiff(result.diff);
    } catch (err) {
      // A single file's diff failing (a new/untracked/binary/deleted file the
      // daemon can't diff) is LOCAL to this pane, not a session-level fault — the
      // DiffView already shows a graceful "no diff" state when the lines are
      // empty. Surfacing it as a global "kimi server api" error toast on a routine
      // file click is disproportionate, so log it for the trace export instead.
      if (selectedDiffPath.value === path) fileDiffLines.value = [];
      console.warn("[loadFileDiff] diff unavailable for", path, err);
    } finally {
      if (selectedDiffPath.value === path) fileDiffLoading.value = false;
    }
  }

  /** Close the ~/diff line-by-line view and return to the changed-file list. */
  function clearFileDiff(): void {
    selectedDiffPath.value = null;
    fileDiffLines.value = [];
    fileDiffLoading.value = false;
  }

  /** Load git status for a session — defensive, never throws */
  async function loadGitStatus(sessionId: string): Promise<void> {
    try {
      const api = getKimiWebApi();
      const result = await api.getGitStatus(sessionId);
      rawState.gitStatusBySession = {
        ...rawState.gitStatusBySession,
        [sessionId]: result,
      };
    } catch {
      // Stale/old sessions may 404 — leave undefined, no crash
    }
  }

  /** Fetch auth readiness from GET /api/v1/auth. Defensive — never throws.
   *  The web bundle always ships paired with its daemon, so this endpoint is
   *  guaranteed to exist — every failure is either a credential rejection or
   *  a transient error worth retrying:
   *  - 'proceed'              — response received; rawState reflects it (ready
   *                             or not)
   *  - 'server-auth-required' — the daemon rejected our server credential
   *                             (401/40101); the ServerAuthDialog owns recovery
   *                             (it reloads once the token is entered)
   *  - 'retry'                — transient failure (network, timeout, 5xx); the
   *                             caller should retry instead of treating it as
   *                             "not signed in" */
  return {
    loadOlderMessages,
    refreshSessionSidecars,
    loadFileDiff,
    clearFileDiff,
    loadGitStatus,
  };
}

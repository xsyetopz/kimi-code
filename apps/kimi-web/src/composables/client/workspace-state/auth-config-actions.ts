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

export function createAuthConfigActions(
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

  async function checkAuth(): Promise<AuthCheckResult> {
    try {
      const api = getKimiWebApi();
      const result = await api.getAuth();
      rawState.authReady = result.ready;
      rawState.defaultModel = result.defaultModel;
      rawState.managedProviderStatus = result.managedProvider?.status ?? null;
      connectIssue.value = null;
      return "proceed";
    } catch (err) {
      if (
        isDaemonApiError(err) &&
        (err.code === 401 || err.code === SERVER_AUTH_UNAUTHORIZED_CODE)
      ) {
        // The ServerAuthDialog explains this one — nothing to surface.
        connectIssue.value = null;
        return "server-auth-required";
      }
      // Surface the reason on the splash so "cannot connect" is diagnosable
      // instead of an unexplained spinner.
      connectIssue.value = (
        err instanceof Error ? err.message : String(err)
      ).slice(0, 140);
      return "retry";
    }
  }

  /** Poll /auth until the daemon gives a definitive outcome, waiting
   *  FIRST_LOAD_AUTH_RETRY_MS between transient failures. Never resolves with
   *  'retry'. Used only by the first load. */
  async function waitForFirstAuth(): Promise<AuthCheckResult> {
    let firstRetry = true;
    for (;;) {
      const result = await checkAuth();
      if (result !== "retry") return result;
      // Keep the first quick failure silent — a single blip right after page
      // load shouldn't flash an error. Surface it from the 2nd failed attempt
      // (~2s in) onward, so a genuinely stuck connection stays diagnosable.
      if (firstRetry) {
        connectIssue.value = null;
        firstRetry = false;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, FIRST_LOAD_AUTH_RETRY_MS);
      });
    }
  }

  /** Fetch global config from GET /api/v1/config. Defensive — never throws. */
  async function loadConfig(): Promise<void> {
    try {
      const api = getKimiWebApi();
      rawState.config = await api.getConfig();
    } catch {
      // Daemon may not have this endpoint yet; leave null
    }
  }

  /** Update global config via POST /api/v1/config. */
  async function updateConfig(patch: Partial<AppConfig>): Promise<boolean> {
    try {
      const api = getKimiWebApi();
      const next = await api.setConfig(patch);
      rawState.config = next;
      rawState.defaultModel = next.defaultModel ?? null;
      return true;
    } catch (err) {
      pushOperationFailure("setConfig", err);
      return false;
    }
  }

  // Backend max page size for GET /sessions. Bigger pages mean fewer round-trips
  // when draining the full session list.
  return {
    checkAuth,
    waitForFirstAuth,
    loadConfig,
    updateConfig,
  };
}

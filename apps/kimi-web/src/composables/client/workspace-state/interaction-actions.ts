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

export function createInteractionActions(
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

  function removePendingApproval(sid: string, approvalId: string): void {
    const list = rawState.approvalsBySession[sid] ?? [];
    rawState.approvalsBySession = {
      ...rawState.approvalsBySession,
      [sid]: list.filter((a) => a.approvalId !== approvalId),
    };
  }

  function removePendingQuestion(sid: string, questionId: string): void {
    const list = rawState.questionsBySession[sid] ?? [];
    rawState.questionsBySession = {
      ...rawState.questionsBySession,
      [sid]: list.filter((q) => q.questionId !== questionId),
    };
  }

  async function respondApproval(
    approvalId: string,
    response: {
      decision: ApprovalDecision;
      scope?: "session";
      feedback?: string;
      selectedLabel?: string;
    },
  ): Promise<void> {
    const sid = rawState.activeSessionId;
    if (!sid) return;
    // Guard against a second click while the first respond is in flight.
    if (pendingApprovalActions[approvalId]) return;
    pendingApprovalActions[approvalId] = true;
    try {
      const api = getKimiWebApi();
      const fullResponse: ApprovalResponse = {
        decision: response.decision,
        scope: response.scope,
        feedback: response.feedback,
        selectedLabel: response.selectedLabel,
      };
      await api.respondApproval(sid, approvalId, fullResponse);
      // Remove from local approvals immediately (WS event will confirm)
      removePendingApproval(sid, approvalId);
    } catch (err) {
      if (isAlreadyResolvedError(err)) {
        // Already resolved (another client or a raced event) — that is the
        // desired end state, so drop it locally without surfacing an error.
        removePendingApproval(sid, approvalId);
      } else {
        pushOperationFailure("respondApproval", err, { sessionId: sid });
      }
    } finally {
      delete pendingApprovalActions[approvalId];
    }
  }

  async function respondQuestion(
    questionId: string,
    response: QuestionResponse,
  ): Promise<void> {
    const sid = rawState.activeSessionId;
    if (!sid) return;
    // Guard against a second click while the first respond is in flight.
    if (pendingQuestionActions[questionId]) return;
    pendingQuestionActions[questionId] = "answer";
    try {
      const api = getKimiWebApi();
      await api.respondQuestion(sid, questionId, response);
      removePendingQuestion(sid, questionId);
    } catch (err) {
      if (isAlreadyResolvedError(err)) {
        // Already resolved (another client or a raced event) — that is the
        // desired end state, so drop it locally without surfacing an error.
        removePendingQuestion(sid, questionId);
      } else {
        pushOperationFailure("respondQuestion", err, { sessionId: sid });
      }
    } finally {
      delete pendingQuestionActions[questionId];
    }
  }

  async function dismissQuestion(questionId: string): Promise<void> {
    const sid = rawState.activeSessionId;
    if (!sid) return;
    // Guard against a second click while a respond/dismiss is in flight.
    if (pendingQuestionActions[questionId]) return;
    pendingQuestionActions[questionId] = "dismiss";
    try {
      const api = getKimiWebApi();
      await api.dismissQuestion(sid, questionId);
      removePendingQuestion(sid, questionId);
    } catch (err) {
      if (isAlreadyResolvedError(err)) {
        removePendingQuestion(sid, questionId);
      } else {
        pushOperationFailure("dismissQuestion", err, { sessionId: sid });
      }
    } finally {
      delete pendingQuestionActions[questionId];
    }
  }

  async function cancelTask(taskId: string): Promise<void> {
    const sid = rawState.activeSessionId;
    if (!sid) return;
    // Guard against a second click while the first cancel is in flight.
    if (pendingTaskCancellations[taskId]) return;
    pendingTaskCancellations[taskId] = true;
    try {
      const api = getKimiWebApi();
      // A background subagent row is keyed by agent id, but REST `/tasks` only
      // knows its background-task id.
      const restTaskId = (rawState.tasksBySession[sid] ?? []).find(
        (t) => t.id === taskId,
      )?.backgroundTaskId;
      await api.cancelTask(sid, restTaskId ?? taskId);
      // Update task status locally
      const list = rawState.tasksBySession[sid] ?? [];
      rawState.tasksBySession = {
        ...rawState.tasksBySession,
        [sid]: list.map((t) =>
          t.id === taskId ? { ...t, status: "cancelled" as const } : t,
        ),
      };
    } catch (err) {
      if (isTaskAlreadyFinishedError(err)) {
        // Already in a terminal state — that is the desired end state for
        // "cancel", so stay silent. Don't force status to 'cancelled': the
        // task may have completed/failed, and the task event stream / poller
        // will reflect its real status.
      } else {
        pushOperationFailure("cancelTask", err, { sessionId: sid });
      }
    } finally {
      delete pendingTaskCancellations[taskId];
    }
  }

  /** Persist and apply plan mode for the active session (pushed to its profile
   *  + sent per-prompt). With no active session the toggle is staged on the
   *  draft and transferred when the first prompt creates the session. */
  return {
    removePendingApproval,
    removePendingQuestion,
    respondApproval,
    respondQuestion,
    dismissQuestion,
    cancelTask,
  };
}

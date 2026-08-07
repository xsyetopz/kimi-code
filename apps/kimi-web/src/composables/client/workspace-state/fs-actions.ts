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

export function createFsActions(
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

  /**
   * List directory contents for the active session.
   * Returns FsEntry[] — defensive, returns [] on error or no active session.
   */
  async function listDir(path: string): Promise<FsEntry[]> {
    const sid = rawState.activeSessionId;
    if (!sid) return [];
    try {
      const api = getKimiWebApi();
      const result = await api.listDirectory(sid, {
        path,
        includeGitStatus: true,
      });
      return result.items;
    } catch {
      return [];
    }
  }

  /**
   * Read file content for the active session.
   * Returns the file metadata + content (including path), or null on error or no active session.
   */
  async function readFileContent(path: string): Promise<{
    path: string;
    content: string;
    encoding: "utf-8" | "base64";
    mime: string;
    languageId?: string;
    isBinary: boolean;
    size: number;
    lineCount?: number;
  } | null> {
    const sid = rawState.activeSessionId;
    if (!sid) return null;
    try {
      const api = getKimiWebApi();
      const result = await api.readFile(sid, { path });
      return {
        path: result.path,
        content: result.content,
        encoding: result.encoding,
        mime: result.mime,
        languageId: result.languageId,
        isBinary: result.isBinary,
        size: result.size,
        lineCount: result.lineCount,
      };
    } catch (err) {
      console.warn("[kimi-web] readFileContent failed for", path, err);
      return null;
    }
  }

  // Matches the daemon's FS_READ_MAX_BYTES. Without an explicit length the
  // protocol defaults to 1MiB and silently truncates — half a PNG decodes as a
  // broken image, which is worse than falling back to the original src.
  const IMAGE_READ_MAX_BYTES = 10_485_760;

  function getFileDownloadUrl(path: string): string | null {
    const sid = rawState.activeSessionId;
    if (!sid) return null;
    return getKimiWebApi().getFileDownloadUrl(sid, path);
  }

  async function openWorkspaceFile(
    path: string,
    line?: number,
  ): Promise<boolean> {
    const sid = rawState.activeSessionId;
    if (!sid) return false;
    try {
      await getKimiWebApi().openFile(sid, { path, line });
      return true;
    } catch (err) {
      pushOperationFailure("openFile", err, { sessionId: sid });
      return false;
    }
  }

  /** Open the current workspace in an external application (Finder, Cursor, etc.). */
  async function openInApp(appId: string): Promise<void> {
    const sid = rawState.activeSessionId;
    if (!sid) return;
    const path = status.value.cwd || ".";
    try {
      await getKimiWebApi().openInApp(sid, appId, path);
    } catch (err) {
      pushOperationFailure("openInApp", err, { sessionId: sid });
    }
  }

  async function revealWorkspaceFile(path: string): Promise<boolean> {
    const sid = rawState.activeSessionId;
    if (!sid) return false;
    try {
      await getKimiWebApi().revealFile(sid, { path });
      return true;
    } catch (err) {
      pushOperationFailure("revealFile", err, { sessionId: sid });
      return false;
    }
  }

  /**
   * Resolve a local image path to a displayable data URL.
   * Non-local URLs (http/https/data) pass through unchanged.
   * Local paths are read via the daemon's readFile endpoint and returned as
   * data:{mime};base64,{content} URLs so they render in the browser. Absolute
   * paths are made cwd-relative first (the daemon rejects absolute paths), and
   * truncated/non-binary reads fall back to the original src.
   */
  async function resolveImageUrl(src: string): Promise<string> {
    // Pass through already-addressable URLs
    if (/^(https?:|data:|blob:)/i.test(src)) return src;
    const sid = rawState.activeSessionId;
    if (!sid) return src;

    // The daemon's path resolution only accepts session-relative paths, but the
    // model usually references images by absolute path. Strip the session cwd.
    let path = src;
    if (path.startsWith("/")) {
      const cwd = rawState.sessions.find((s) => s.id === sid)?.cwd;
      if (
        cwd &&
        (path === cwd || path.startsWith(cwd.endsWith("/") ? cwd : `${cwd}/`))
      ) {
        path = path.slice(cwd.length).replace(/^\//, "");
        if (!path) return src;
      } else {
        return src; // absolute path outside the workspace — unreadable
      }
    }

    try {
      const api = getKimiWebApi();
      const result = await api.readFile(sid, {
        path,
        length: IMAGE_READ_MAX_BYTES,
      });
      if (!result.isBinary || result.encoding !== "base64" || result.truncated)
        return src;
      return `data:${result.mime};base64,${result.content}`;
    } catch {
      return src;
    }
  }

  /**
   * Search files in the active workspace via the daemon's workspace fs:search
   * endpoint — no session id involved, so `@` works unchanged before the first
   * prompt. The workspace ref mirrors what selectSession syncs: the active
   * session's workspace, else the draft's active workspace (a registered id or
   * an absolute root — the daemon resolves both). Returns {path, name}[] —
   * defensive, returns [] on error or when no workspace is active.
   */
  async function searchFiles(
    query: string,
  ): Promise<Array<{ path: string; name: string }>> {
    const session = rawState.sessions.find(
      (s) => s.id === rawState.activeSessionId,
    );
    const ref =
      session === undefined
        ? rawState.activeWorkspaceId
        : workspaceIdForSession(session);
    if (!ref) return [];
    try {
      const api = getKimiWebApi();
      const result = await api.searchFiles(ref, { query, limit: 20 });
      return result.items.map((item) => ({ path: item.path, name: item.name }));
    } catch {
      return [];
    }
  }
  return {
    listDir,
    readFileContent,
    getFileDownloadUrl,
    openWorkspaceFile,
    openInApp,
    revealWorkspaceFile,
    resolveImageUrl,
    searchFiles,
  };
}

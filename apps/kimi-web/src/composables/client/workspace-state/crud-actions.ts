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

export function createCrudActions(
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

  async function renameSession(id: string, title: string): Promise<void> {
    try {
      const api = getKimiWebApi();
      await api.updateSession(id, { title });
      updateSession(id, (s) => ({ ...s, title }));
    } catch (err) {
      pushOperationFailure("renameSession", err, { sessionId: id });
    }
  }

  /** Rename a workspace — persists via the daemon update API, then applies
   *  locally. Derived workspaces (a cwd with sessions that was never explicitly
   *  registered) can't be renamed by the daemon yet: PATCH rejects them with
   *  404. In that case the name is persisted in localStorage (keyed by root)
   *  and overlaid onto the loaded list, so the rename still survives a refresh. */
  async function renameWorkspace(id: string, name: string): Promise<void> {
    const root = rawState.workspaces.find((w) => w.id === id)?.root;
    const applyLocal = (): void => {
      rawState.workspaces = rawState.workspaces.map((w) =>
        w.id === id ? { ...w, name } : w,
      );
    };
    try {
      await getKimiWebApi().updateWorkspace(id, { name });
      // Server accepted the rename — drop any local override for this root.
      if (root !== undefined) {
        const overrides = loadWorkspaceNameOverrides();
        if (root in overrides) {
          delete overrides[root];
          saveWorkspaceNameOverrides(overrides);
        }
      }
      applyLocal();
    } catch (err) {
      if (
        root !== undefined &&
        isDaemonApiError(err) &&
        err.code === WORKSPACE_NOT_FOUND_CODE
      ) {
        saveWorkspaceNameOverrides({
          ...loadWorkspaceNameOverrides(),
          [root]: name,
        });
        applyLocal();
        return;
      }
      pushOperationFailure("renameWorkspace", err);
    }
  }

  /** Delete a workspace — calls API, removes locally */
  async function deleteWorkspace(id: string): Promise<void> {
    // "Remove workspace" only hides the sidebar entry — it never deletes sessions
    // or history. The daemon DELETE is registry-only and mergedWorkspaces would
    // otherwise re-derive the workspace from any session cwd still pointing at it,
    // so it would pop right back. To make remove actually stick (even when the
    // workspace has sessions), record its ROOT in the persisted hidden set; the
    // merge then skips it. Re-adding the same path un-hides it (see addWorkspace).
    const root =
      rawState.workspaces.find((w) => w.id === id)?.root ??
      mergedWorkspaces.value.find((w) => w.id === id)?.root ??
      id; // derived workspaces use the cwd as their id
    const activeSession = rawState.activeSessionId
      ? rawState.sessions.find((s) => s.id === rawState.activeSessionId)
      : undefined;
    const removingActiveWorkspace =
      rawState.activeWorkspaceId === id || rawState.activeWorkspaceId === root;
    const activeSessionInRemovedWorkspace = Boolean(
      activeSession &&
        (activeSession.cwd === root ||
          activeSession.workspaceId === id ||
          workspaceIdForSession(activeSession) === id),
    );
    if (root && !rawState.hiddenWorkspaceRoots.includes(root)) {
      rawState.hiddenWorkspaceRoots = [...rawState.hiddenWorkspaceRoots, root];
      saveHiddenWorkspacesToStorage(rawState.hiddenWorkspaceRoots);
    }
    // Best-effort registry cleanup; ignore failures (the hide already took effect).
    try {
      await getKimiWebApi().deleteWorkspace(id);
    } catch (err) {
      // registry delete is optional — the sidebar hide is what the user sees.
      console.warn(
        "[kimi-web] deleteWorkspace registry cleanup failed for",
        id,
        err,
      );
    }
    rawState.workspaces = rawState.workspaces.filter(
      (w) => w.id !== id && w.root !== root,
    );
    if (removingActiveWorkspace || activeSessionInRemovedWorkspace) {
      const nextWorkspace = workspacesView.value[0]?.id ?? null;
      rawState.activeWorkspaceId = nextWorkspace;
      if (nextWorkspace) saveActiveWorkspaceToStorage(nextWorkspace);
      else {
        try {
          safeRemove(STORAGE_KEYS.activeWorkspace);
        } catch {
          /* ignore */
        }
      }
    }
    if (removingActiveWorkspace || activeSessionInRemovedWorkspace) {
      setActiveSessionId(undefined);
      rawState.sessionLoading = false;
      ctx.clearFileDiff();
      ctx.writeSessionUrl(undefined, "replace");
    }
  }

  /** Archive a session — calls API, persists the archive flag, removes locally, picks another active session or none */
  async function archiveSession(id: string): Promise<void> {
    try {
      const api = getKimiWebApi();
      await api.archiveSession(id);
      forgetSession(id);
      sideChat.clearSideChatForSession(id);
      const { [id]: _removedIds, ...restIds } =
        rawState.sideChatUserMessageIdsBySession;
      void _removedIds;
      rawState.sideChatUserMessageIdsBySession = restIds;

      // If archived session was active, pick another. 'replace' so the address
      // bar doesn't keep pointing at (and back doesn't return to) a dead session.
      if (rawState.activeSessionId === id) {
        const next = rawState.sessions[0];
        if (next) {
          await ctx.selectSession(next.id, { urlMode: "replace" });
        } else {
          setActiveSessionId(undefined);
          ctx.writeSessionUrl(undefined, "replace");
        }
      }
    } catch (err) {
      pushOperationFailure("archiveSession", err, { sessionId: id });
    }
  }

  /** Export the given session (default: the active one). The id is captured
   * synchronously so a later session switch cannot redirect the in-flight
   * request, and a lock prevents duplicate ZIP generation. */
  async function exportSession(targetSessionId?: string): Promise<void> {
    if (exportInFlight) return;
    const sessionId = targetSessionId ?? rawState.activeSessionId;
    if (!sessionId) {
      const message = t("commands.export.noSession");
      traceKeyEvent("export:failed", { status: "no-session" });
      pushOperationFailure("exportSession", new Error(message), { message });
      return;
    }
    exportInFlight = true;
    const startedAt = Date.now();
    traceKeyEvent("export:start", { sessionId });
    try {
      const webLog = sessionExportTraceToJsonl();
      const { blob, fileName } = await getKimiWebApi().exportSession(
        sessionId,
        webLog,
      );
      if (typeof document === "undefined")
        throw new Error("Document is unavailable");
      const url = URL.createObjectURL(blob);
      let anchor: HTMLAnchorElement | undefined;
      try {
        anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = fileName;
        document.body.append(anchor);
        anchor.click();
      } finally {
        anchor?.remove();
        setTimeout(() => {
          try {
            URL.revokeObjectURL(url);
          } catch {
            // Object URL cleanup is best-effort in restricted browser contexts.
          }
        }, 0);
      }
      traceKeyEvent("export:accepted", {
        sessionId,
        status: "accepted",
        zipBytes: blob.size,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const failure =
        typeof error === "object" && error !== null
          ? (error as {
              name?: unknown;
              code?: unknown;
              requestId?: unknown;
              phase?: unknown;
              status?: unknown;
            })
          : undefined;
      traceKeyEvent("export:failed", {
        sessionId,
        status: "failed",
        durationMs: Date.now() - startedAt,
        errorName:
          typeof failure?.name === "string" ? failure.name : typeof error,
        errorCode: typeof failure?.code === "number" ? failure.code : undefined,
        requestId:
          typeof failure?.requestId === "string"
            ? failure.requestId
            : undefined,
        phase: typeof failure?.phase === "string" ? failure.phase : undefined,
        httpStatus:
          typeof failure?.status === "number" ? failure.status : undefined,
      });
      pushOperationFailure("exportSession", error, { sessionId });
    } finally {
      exportInFlight = false;
    }
  }

  /** Restore an archived session — calls API, then puts the returned session
   *  back at the front of the list so it reappears in the sidebar. */
  async function restoreSession(id: string): Promise<boolean> {
    try {
      const restored = await getKimiWebApi().restoreSession(id);
      upsertSessionFront(restored);
      return true;
    } catch (err) {
      pushOperationFailure("restoreSession", err, { sessionId: id });
      return false;
    }
  }

  /** List archived sessions (server-side `archived_only` filter). Kept separate
   *  from the per-workspace active list — callers (e.g. Settings) hold the page
   *  locally and do their own search/filter/sort. */
  function loadArchivedSessions(input?: {
    beforeId?: string;
    pageSize?: number;
  }) {
    return getKimiWebApi().listSessions({
      archivedOnly: true,
      beforeId: input?.beforeId,
      pageSize: input?.pageSize ?? 50,
    });
  }

  /** Logout from the managed Kimi provider. Re-checks auth and reloads sessions. */
  async function logout(): Promise<void> {
    try {
      const api = getKimiWebApi();
      await api.logout();
      await ctx.checkAuth();
      await ctx.load();
    } catch (err) {
      pushOperationFailure("logout", err);
    }
  }

  /**
   * compact() — request history compaction via POST /sessions/{id}:compact.
   * Progress arrives asynchronously through the WS compaction.* events (running
   * notice → divider marker), so we just fire the request. An optional
   * instruction (from `/compact <text>`) steers what the summary focuses on.
   */
  function compact(instruction?: string): void {
    const sid = rawState.activeSessionId;
    if (!sid) return;
    void getKimiWebApi()
      .compactSession(sid, instruction)
      .catch((err) => {
        pushOperationFailure("compact", err, { sessionId: sid });
      });
  }

  /**
   * forkSession() — fork the active session into a new child session via
   * POST /sessions/{id}:fork, then add it to the list and select it.
   */
  async function forkSession(sessionId?: string): Promise<void> {
    const sid = sessionId ?? rawState.activeSessionId;
    if (!sid) return;
    try {
      const forked = await getKimiWebApi().forkSession(sid);
      upsertSessionFront(forked);
      await ctx.selectSession(forked.id);
    } catch (err) {
      pushOperationFailure("fork", err, { sessionId: sid });
    }
  }

  /**
   * Undo the last `count` turns of the active session (daemon :undo), then re-sync
   * the snapshot so the local transcript matches the daemon's post-undo history.
   * Returns the text of the most-recent user message that was undone, so the UI
   * can offer "edit + resend" (load it back into the composer).
   */
  async function undo(count = 1): Promise<string | null> {
    const sid = rawState.activeSessionId;
    if (!sid) return null;
    // Capture the last user message text BEFORE the undo removes it.
    const lastUserText = (() => {
      const msgs = rawState.messagesBySession[sid] ?? [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]!;
        if (m.role !== "user") continue;
        if (
          m.metadata?.["origin"] &&
          (m.metadata["origin"] as { kind?: string }).kind !== "user"
        )
          continue;
        return m.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n");
      }
      return null;
    })();
    try {
      await getKimiWebApi().undoSession(sid, count);
      await syncSessionFromSnapshot(sid);
      return lastUserText;
    } catch (err) {
      pushOperationFailure("undo", err, { sessionId: sid });
      return null;
    }
  }

  /**
   * Remove a queued message for the active session by index.
   * Defensive: no-op if index out of range or no active session.
   */
  function unqueue(index: number): void {
    const sid = rawState.activeSessionId;
    if (!sid) return;
    const current = rawState.queuedBySession[sid] ?? [];
    if (index < 0 || index >= current.length) return;
    const next = [...current];
    next.splice(index, 1);
    rawState.queuedBySession = { ...rawState.queuedBySession, [sid]: next };
  }

  /**
   * Move a queued message within the active session's queue (drag-to-reorder).
   * Defensive: no-op if indices are equal, out of range, or no active session.
   */
  function reorderQueue(from: number, to: number): void {
    const sid = rawState.activeSessionId;
    if (!sid) return;
    const current = rawState.queuedBySession[sid] ?? [];
    if (from === to) return;
    if (from < 0 || from >= current.length || to < 0 || to >= current.length)
      return;
    const next = [...current];
    const [moved] = next.splice(from, 1);
    if (moved === undefined) return;
    next.splice(to, 0, moved);
    rawState.queuedBySession = { ...rawState.queuedBySession, [sid]: next };
  }
  return {
    renameSession,
    renameWorkspace,
    deleteWorkspace,
    archiveSession,
    exportSession,
    restoreSession,
    loadArchivedSessions,
    logout,
    compact,
    forkSession,
    undo,
    unqueue,
    reorderQueue,
  };
}

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

export function createSessionLoadActions(
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

  const SESSION_PAGE_SIZE = 100;
  // Sessions fetched per "load more" click within a workspace.
  const SESSIONS_LOAD_MORE_SIZE = 30;
  // On initial load, if the oldest session of the first page is still within
  // this window, keep fetching older pages until the oldest loaded session falls
  // outside it. Avoids clipping an active workspace's history at an arbitrary
  // 5-session boundary when it has a run of recently-updated sessions.
  const SESSIONS_RECENT_WINDOW_MS = 12 * 60 * 60 * 1000;

  /** Drain every page of sessions, newest first. A single global walk (instead of
   *  per-workspace) so sessions whose cwd is not a registered workspace root are
   *  still reachable after a refresh. A later-page failure returns the pages
   *  already fetched plus the error; only a first-page failure rejects. */
  async function listAllSessionsGlobal(): Promise<{
    sessions: AppSession[];
    error?: unknown;
  }> {
    const api = getKimiWebApi();
    const items: AppSession[] = [];
    let beforeId: string | undefined;
    let continuationError: unknown;
    for (;;) {
      let page: { items: AppSession[]; hasMore: boolean };
      try {
        page = await api.listSessions({
          pageSize: SESSION_PAGE_SIZE,
          beforeId,
          excludeEmpty: true,
        });
      } catch (error) {
        if (items.length === 0) throw error;
        continuationError = error;
        break;
      }
      items.push(...page.items);
      if (!page.hasMore || page.items.length === 0) break;
      beforeId = page.items[page.items.length - 1]!.id;
    }
    return { sessions: items, error: continuationError };
  }

  /**
   * Replace the sessions list wholesale, preserving the live usage accumulated
   * from /status and the WS status stream: the list endpoint returns all-zero
   * placeholder usage for every session, and a blind replace would zero the
   * context ring until the next refresh.
   */
  function setSessionsPreservingLiveUsage(sessions: AppSession[]): void {
    const liveUsageById = new Map(
      rawState.sessions.map((s) => [s.id, s.usage] as const),
    );
    setSessions(
      sessions.map((s) => {
        const live = liveUsageById.get(s.id);
        return live !== undefined &&
          isPlaceholderSessionUsage(s.usage) &&
          !isPlaceholderSessionUsage(live)
          ? { ...s, usage: live }
          : s;
      }),
    );
  }

  /** Keep fresh rows authoritative while retaining cached rows a partial list
   *  request never reached. */
  function mergePartialSessionsWithCached(
    sessions: AppSession[],
  ): AppSession[] {
    const merged = [...sessions];
    const loadedIds = new Set(merged.map((session) => session.id));
    for (const session of rawState.sessions) {
      if (loadedIds.has(session.id)) continue;
      merged.push(session);
      loadedIds.add(session.id);
    }
    merged.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    return merged;
  }

  /** Load the initial page of sessions for one workspace, then keep fetching
   *  older pages while the oldest loaded session is still within
   *  SESSIONS_RECENT_WINDOW_MS. Every page (including continuations) uses the
   *  small initial page size so a sparse page cannot pull in days of history at
   *  once. Continuation pages are also trimmed at the recent-window boundary,
   *  keeping only up to the first session that falls outside the window. */
  async function loadInitialSessionsForWorkspace(workspaceId: string): Promise<{
    workspaceId: string;
    page: { items: AppSession[]; hasMore: boolean };
    error?: unknown;
  }> {
    const api = getKimiWebApi();
    const items: AppSession[] = [];
    const now = Date.now();
    const ageOf = (s: AppSession): number =>
      now - new Date(s.updatedAt).getTime();
    let beforeId: string | undefined;
    let hasMore = false;
    let isFirstPage = true;
    let continuationError: unknown;
    for (;;) {
      let page: { items: AppSession[]; hasMore: boolean };
      try {
        page = await api.listSessions({
          workspaceId,
          pageSize: SESSIONS_INITIAL_PAGE_SIZE,
          beforeId,
          excludeEmpty: true,
        });
      } catch (error) {
        // A failed continuation page must not discard sessions already loaded
        // from earlier pages; only a page-1 failure rejects the workspace load.
        if (isFirstPage) throw error;
        continuationError = error;
        hasMore = true;
        break;
      }
      hasMore = page.hasMore;
      if (page.items.length === 0) break;
      const oldest = page.items[page.items.length - 1]!;
      const oldestBeyondWindow = ageOf(oldest) >= SESSIONS_RECENT_WINDOW_MS;

      if (!isFirstPage && oldestBeyondWindow) {
        // This continuation page crosses the recent-window boundary. Keep only
        // up to and including the first session that falls outside the window
        // (so the oldest loaded is the first one older than the window) and
        // drop the older tail instead of loading the whole page.
        const boundaryIndex = page.items.findIndex(
          (s) => ageOf(s) >= SESSIONS_RECENT_WINDOW_MS,
        );
        const keep = boundaryIndex >= 0 ? boundaryIndex + 1 : page.items.length;
        items.push(...page.items.slice(0, keep));
        hasMore = page.hasMore || keep < page.items.length;
        break;
      }

      items.push(...page.items);
      isFirstPage = false;
      if (!page.hasMore || oldestBeyondWindow) break;
      beforeId = oldest.id;
    }
    return { workspaceId, page: { items, hasMore }, error: continuationError };
  }

  /** Fetch the first page of sessions for every known workspace concurrently.
   *  Returns the merged, recency-sorted list and seeds per-workspace hasMore.
   *  When every workspace request fails, returns undefined so the caller keeps
   *  the previously loaded sessions instead of committing a false empty list. */
  async function loadInitialSessionsByWorkspace(): Promise<
    AppSession[] | undefined
  > {
    const workspaces = rawState.workspaces;
    if (workspaces.length === 0) {
      // /workspaces may be unavailable or empty on older / partially-failing
      // daemons while /sessions still works. Fall back to the legacy global
      // walk so history still shows and mergedWorkspaces can derive workspaces
      // from session cwds, instead of rendering a blank sidebar.
      const fallback = await listAllSessionsGlobal();
      const sessions =
        fallback.error === undefined
          ? fallback.sessions
          : mergePartialSessionsWithCached(fallback.sessions);
      rawState.sessionsHasMoreByWorkspace = {};
      rawState.sessionsCursorByWorkspace = {};
      rawState.sessionsInitialCountByWorkspace = {};
      rawState.sessionsFullyLoaded = fallback.error === undefined;
      if (fallback.error !== undefined)
        pushOperationFailure("load", fallback.error);
      return sessions;
    }
    const results = await Promise.allSettled(
      workspaces.map((w) => loadInitialSessionsForWorkspace(w.id)),
    );
    const loaded: AppSession[] = [];
    const loadedIds = new Set<string>();
    const successfulPages = new Map<
      string,
      { items: AppSession[]; hasMore: boolean }
    >();
    const failedWorkspaceIds = new Set<string>();
    let firstError: unknown;
    for (let index = 0; index < results.length; index++) {
      const result = results[index]!;
      if (result.status === "fulfilled") {
        successfulPages.set(result.value.workspaceId, result.value.page);
        if (result.value.error !== undefined) {
          if (failedWorkspaceIds.size === 0) firstError = result.value.error;
          failedWorkspaceIds.add(result.value.workspaceId);
        }
        for (const session of result.value.page.items) {
          if (loadedIds.has(session.id)) continue;
          loaded.push(session);
          loadedIds.add(session.id);
        }
        continue;
      }
      if (failedWorkspaceIds.size === 0) firstError = result.reason;
      failedWorkspaceIds.add(workspaces[index]!.id);
    }

    // One failed workspace must not erase another workspace's successful page,
    // nor the failed workspace's last usable rows. If every request failed,
    // leave both sessions and pagination state untouched for a natural retry.
    if (successfulPages.size === 0) {
      pushOperationFailure("load", firstError);
      return undefined;
    }
    const failedWorkspaceRoots = new Set(
      workspaces
        .filter((workspace) => failedWorkspaceIds.has(workspace.id))
        .map((workspace) => workspace.root),
    );
    const registeredWorkspaceIds = new Set(
      workspaces.map((workspace) => workspace.id),
    );
    for (const session of rawState.sessions) {
      const belongsToFailedWorkspace =
        session.workspaceId !== undefined &&
        registeredWorkspaceIds.has(session.workspaceId)
          ? failedWorkspaceIds.has(session.workspaceId)
          : failedWorkspaceRoots.has(session.cwd) ||
            failedWorkspaceIds.has(workspaceIdForSession(session));
      if (!belongsToFailedWorkspace || loadedIds.has(session.id)) continue;
      loaded.push(session);
      loadedIds.add(session.id);
    }

    const hasMore: Record<string, boolean> = {};
    const cursors: Record<string, string | undefined> = {};
    const counts: Record<string, number> = {};
    for (const { id: workspaceId } of workspaces) {
      const page = successfulPages.get(workspaceId);
      if (page === undefined) {
        const previousHasMore =
          rawState.sessionsHasMoreByWorkspace[workspaceId];
        const previousCursor = rawState.sessionsCursorByWorkspace[workspaceId];
        const previousCount =
          rawState.sessionsInitialCountByWorkspace[workspaceId];
        if (previousHasMore !== undefined)
          hasMore[workspaceId] = previousHasMore;
        if (previousCursor !== undefined) cursors[workspaceId] = previousCursor;
        if (previousCount !== undefined) counts[workspaceId] = previousCount;
        continue;
      }
      // Trust the server's hasMore — the per-workspace session_count is only a
      // (possibly stale) label total, not an authority on whether more pages exist.
      hasMore[workspaceId] = page.hasMore;
      // Cursor = oldest session of this page (pages are newest-first). Tracked
      // separately from the loaded set so a deep-linked older session appended
      // out of band cannot shift the cursor and skip intervening sessions.
      cursors[workspaceId] =
        page.items.length > 0
          ? page.items[page.items.length - 1]!.id
          : undefined;
      // Collapse target for the sidebar's in-group "show less" control: the
      // first-page capacity, floored at a full page so a workspace that was
      // empty or sparse on first paint does not hide sessions created later.
      // If the initial load pulled more than a page (recent-window
      // continuations), keep the larger count so collapse returns to what was
      // first visible.
      counts[workspaceId] = Math.max(
        page.items.length,
        SESSIONS_INITIAL_PAGE_SIZE,
      );
    }
    rawState.sessionsHasMoreByWorkspace = hasMore;
    rawState.sessionsCursorByWorkspace = cursors;
    rawState.sessionsInitialCountByWorkspace = counts;
    rawState.sessionsFullyLoaded = false;
    // Keep rawState.sessions newest-first for readers that pick sessions[0]
    // (e.g. auto-selecting the most recent session on first load).
    loaded.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    if (failedWorkspaceIds.size > 0) pushOperationFailure("load", firstError);
    return loaded;
  }

  /** Fetch the next page of sessions for a workspace (the "load more" button). */
  async function loadMoreSessions(workspaceId: string): Promise<void> {
    if (rawState.sessionsLoadingMoreByWorkspace[workspaceId]) return;
    if (rawState.sessionsHasMoreByWorkspace[workspaceId] === false) return;
    const beforeId = rawState.sessionsCursorByWorkspace[workspaceId];
    if (beforeId === undefined) return;
    rawState.sessionsLoadingMoreByWorkspace = {
      ...rawState.sessionsLoadingMoreByWorkspace,
      [workspaceId]: true,
    };
    try {
      const page = await getKimiWebApi().listSessions({
        workspaceId,
        pageSize: SESSIONS_LOAD_MORE_SIZE,
        beforeId,
        excludeEmpty: true,
      });
      // Append de-duped against the latest list so a concurrently added/removed
      // session is respected.
      const existing = new Set(rawState.sessions.map((s) => s.id));
      const fresh = page.items.filter((s) => !existing.has(s.id));
      if (fresh.length > 0) setSessions([...rawState.sessions, ...fresh]);
      // Advance the cursor to the end of the page we just fetched.
      rawState.sessionsCursorByWorkspace = {
        ...rawState.sessionsCursorByWorkspace,
        [workspaceId]:
          page.items.length > 0
            ? page.items[page.items.length - 1]!.id
            : beforeId,
      };
      // Trust the server's hasMore. Deriving it from the workspace session_count
      // is unsafe: archive/delete only removes the local session and leaves the
      // count stale, which would keep hasMore true and re-fetch empty pages.
      rawState.sessionsHasMoreByWorkspace = {
        ...rawState.sessionsHasMoreByWorkspace,
        [workspaceId]: page.hasMore,
      };
    } catch (err) {
      pushOperationFailure("loadMoreSessions", err);
    } finally {
      rawState.sessionsLoadingMoreByWorkspace = {
        ...rawState.sessionsLoadingMoreByWorkspace,
        [workspaceId]: false,
      };
    }
  }

  /** Drain every session via a single global walk so client-side search covers
   *  all sessions, not just the first page per workspace. Triggered lazily on
   *  first search; a no-op once the full list is loaded. */
  async function loadAllSessions(): Promise<void> {
    if (rawState.sessionsFullyLoaded) return;
    const result = await listAllSessionsGlobal().catch((err) => {
      console.warn(
        "[kimi-web] loadAllSessions failed; search covers only loaded sessions",
        err,
      );
      return null;
    });
    if (result === null) return;
    const sessions =
      result.error === undefined
        ? result.sessions
        : mergePartialSessionsWithCached(result.sessions);
    setSessionsPreservingLiveUsage(sessions);
    rawState.sessionsFullyLoaded = result.error === undefined;
    if (result.error !== undefined) return;
    const cleared: Record<string, boolean> = {};
    for (const w of rawState.workspaces) cleared[w.id] = false;
    rawState.sessionsHasMoreByWorkspace = cleared;
  }

  /**
   * Re-read GET /meta and apply the server-self fields (version, open-in
   * apps, auth bypass). Called on first load and on every WS reconnect so
   * values remain truthful across server restarts.
   */
  async function refreshServerMeta(): Promise<void> {
    const m = await getKimiWebApi()
      .getMeta()
      .catch(() => null);
    if (m === null) return;
    rawState.serverVersion = m.serverVersion;
    rawState.availableOpenInApps = m.openInApps;
    rawState.dangerousBypassAuth = m.dangerousBypassAuth;
  }

  async function load(): Promise<void> {
    const startedAt = Date.now();
    let traceStatus = "accepted";
    traceKeyEvent("app:load:start");
    rawState.loading = true;
    // The very first load gates on /auth before anything else: a transient
    // failure there (daemon still booting, network blip, 5xx) must NOT be read
    // as "not signed in" — that bounced users to /login until a manual refresh.
    // Keep the connecting splash up and poll /auth until a definitive outcome.
    // A 401/40101 means the server wants a token: stop and let the
    // ServerAuthDialog take over (it reloads once the token is entered).
    const firstLoad = !initialized.value;
    let authResolved = true;
    try {
      if (firstLoad && (await ctx.waitForFirstAuth()) === "server-auth-required") {
        authResolved = false;
        traceStatus = "auth-required";
        return;
      }
      const api = getKimiWebApi();
      // Parallel: health + meta + models
      await Promise.all([
        api.getHealth().catch(() => null),
        refreshServerMeta(),
        modelProvider.loadModels(),
      ]);

      // Check auth readiness and global config (separate calls — defensive)
      if (!firstLoad) await ctx.checkAuth();
      await ctx.loadConfig();

      // Load workspaces first (registered + derived, each with a session_count),
      // then fetch only the first page of sessions per workspace. This replaces
      // the old full global walk: the sidebar now truncates by loading, not by
      // hiding already-fetched rows.
      await ctx.loadWorkspaces();
      const loadedSessions = await loadInitialSessionsByWorkspace();
      const sessions = loadedSessions ?? rawState.sessions;
      if (loadedSessions !== undefined)
        setSessionsPreservingLiveUsage(loadedSessions);

      // First load: pick the workspace of the most-recent session, unless the
      // user already has a persisted active workspace that still exists.
      const mostRecent = sessions[0];
      const persisted = rawState.activeWorkspaceId;
      const persistedStillExists =
        persisted !== null &&
        mergedWorkspaces.value.some((w) => w.id === persisted);
      if (!persistedStillExists && mostRecent) {
        ctx.selectWorkspace(workspaceIdForSession(mostRecent));
      }

      // URL deep link (/sessions/<id>) takes priority over auto-select. The
      // session may live outside the loaded pages (e.g. archived) — fetch it then.
      // selectSession syncs the active workspace off the (now present) entry.
      ctx.bindSessionRoute();
      const urlSessionId =
        typeof window !== "undefined"
          ? readSessionIdFromLocation(window.location)
          : undefined;
      if (!rawState.activeSessionId && urlSessionId !== undefined) {
        const available =
          rawState.sessions.some((s) => s.id === urlSessionId) ||
          (await ctx.fetchSessionIntoList(urlSessionId));
        if (available) {
          await ctx.selectSession(urlSessionId, { urlMode: "replace" });
        }
      }

      // Auto-select first session if none selected (also the fallback for a dead
      // deep link — 'replace' rewrites the URL to the session actually shown).
      if (!rawState.activeSessionId && sessions.length > 0) {
        await ctx.selectSession(sessions[0]!.id, { urlMode: "replace" });
      }
    } catch (err) {
      traceStatus = "failed";
      pushOperationFailure("load", err);
      // Do not re-throw — app stays mounted with empty sessions
    } finally {
      rawState.loading = false;
      // Without a definitive /auth outcome the splash stays up (retry loop or
      // ServerAuthDialog is handling it) — never expose the half-loaded app.
      if (authResolved) initialized.value = true;
      traceKeyEvent("app:load:complete", {
        status: traceStatus,
        sessionId: rawState.activeSessionId,
        sessionCount: rawState.sessions.length,
        workspaceCount: rawState.workspaces.length,
        durationMs: Date.now() - startedAt,
      });
    }
  }

  /** Load workspaces from the daemon (falls back to derived in mergedWorkspaces). */
  return {
    listAllSessionsGlobal,
    setSessionsPreservingLiveUsage,
    mergePartialSessionsWithCached,
    loadInitialSessionsForWorkspace,
    loadInitialSessionsByWorkspace,
    loadMoreSessions,
    loadAllSessions,
    refreshServerMeta,
    load,
  };
}

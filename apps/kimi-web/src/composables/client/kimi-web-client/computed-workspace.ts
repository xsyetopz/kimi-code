import { computed, ref, watch } from "vue";
import {
  reconcileWorkspaceOrder,
  sortByWorkspaceOrder,
  sortWorkspacesByRecent,
  type WorkspaceSortMode,
} from "../../../lib/workspaceOrder";
import {
  loadWorkspaceOrder,
  loadWorkspaceSort,
  saveWorkspaceOrder,
  saveWorkspaceSort,
} from "../../../lib/storage";
import { mergeWorkspaces } from "../../../lib/mergeWorkspaces";
import { workspaceRootKey } from "../../../lib/rootKey";
import type { AppConfig, AppWorkspace } from "../../../api/types";
import type {
  ConversationStatus,
  DiffViewLine,
  Session,
  WorkspaceGroup,
  WorkspaceView,
} from "../../../types";
import { rawState, sessionTimeClock, modelProvider, fileDiffLines } from "./runtime";
import { shortenHome } from "./storage-helpers";
import { isMainTurnActive, formatTime } from "./view-mappers";
import { SESSIONS_INITIAL_PAGE_SIZE } from "../useWorkspaceState";


/** Git info for the active session from the daemon's fs:git_status response */
export const gitInfo = computed<{
  branch: string;
  ahead: number;
  behind: number;
} | null>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return null;
  const gs = rawState.gitStatusBySession[sid];
  if (!gs) return null;
  return { branch: gs.branch, ahead: gs.ahead, behind: gs.behind };
});

/** GitHub pull request for the active session's current branch. Null when
    unknown, not a GitHub repo, or the branch has no PR — the header hides it. */
export const activePullRequest = computed<{
  number: number;
  state: string;
  url: string;
} | null>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return null;
  return rawState.gitStatusBySession[sid]?.pullRequest ?? null;
});

/** Changed files for the active session, sorted by path */
export const changes = computed<{ path: string; status: string }[]>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  const gs = rawState.gitStatusBySession[sid];
  if (!gs) return [];
  return Object.entries(gs.entries)
    .map(([path, status]) => ({ path, status }))
    .sort((a, b) => a.path.localeCompare(b.path));
});

/** Aggregate working-tree line stats (vs HEAD) for the active session's header
    diff counter. Null when no git status is loaded, so the header hides it. */
export const gitDiffStats = computed<{
  totalAdditions: number;
  totalDeletions: number;
} | null>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return null;
  const gs = rawState.gitStatusBySession[sid];
  if (!gs) return null;
  return { totalAdditions: gs.additions, totalDeletions: gs.deletions };
});

export const status = computed<ConversationStatus>(() => {
  const activeSession = rawState.sessions.find(
    (s) => s.id === rawState.activeSessionId,
  );
  // Prefer real git branch from daemon; fall back to cwd basename
  const branch =
    gitInfo.value?.branch ??
    (activeSession
      ? (activeSession.cwd.split("/").pop() ?? activeSession.cwd)
      : "main");
  // session.model is kept live by GET /status (on select/idle) and the WS
  // agent.status.updated event during a turn; fall back to the daemon default.
  // In the draft state (no active session) the user's draft pick wins, so the
  // composer dropdown reflects the selection before the session exists.
  const draftPick =
    activeSession === undefined ? modelProvider!.draftModel.value : null;
  const rawModel =
    (activeSession?.model && activeSession.model.length > 0
      ? activeSession.model
      : (draftPick ?? rawState.defaultModel)) ?? "—";

  // Use the friendly displayName from the models list; fall back to stripping
  // the provider prefix (e.g. "moonshot/moonshot-v1-128k" → "moonshot-v1-128k").
  // Prefer the exact id — model names can collide across providers, so a
  // name-only match may resolve to the wrong provider's entry.
  const matched =
    modelProvider!.models.value.find((m) => m.id === rawModel) ??
    modelProvider!.models.value.find((m) => m.model === rawModel);
  const displayModel =
    matched?.displayName ||
    matched?.model ||
    (rawModel.includes("/") ? rawModel.split("/").pop()! : rawModel);

  return {
    model: displayModel,
    // Raw id for exact comparison in pickers (display name diverges from id).
    modelId: matched?.id ?? rawModel,
    ctxUsed: activeSession?.usage.contextTokens ?? 0,
    ctxMax: activeSession?.usage.contextLimit ?? 0,
    permission: rawState.permission,
    branch,
    cwd: activeSession?.cwd ?? "",
    isGitRepo: gitInfo.value !== null,
  };
});

/** Parsed unified-diff lines for the file selected in the ~/diff tab. */
export const fileDiff = computed<DiffViewLine[]>(() => fileDiffLines.value);

/** Cumulative cost (USD) for the active session, from daemon usage. 0 if unknown. */
export const sessionCost = computed<number>(() => {
  const activeSession = rawState.sessions.find(
    (s) => s.id === rawState.activeSessionId,
  );
  return activeSession?.usage.totalCostUsd ?? 0;
});

export const authReady = computed<boolean>(() => rawState.authReady);
export const defaultModel = computed<string | null>(() => rawState.defaultModel);
export const managedProviderStatus = computed<string | null>(
  () => rawState.managedProviderStatus,
);
export const config = computed<AppConfig | null>(() => rawState.config);

/** path → status map for quick badge lookup in the file tree */
export const changesByPath = computed<Record<string, string>>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return {};
  const gs = rawState.gitStatusBySession[sid];
  if (!gs) return {};
  return { ...gs.entries };
});

// ---------------------------------------------------------------------------
// Workspace view-model
// ---------------------------------------------------------------------------

/**
 * The workspace id a session belongs to: the first registered workspace whose
 * root identity-matches the session cwd (folds Windows case/slash variants —
 * keeps grouping consistent with `mergeWorkspaces` so a session never falls
 * out of the group the merge rendered); otherwise the daemon-provided
 * session.workspaceId; otherwise the cwd itself (derived/fallback mode).
 */
export function workspaceIdForSession(s: {
  workspaceId?: string;
  cwd: string;
}): string {
  const cwdKey = workspaceRootKey(s.cwd);
  return (
    rawState.workspaces.find((w) => workspaceRootKey(w.root) === cwdKey)?.id ??
    s.workspaceId ??
    s.cwd
  );
}

/**
 * Merge real (daemon) workspaces with workspaces DERIVED from the current
 * sessions' cwds. Each distinct cwd with no matching real workspace becomes one
 * derived workspace (id = root = cwd). This makes the switcher + grouping work
 * immediately off existing sessions until /workspaces ships.
 */
export const mergedWorkspaces = computed<AppWorkspace[]>(() =>
  mergeWorkspaces({
    workspaces: rawState.workspaces,
    sessions: rawState.sessions,
    hiddenWorkspaceRoots: rawState.hiddenWorkspaceRoots,
    sessionsHasMoreByWorkspace: rawState.sessionsHasMoreByWorkspace,
  }),
);

/**
 * User-defined display order of workspace ids, persisted to localStorage. The
 * sidebar stops following the daemon's recency-based order: once a workspace is
 * known, its position is fixed until the user drags it elsewhere.
 */
const workspaceOrder = ref<string[]>(loadWorkspaceOrder());

/**
 * Sidebar workspace sort mode. `recent` (default) re-sorts by each workspace's
 * most recent session activity and stays live as sessions update; `manual` keeps
 * the persisted/dragged order. Persisted so the choice survives a refresh.
 */
export const workspaceSortMode = ref<WorkspaceSortMode>(
  loadWorkspaceSort() === "manual" ? "manual" : "recent",
);

// Reconcile the persisted order with the set of currently-known workspaces:
// drop ids that no longer exist, and prepend newly-seen ids (newest first,
// matching "createdAt desc" — the closest signal we have without a real
// workspace creation timestamp). Watched on the id *set* (joined) so a pure
// daemon reorder of the same workspaces does not rewrite the user's order, and
// a drag reorder (which also writes `workspaceOrder` but keeps the same id set)
// does not re-trigger it.
//
// The watch also tracks `loading` and bails out while a load is in progress.
// During `load()`, sessions (and thus derived workspaces) are set *before* the
// real workspaces arrive, so a real workspace with no sessions is momentarily
// absent from `mergedWorkspaces`. Without the loading guard the reconciler would
// drop it as "deleted" and then, when it appears a tick later, re-add it at the
// top — undoing the user's drag on refresh. Waiting until the load settles
// means we always reconcile against the complete set.
watch(
  () =>
    [
      mergedWorkspaces.value.map((w) => w.id).join("\0"),
      rawState.loading,
    ] as const,
  ([idsKey, loading]) => {
    if (loading) return;
    const current = idsKey ? idsKey.split("\0") : [];
    const next = reconcileWorkspaceOrder(current, workspaceOrder.value);
    if (next === null) return;
    workspaceOrder.value = next;
    saveWorkspaceOrder(next);
  },
);

/** Sidebar-facing workspace list. Order follows `workspaceSortMode`: the
 *  persisted/dragged order in `manual` mode, or most-recent-session-first in
 *  `recent` mode. The recent map is only built (and `rawState.sessions` only
 *  read) in the recent branch, so manual mode does not re-sort on every session
 *  update. */
export const workspacesView = computed<WorkspaceView[]>(() => {
  const views = mergedWorkspaces.value.map((w) => ({
    id: w.id,
    name: w.name,
    root: w.root,
    shortPath: shortenHome(w.root, rawState.fsHome),
    sessionCount: w.sessionCount,
  }));
  if (workspaceSortMode.value === "recent") {
    const lastEditedAt = new Map<string, number>();
    for (const s of rawState.sessions) {
      if (s.parentSessionId) continue;
      const wid = workspaceIdForSession(s);
      const t = new Date(s.updatedAt).getTime();
      if (t > (lastEditedAt.get(wid) ?? Number.NEGATIVE_INFINITY)) {
        lastEditedAt.set(wid, t);
      }
    }
    return sortWorkspacesByRecent(views, lastEditedAt);
  }
  return sortByWorkspaceOrder(views, workspaceOrder.value);
});

/** The active workspace id, falling back to the first available workspace. */
export const activeWorkspaceId = computed<string | null>(() => {
  const id = rawState.activeWorkspaceId;
  // Use the reordered list (not the raw daemon order) so the default/fallback
  // workspace matches the first group the user actually sees in the sidebar.
  const list = workspacesView.value;
  if (id && list.some((w) => w.id === id)) return id;
  return list[0]?.id ?? null;
});

// Pre-warm workspace-scoped skills so the onboarding composer's `/` menu is
// populated before a session exists. Loaded once per workspace (guard mirrors
// the per-session guard in refreshSessionSidecars); session skills take over
// via refreshSessionSidecars once a session is created.
watch(
  activeWorkspaceId,
  (id) => {
    if (!id) return;
    if (
      !Object.prototype.hasOwnProperty.call(
        modelProvider!.skillsByWorkspace.value,
        id,
      )
    ) {
      void modelProvider!.loadSkillsForWorkspace(id);
    }
  },
  { immediate: true },
);

/** The active workspace as a sidebar view (or null when none). */
export const visibleWorkspace = computed<WorkspaceView | null>(() => {
  const id = activeWorkspaceId.value;
  if (!id) return null;
  return workspacesView.value.find((w) => w.id === id) ?? null;
});

/**
 * All sessions for the sidebar (grouped by workspace via workspaceGroups).
 */
export const sessionsForView = computed<Session[]>(() => {
  void sessionTimeClock.value;
  const visibleWorkspaceIds = new Set(workspacesView.value.map((w) => w.id));
  // Join each session to its workspace name so the search dialog can show which
  // workspace a hit belongs to. Built once per recompute (O(n+m)) instead of a
  // per-session find.
  const nameByWorkspaceId = new Map(
    workspacesView.value.map((w) => [w.id, w.name]),
  );
  // Child ("side chat") sessions never appear in the main list — they live in
  // the side-chat panel only. Sessions under a removed (hidden) workspace are
  // excluded too, so this flat list matches what the grouped sidebar renders
  // and sidebar search can't resurrect sessions from a removed workspace.
  return rawState.sessions
    .filter(
      (s) =>
        !s.parentSessionId && visibleWorkspaceIds.has(workspaceIdForSession(s)),
    )
    .map((s) => {
      const workspaceId = workspaceIdForSession(s);
      return {
        id: s.id,
        title: s.title,
        time: formatTime(s.updatedAt),
        busy: isMainTurnActive(s.id, s.mainTurnActive),
        pendingInteraction: s.pendingInteraction,
        lastTurnReason: s.lastTurnReason,
        lastPrompt: s.lastPrompt,
        workspaceId,
        workspaceName: nameByWorkspaceId.get(workspaceId),
      };
    });
});

/** Per-workspace groups for the 'all workspaces' scope. */
export const workspaceGroups = computed<WorkspaceGroup[]>(() => {
  void sessionTimeClock.value;
  const byId = new Map<string, Session[]>();
  for (const s of rawState.sessions.toSorted(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  )) {
    if (s.parentSessionId) continue; // child sessions stay out of the list
    const wid = workspaceIdForSession(s);
    const view: Session = {
      id: s.id,
      title: s.title,
      time: formatTime(s.updatedAt),
      busy: isMainTurnActive(s.id, s.mainTurnActive),
      pendingInteraction: s.pendingInteraction,
      lastTurnReason: s.lastTurnReason,
      updatedAt: s.updatedAt,
    };
    const list = byId.get(wid) ?? [];
    list.push(view);
    byId.set(wid, list);
  }
  return workspacesView.value.map((w) => ({
    workspace: w,
    sessions: byId.get(w.id) ?? [],
    hasMore: rawState.sessionsHasMoreByWorkspace[w.id] ?? false,
    loadingMore: rawState.sessionsLoadingMoreByWorkspace[w.id] ?? false,
    initialCount:
      rawState.sessionsInitialCountByWorkspace[w.id] ??
      SESSIONS_INITIAL_PAGE_SIZE,
  }));
});

/**
 * Replace the workspace display order (e.g. after a drag reorder in the
 * sidebar) and persist it. The id set is unchanged, so the reconciliation
 * watcher above will not fire — only the sort in `workspacesView` reacts.
 */
export function reorderWorkspaces(ids: string[]): void {
  workspaceOrder.value = ids;
  saveWorkspaceOrder(ids);
  // A drag is an explicit manual ordering, so drop out of `recent` mode — the
  // dragged order would otherwise be overwritten by the live recency sort.
  if (workspaceSortMode.value !== "manual") {
    workspaceSortMode.value = "manual";
    saveWorkspaceSort("manual");
  }
}

/** Switch the sidebar workspace sort mode and persist the choice. */
export function setWorkspaceSortMode(mode: WorkspaceSortMode): void {
  if (workspaceSortMode.value === mode) return;
  workspaceSortMode.value = mode;
  saveWorkspaceSort(mode);
}

/**
 * Per-session pending-attention count = pending approvals + pending questions.
 * For the active session this is live (driven by WS events). Other sessions
 * are derived from whatever approvals/questions we've already seen; the row's
 * list-level pendingInteraction fact supplies the pre-status badge fallback.
 */
export const attentionBySession = computed<Record<string, number>>(() => {
  const out: Record<string, number> = {};
  for (const [sid, list] of Object.entries(rawState.approvalsBySession)) {
    if (list.length > 0) out[sid] = (out[sid] ?? 0) + list.length;
  }
  for (const [sid, list] of Object.entries(rawState.questionsBySession)) {
    if (list.length > 0) out[sid] = (out[sid] ?? 0) + list.length;
  }
  return out;
});

/**
 * Per-session pending counts split by KIND, so the sidebar can show distinct
 * coloured tags: one for "awaiting your answer" (askUserQuestion) and one for
 * "awaiting your approval" (permission request). The merged count above stays
 * for the workspace rail / dialogs that only need a single number.
 */
export const pendingBySession = computed<
  Record<string, { approvals: number; questions: number }>
>(() => {
  const out: Record<string, { approvals: number; questions: number }> = {};
  for (const [sid, list] of Object.entries(rawState.approvalsBySession)) {
    if (list.length > 0)
      (out[sid] ??= { approvals: 0, questions: 0 }).approvals = list.length;
  }
  for (const [sid, list] of Object.entries(rawState.questionsBySession)) {
    if (list.length > 0)
      (out[sid] ??= { approvals: 0, questions: 0 }).questions = list.length;
  }
  return out;
});

/** Per-session unread flag (a background turn finished, not yet opened). */
export const unreadBySession = computed<Record<string, boolean>>(() => {
  const out: Record<string, boolean> = {};
  for (const [sid, unread] of Object.entries(rawState.unreadBySession)) {
    if (unread) out[sid] = true;
  }
  return out;
});

/**
 * Per-workspace pending-attention count = sum of attentionBySession over the
 * sessions belonging to each workspace. Drives the rail's attention badge.
 */
export const attentionByWorkspace = computed<Record<string, number>>(() => {
  const out: Record<string, number> = {};
  const perSession = attentionBySession.value;
  for (const s of rawState.sessions) {
    const count = perSession[s.id] ?? 0;
    if (count <= 0) continue;
    const wid = workspaceIdForSession(s);
    out[wid] = (out[wid] ?? 0) + count;
  }
  return out;
});

/** Recently-used roots for the add-workspace quick-pick (from /fs:home). */
export const recentRoots = computed<string[]>(() => rawState.recentRoots);

/** Installed external apps the "Open in app" menu may offer for this host. */
export const availableOpenInApps = computed<string[]>(
  () => rawState.availableOpenInApps,
);

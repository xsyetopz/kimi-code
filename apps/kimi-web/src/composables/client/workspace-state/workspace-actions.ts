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

export function createWorkspaceActions(
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

  async function loadWorkspaces(): Promise<void> {
    try {
      const api = getKimiWebApi();
      const [list, home] = await Promise.all([
        api.listWorkspaces().catch(() => [] as AppWorkspace[]),
        api.getFsHome().catch(() => ({ home: "", recentRoots: [] })),
      ]);
      rawState.workspaces = applyWorkspaceNameOverrides(list);
      rawState.fsHome = home.home || null;
      rawState.recentRoots = home.recentRoots;
    } catch {
      // Defensive — derived workspaces still work off the loaded sessions.
    }
  }

  /** Overlay locally-persisted name overrides (see renameWorkspace fallback)
   *  onto a freshly loaded workspace list, keyed by root. */
  function applyWorkspaceNameOverrides(
    workspaces: AppWorkspace[],
  ): AppWorkspace[] {
    const overrides = loadWorkspaceNameOverrides();
    if (Object.keys(overrides).length === 0) return workspaces;
    return workspaces.map((w) => {
      const override = overrides[w.root];
      return override !== undefined ? { ...w, name: override } : w;
    });
  }

  /** Set the active workspace and persist it. */
  function selectWorkspace(id: string): void {
    rawState.activeWorkspaceId = id;
    saveActiveWorkspaceToStorage(id);
  }

  /** Open a workspace in the main pane: clear the active session when the
   *  workspace is empty so the centred composer is shown; otherwise activate
   *  the most recent session in that workspace. */
  function openWorkspace(id: string): void {
    ctx.selectWorkspace(id);
    const sessionsInWs = rawState.sessions.filter(
      (s) => workspaceIdForSession(s) === id,
    );
    if (sessionsInWs.length > 0) {
      const mostRecent = sessionsInWs[0];
      if (mostRecent && mostRecent.id !== rawState.activeSessionId) {
        // One user action (clicking the workspace) = one history entry.
        void ctx.selectSession(mostRecent.id);
      }
    } else {
      setActiveSessionId(undefined);
      ctx.writeSessionUrl(undefined, "push");
    }
  }

  /** Upsert a workspace: preserve existing order when updating; prepend only
   *  for truly new workspaces. */
  function upsertWorkspacePreserveOrder(workspace: AppWorkspace): void {
    // A locally-renamed derived workspace may carry a saved name override; apply
    // it so a daemon upsert (e.g. registering the root on first chat) doesn't
    // clobber the name with the default basename.
    const override = loadWorkspaceNameOverrides()[workspace.root];
    const ws =
      override !== undefined ? { ...workspace, name: override } : workspace;
    // Re-adding a path the user previously removed should bring it back. The
    // hidden match in mergeWorkspaces is folded, so the removal must fold too
    // — otherwise hiding `C:\Foo` and re-adding `c:\foo` leaves the folded
    // entry hiding the workspace forever.
    const wsKey = workspaceRootKey(ws.root);
    if (
      rawState.hiddenWorkspaceRoots.some((r) => workspaceRootKey(r) === wsKey)
    ) {
      rawState.hiddenWorkspaceRoots = rawState.hiddenWorkspaceRoots.filter(
        (r) => workspaceRootKey(r) !== wsKey,
      );
      saveHiddenWorkspacesToStorage(rawState.hiddenWorkspaceRoots);
    }
    const index = rawState.workspaces.findIndex(
      (w) => w.id === ws.id || w.root === ws.root,
    );
    if (index === -1) {
      rawState.workspaces = [ws, ...rawState.workspaces];
      return;
    }
    const next = [...rawState.workspaces];
    next[index] = ws;
    rawState.workspaces = next;
  }

  type WorkspaceLifecycleEvent =
    | { type: "workspaceCreated"; workspace: AppWorkspace }
    | { type: "workspaceUpdated"; workspace: AppWorkspace }
    | { type: "workspaceDeleted"; workspaceId: string; root: string };

  /** Apply a workspace lifecycle event broadcast by the daemon (multi-client sync).
   *  Workspaces live outside the reducer in rawState, so these events are handled
   *  here instead of in reduceAppEvent. */
  function applyWorkspaceEvent(event: WorkspaceLifecycleEvent): void {
    if (
      event.type === "workspaceCreated" ||
      event.type === "workspaceUpdated"
    ) {
      ctx.upsertWorkspacePreserveOrder(event.workspace);
      return;
    }
    // workspaceDeleted — mirror the local deleteWorkspace so a removal initiated
    // by another client stays hidden even though its surviving sessions would
    // otherwise re-derive it in mergedWorkspaces.
    const root =
      rawState.workspaces.find((w) => w.id === event.workspaceId)?.root ??
      event.root;
    if (root && !rawState.hiddenWorkspaceRoots.includes(root)) {
      rawState.hiddenWorkspaceRoots = [...rawState.hiddenWorkspaceRoots, root];
      saveHiddenWorkspacesToStorage(rawState.hiddenWorkspaceRoots);
    }
    rawState.workspaces = rawState.workspaces.filter(
      (w) => w.id !== event.workspaceId && w.root !== root,
    );
    const removingActiveWorkspace =
      rawState.activeWorkspaceId === event.workspaceId ||
      rawState.activeWorkspaceId === root;
    if (removingActiveWorkspace) {
      const nextWorkspace = workspacesView.value[0]?.id ?? null;
      rawState.activeWorkspaceId = nextWorkspace;
      if (nextWorkspace) saveActiveWorkspaceToStorage(nextWorkspace);
      else {
        try {
          safeRemove(STORAGE_KEYS.activeWorkspace);
        } catch {
          // ignore
        }
      }
      setActiveSessionId(undefined);
      rawState.sessionLoading = false;
      ctx.clearFileDiff();
      ctx.writeSessionUrl(undefined, "replace");
    }
  }

  /** Clear the active session without creating a new one. */
  function clearActiveSession(): void {
    setActiveSessionId(undefined);
    ctx.writeSessionUrl(undefined, "push");
  }

  /** Enter the "new session draft" state for a workspace: select it, clear the
   *  active session, and show the onboarding composer. No backend session is
   *  created until the user sends the first message. */
  function openWorkspaceDraft(workspaceId: string): void {
    ctx.selectWorkspace(workspaceId);
    ctx.clearActiveSession();
    ctx.clearFileDiff();
  }

  /**
   * Create a session in a workspace for an immediate first action — the first
   * prompt (`startSessionAndSendPrompt`) or a skill activation
   * (`startSessionAndActivateSkill`) from the empty-session composer. Returns
   * the new session id, or null if the workspace is unknown. Applies the staged
   * draft model + modes onto the new session. Throws on daemon failure so the
   * caller can surface the error via pushOperationFailure.
   */
  async function createDraftSession(
    workspaceId: string,
  ): Promise<string | null> {
    const ws = mergedWorkspaces.value.find((w) => w.id === workspaceId);
    if (!ws) return null;
    // Capture the draft thinking level BEFORE any await: a concurrent session
    // switch during creation re-resolves rawState.thinking for the other
    // active session, which would otherwise seed the new session with that
    // session's effort. Seeded into the new session's own entry below, the
    // first prompt/skill submits the pick and the daemon profile follows.
    const draftThinking = rawState.thinking;
    const api = getKimiWebApi();
    let workspaceIdForCreate: string | undefined;
    let cwdForCreate = ws.root;
    try {
      const registered = await api.addWorkspace({ root: ws.root });
      workspaceIdForCreate = registered.id;
      cwdForCreate = registered.root;
      ctx.upsertWorkspacePreserveOrder(registered);
    } catch {
      // Older daemons may not have /workspaces.
    }
    const draftPick = modelProvider.draftModel.value ?? undefined;
    const session = await api.createSession({
      workspaceId: workspaceIdForCreate,
      cwd: cwdForCreate,
      model: draftPick,
    });
    modelProvider.draftModel.value = null; // applied — the next draft starts from the default
    // The create echo may return model as '' (same daemon quirk as /profile);
    // keep the user's pick so the status line doesn't snap back to the default.
    const created =
      draftPick !== undefined && (!session.model || session.model.length === 0)
        ? { ...session, model: draftPick }
        : session;
    upsertSessionFront(created);
    ctx.selectWorkspace(session.workspaceId ?? workspaceIdForCreate ?? workspaceId);
    // NOTE: do NOT mark this session known-empty. Unlike "open a new empty
    // session" (createSession), here we immediately act on it: keeping
    // sessionLoading=true through the snapshot avoids flashing the empty-session
    // composer before the optimistic first turn lands. selectSession resolves,
    // then the caller adds the first turn synchronously (no await in between),
    // so the view goes loading → message with no empty-composer frame.
    await ctx.selectSession(session.id);
    // Carry any mode toggles the user staged in the empty composer into the
    // newly-created session, so the first action honors them. Write them to
    // this session's per-session maps by id (not via the activeSessionId-based
    // setters): if the user switches to another session while selectSession is
    // awaiting the snapshot, the setters would otherwise read the then-current
    // activeSessionId and pollute that session while this one loses the modes.
    const sid = session.id;
    if (draftThinking !== undefined) {
      rawState.thinkingBySession = {
        ...rawState.thinkingBySession,
        [sid]: draftThinking,
      };
    }
    if (draftModes.planMode) {
      rawState.planModeBySession = {
        ...rawState.planModeBySession,
        [sid]: true,
      };
      savePlanModeToStorage();
    }
    if (draftModes.swarmMode) {
      rawState.swarmModeBySession = {
        ...rawState.swarmModeBySession,
        [sid]: true,
      };
      saveSwarmModeToStorage();
    }
    if (draftModes.goalMode) {
      rawState.goalModeBySession = {
        ...rawState.goalModeBySession,
        [sid]: true,
      };
      saveGoalModeToStorage();
    }
    draftModes.planMode = false;
    draftModes.swarmMode = false;
    draftModes.goalMode = false;
    return sid;
  }

  /**
   * Create a session and immediately submit the first prompt.
   * This is the unified path when there is no active session (e.g. after
   * clicking "+" or in an empty workspace).
   */
  async function startSessionAndSendPrompt(
    workspaceId: string,
    text: string,
    attachments?: PromptAttachment[],
  ): Promise<void> {
    // Guard the whole "create draft session + submit first prompt" flow: the
    // session id doesn't exist until `createDraftSession` resolves, so the
    // per-session in-flight guard can't cover this window. A
    // second Enter / send-button click in that window would otherwise fire a
    // concurrent first POST for the same new session and trip the daemon's
    // `turn.agent_busy` race.
    if (startingFirstPromptWorkspaces.has(workspaceId)) return;
    startingFirstPromptWorkspaces.add(workspaceId);
    try {
      const sid = await ctx.createDraftSession(workspaceId);
      if (!sid) return;
      await ctx.submitPromptInternal(sid, text, attachments);
    } catch (err) {
      pushOperationFailure("startSessionAndSendPrompt", err);
    } finally {
      startingFirstPromptWorkspaces.delete(workspaceId);
    }
  }

  /**
   * Create a session and immediately activate a skill — the empty-composer
   * counterpart to startSessionAndSendPrompt. Without this, `/<skill>` from the
   * new-session screen silently dropped the activation (`activateSkill` needs a
   * session id). Shares createDraftSession so the model and draft modes are
   * applied identically to a prompt-started session; then persists any draft
   * plan/swarm modes here, because skill activation carries only `args`.
   */
  async function startSessionAndActivateSkill(
    workspaceId: string,
    skillName: string,
    args?: string,
  ): Promise<void> {
    // Same reentry window as startSessionAndSendPrompt (see the guard there):
    // draft-session creation selects the new session before the activation,
    // so concurrent first actions must be dropped here.
    if (startingFirstPromptWorkspaces.has(workspaceId)) return;
    startingFirstPromptWorkspaces.add(workspaceId);
    try {
      const sid = await ctx.createDraftSession(workspaceId);
      if (!sid) return;
      // Unlike a plain prompt, skill activation only carries `args`, so the
      // daemon never sees the prompt-time controls the user may have changed on
      // the draft (plan/swarm, plus permission via /auto|/yolo). Persist them
      // onto this new session's profile and await it before activating,
      // otherwise the first skill turn can start before applyAgentState and
      // run at daemon defaults while the UI shows otherwise. Thinking is NOT
      // persisted here — activateSkill resolves and persists it for this
      // session's model (gated) immediately before activating. Goal mode is a
      // one-shot flag consumed per send, not a profile field, so there is
      // nothing to persist for it.
      const planMode = rawState.planModeBySession[sid] ?? false;
      const swarmMode = rawState.swarmModeBySession[sid] ?? false;
      const promptSession = rawState.sessions.find((s) => s.id === sid);
      const model =
        (promptSession?.model && promptSession.model.length > 0
          ? promptSession.model
          : rawState.defaultModel) ?? undefined;
      // No thinking in this patch: activateSkill itself resolves and persists
      // the level for this session's model (single writer, gated) right before
      // activating — a second write here would be a redundant profile update
      // whose transient failure could false-veto a ready activation.
      const persisted = await persistSessionProfile(
        {
          model,
          planMode,
          swarmMode,
          permissionMode: rawState.permission,
        },
        sid,
      );
      // The persist surfaces its own failure; activating at a stale profile
      // effort is worse than not activating (the finally still re-arms below).
      if (!persisted) return;
      await modelProvider.activateSkill(skillName, args, sid);
    } catch (err) {
      pushOperationFailure("startSessionAndActivateSkill", err);
    } finally {
      startingFirstPromptWorkspaces.delete(workspaceId);
    }
  }

  /**
   * Create a session and open a BTW side chat under it — the empty-composer
   * counterpart to startSessionAndSendPrompt. Without this, `/btw <question>`
   * from the new-session screen silently no-ops (the panel still opens, but
   * empty), because openSideChat reads the active session id directly. The side
   * chat prompt itself carries model / thinking / permissionMode / plan / swarm
   * (see sendSideChatPromptOn), so unlike skill activation we don't need to
   * persist them onto the parent profile here.
   */
  async function startSessionAndOpenSideChat(
    workspaceId: string,
    prompt?: string,
  ): Promise<void> {
    // Same reentry window as startSessionAndSendPrompt (see the guard there).
    if (startingFirstPromptWorkspaces.has(workspaceId)) return;
    startingFirstPromptWorkspaces.add(workspaceId);
    try {
      const sid = await ctx.createDraftSession(workspaceId);
      if (!sid) return;
      await sideChat.openSideChatOn(sid, prompt);
    } catch (err) {
      pushOperationFailure("startSessionAndOpenSideChat", err);
    } finally {
      startingFirstPromptWorkspaces.delete(workspaceId);
    }
  }

  /**
   * Add a workspace by folder path, registering it with the daemon. Returns true
   * when the workspace was registered and selected; false when the daemon
   * rejected the path, so callers can keep the picker open and any pending
   * submission instead of dropping it. The caller surfaces the failure to the
   * user (e.g. an inline error in the picker).
   */
  async function addWorkspaceByPath(root: string): Promise<boolean> {
    const trimmed = root.trim();
    if (!trimmed) return false;
    const api = getKimiWebApi();
    try {
      const ws = await api.addWorkspace({ root: trimmed });
      ctx.upsertWorkspacePreserveOrder(ws);
      ctx.openWorkspaceDraft(ws.id);
      return true;
    } catch (err) {
      // The caller shows an inline error in the picker; keep the cause in the log.
      console.warn("[kimi-web] addWorkspaceByPath failed for", trimmed, err);
      return false;
    }
  }

  /**
   * Browse subdirectories under `path` (defaults to the daemon $HOME). Used by the
   * add-workspace folder browser. Defensive: returns an empty path on error so
   * the dialog can fall back to the paste-path field.
   */
  async function browseFs(
    path?: string,
  ): Promise<import("../../../api/types").FsBrowseResult> {
    try {
      const api = getKimiWebApi();
      return await api.browseFs(path);
    } catch {
      return { path: "", parent: null, entries: [] };
    }
  }

  /** Start directory + recently-used roots for the folder browser. */
  async function getFsHome(): Promise<{ home: string; recentRoots: string[] }> {
    try {
      const api = getKimiWebApi();
      return await api.getFsHome();
    } catch {
      return { home: "", recentRoots: [] };
    }
  }

  // ---------------------------------------------------------------------------
  // URL ↔ session binding (no router): '/' ↔ /sessions/<id>
  // urlMode semantics: 'push' = user navigation (new history entry); 'replace' =
  // programmatic/auto selection (first load, fallback after delete); 'none' =
  // popstate-driven (the URL is already correct — writing it again would loop).
  // ---------------------------------------------------------------------------

  return {
    loadWorkspaces,
    applyWorkspaceNameOverrides,
    selectWorkspace,
    openWorkspace,
    upsertWorkspacePreserveOrder,
    applyWorkspaceEvent,
    clearActiveSession,
    openWorkspaceDraft,
    createDraftSession,
    startSessionAndSendPrompt,
    startSessionAndActivateSkill,
    startSessionAndOpenSideChat,
    addWorkspaceByPath,
    browseFs,
    getFsHome,
  };
}

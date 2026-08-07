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

export function createModeActions(
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

  function setPlanMode(on: boolean): void {
    const sid = rawState.activeSessionId;
    if (sid) {
      rawState.planModeBySession = { ...rawState.planModeBySession, [sid]: on };
      savePlanModeToStorage();
      void persistSessionProfile({ planMode: on });
    } else {
      draftModes.planMode = on;
    }
  }

  /** Flip plan mode on/off for the active session (or the draft). */
  function togglePlanMode(): void {
    const sid = rawState.activeSessionId;
    const current = sid
      ? (rawState.planModeBySession[sid] ?? false)
      : draftModes.planMode;
    setPlanMode(!current);
  }

  /** Persist and apply swarm mode for the active session (pushed to its profile
   *  + sent per-prompt). With no active session the toggle is staged on the draft. */
  function setSwarmMode(on: boolean): void {
    const sid = rawState.activeSessionId;
    if (sid) {
      rawState.swarmModeBySession = {
        ...rawState.swarmModeBySession,
        [sid]: on,
      };
      saveSwarmModeToStorage();
      void persistSessionProfile({ swarmMode: on });
    } else {
      draftModes.swarmMode = on;
    }
  }

  /** Flip swarm mode on/off. In manual permission mode, ask before enabling. */
  async function toggleSwarmMode(): Promise<void> {
    const sid = rawState.activeSessionId;
    const current = sid
      ? (rawState.swarmModeBySession[sid] ?? false)
      : draftModes.swarmMode;
    const on = !current;
    if (on && rawState.permission === "manual") {
      const ok = await confirm({
        title: t("workspace.swarmEnableConfirm"),
        variant: "primary",
      });
      if (!ok) return;
    }
    setSwarmMode(on);
  }

  /** Persist goal mode for the active session. Unlike plan/swarm, this is a
   *  one-shot flag consumed on send (not pushed to the session profile). */
  function setGoalMode(on: boolean): void {
    const sid = rawState.activeSessionId;
    if (sid) {
      rawState.goalModeBySession = { ...rawState.goalModeBySession, [sid]: on };
      saveGoalModeToStorage();
    } else {
      draftModes.goalMode = on;
    }
  }

  /** Flip goal mode on/off for the active session (or the draft). */
  function toggleGoalMode(): void {
    const sid = rawState.activeSessionId;
    const current = sid
      ? (rawState.goalModeBySession[sid] ?? false)
      : draftModes.goalMode;
    setGoalMode(!current);
  }

  /** Create a goal by sending its objective to the session profile, then submit it as a prompt. */
  async function createGoal(objective: string): Promise<void> {
    const trimmed = objective.trim();
    if (!trimmed) return;
    if (rawState.permission === "manual") {
      const ok = await confirm({
        title: t("workspace.goalStartConfirm", { objective: trimmed }),
        variant: "primary",
      });
      if (!ok) return;
    }
    // Empty-composer heal: `/goal <objective>` from the new-session screen
    // would otherwise silently clear and run nothing. Create the session first
    // (same path as the first prompt / a new-session skill), then target it.
    let sid = rawState.activeSessionId;
    if (!sid) {
      // Use the same fallback as the client-wide computed activeWorkspaceId
      // (raw value if it exists, else the first sidebar-visible workspace). On a
      // fresh empty workspace load() never writes rawState.activeWorkspaceId
      // (there's no most-recent session to anchor it), so a raw read here would
      // be null and silently no-op even though the UI can still show a usable
      // workspace. Plain first-prompts and skill activations don't hit this
      // because App.vue passes the computed activeWorkspaceId in.
      const raw = rawState.activeWorkspaceId;
      const wsId =
        raw && workspacesView.value.some((w) => w.id === raw)
          ? raw
          : (workspacesView.value[0]?.id ?? null);
      if (!wsId) return;
      // App.vue invokes createGoal fire-and-forget, so a rejection here would
      // otherwise surface as an unhandled rejection instead of an operation
      // failure. Mirror the other draft-session paths (skill / BTW / first
      // prompt) which wrap createDraftSession.
      try {
        sid = (await ctx.createDraftSession(wsId)) ?? undefined;
      } catch (err) {
        pushOperationFailure("createGoal", err);
        return;
      }
      if (!sid) return;
    }
    try {
      await getKimiWebApi().updateSession(sid, { goalObjective: trimmed });
    } catch (err) {
      pushOperationFailure("createGoal", err, {
        sessionId: sid,
        message: goalErrorMessage(err),
      });
      return;
    }
    // The goal objective is set explicitly above. If goal mode was staged on the
    // draft (e.g. the user ran bare `/goal`, then `/goal <objective>`),
    // createDraftSession copied it into this session's goalModeBySession map.
    // Leaving it on would make submitPromptInternal (via sendPrompt) re-POST
    // another goalObjective — which the daemon rejects because a goal already
    // exists — and the user's objective prompt would never be submitted.
    // Clear the one-shot flag here: an explicit `/goal <objective>` has exactly
    // the same effect as the goal-mode flag's consumption.
    if (rawState.goalModeBySession[sid]) {
      rawState.goalModeBySession = {
        ...rawState.goalModeBySession,
        [sid]: false,
      };
      saveGoalModeToStorage();
    }
    // Preserve normal send queueing semantics whenever the goal still targets the
    // active session (the overwhelmingly common case): sendPrompt enqueues when
    // another turn is running or a prompt is already in flight. Only fall back to
    // the explicit-session send when activeSessionId moved during the create
    // window above, so a concurrent session switch can't redirect the goal prompt.
    // (The new session is otherwise idle+not-in-flight, so this does not race
    // another turn.)
    if (rawState.activeSessionId === sid) {
      await ctx.sendPrompt(trimmed);
    } else {
      await ctx.submitPromptInternal(sid, trimmed);
    }
  }

  /** Send a one-shot goal control action (pause/resume/cancel). */
  function controlGoal(action: "pause" | "resume" | "cancel"): void {
    const sid = rawState.activeSessionId;
    if (!sid) return;
    void Promise.resolve(
      getKimiWebApi().updateSession(sid, { goalControl: action }),
    ).catch((err) => {
      pushOperationFailure("controlGoal", err, {
        sessionId: sid,
        message: goalErrorMessage(err),
      });
    });
  }

  /** Persist and apply a new permission mode. Approval decisions are owned by
   *  the daemon (auto/yolo are resolved server-side), so any pending approvals
   *  are left for the user to answer explicitly. */
  function setPermission(mode: PermissionMode): void {
    rawState.permission = mode;
    savePermissionToStorage(mode);
    void persistSessionProfile({ permissionMode: mode });
  }

  /** Dismiss a warning by index */
  function dismissWarning(index: number): void {
    const list = [...rawState.warnings];
    list.splice(index, 1);
    rawState.warnings = list;
  }

  /** Rename a session — calls API and updates local state */
  return {
    setPlanMode,
    togglePlanMode,
    setSwarmMode,
    toggleSwarmMode,
    setGoalMode,
    toggleGoalMode,
    createGoal,
    controlGoal,
    setPermission,
    dismissWarning,
  };
}

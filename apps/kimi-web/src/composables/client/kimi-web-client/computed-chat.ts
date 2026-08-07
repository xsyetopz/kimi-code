import { computed } from "vue";
import { getKimiWebApi } from "../../../api";
import type {
  AppGoal,
  AppSkill,
  AppTask,
  AppWarning,
  ThinkingLevel,
} from "../../../api/types";
import type { CompactionStatus } from "../../../api/daemon/eventReducer";
import type {
  ActivationBadges,
  ActivityState,
  ApprovalBlock,
  ChatTurn,
  ConnectionState,
  PermissionMode,
  QueuedPromptView,
  Session,
  TaskItem,
  TodoView,
  UIQuestion,
  Workspace,
} from "../../../types";
import { messagesToTurns } from "../../messagesToTurns";
import { latestTodos } from "../../latestTodos";
import {
  buildSwarmGroups,
  countSwarmMembers,
  swarmMembersByToolCall,
  type SwarmGroup,
  type SwarmMember,
} from "../../swarmGroups";
import { useSideChat } from "../useSideChat";
import { useTaskPoller } from "../useTaskPoller";
import { useModelProviderState } from "../useModelProviderState";
import {
  rawState,
  draftModes,
  sessionTimeClock,
  sideChat,
  modelProvider,
  taskPoller,
  setSideChat,
  setModelProvider,
  setTaskPoller,
  workspaceState,
  eventConn,
} from "./runtime";
import {
  formatTime,
  isMainTurnActive,
  buildApprovalBlock,
  toUiQuestion,
  toUiTask,
} from "./view-mappers";
import { pushOperationFailure } from "./warnings-snapshot";
import {
  nextOptimisticMsgId,
  persistSessionProfile,
  refreshSessionStatus,
} from "./session-refresh";
import { connectEventsIfNeeded } from "./event-connection";
import { updateSession, updateSessionMessages } from "./session-mutations";
import { activeWorkspaceId } from "./computed-workspace";

// ---------------------------------------------------------------------------
// Computed view props
// ---------------------------------------------------------------------------

export const workspace = computed<Workspace>(() => {
  const activeSession = rawState.sessions.find(
    (s) => s.id === rawState.activeSessionId,
  );
  const branch = activeSession
    ? (activeSession.cwd.split("/").pop() ?? activeSession.cwd)
    : "main";
  return {
    name: rawState.workspaceName,
    branch,
  };
});

export const sessions = computed<Session[]>(() => {
  void sessionTimeClock.value;
  return rawState.sessions
    .toSorted(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    )
    .map((s) => ({
      id: s.id,
      title: s.title,
      time: formatTime(s.updatedAt),
      busy: isMainTurnActive(s.id, s.mainTurnActive),
      pendingInteraction: s.pendingInteraction,
      lastTurnReason: s.lastTurnReason,
    }));
});

export const activeSessionId = computed<string>(() => rawState.activeSessionId ?? "");

/** Slash-invocable skills for the composer `/` menu — the active session's skills,
 *  or, before a session exists, the active workspace's skills. */
export const skills = computed<AppSkill[]>(() => {
  const sid = rawState.activeSessionId;
  if (sid) return modelProvider!.skillsBySession.value[sid] ?? [];
  const wid = activeWorkspaceId.value;
  return wid ? (modelProviderInstance.skillsByWorkspace.value[wid] ?? []) : [];
});

export const inFlight = computed<boolean>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return false;
  return rawState.inFlightBySession[sid] ?? false;
});

// True while the empty-composer first prompt for the active workspace is being
// created + submitted (before the session id exists). Drives the empty-session
// "starting conversation…" loading state in ConversationPane / Composer.
export const isStartingFirstPrompt = computed<boolean>(() =>
  workspaceState!.isStartingFirstPrompt(),
);

const sideChatInstance = useSideChat(rawState, {
  pushOperationFailure,
  nextOptimisticMsgId,
  connectEventsIfNeeded,
  getEventConn: () => eventConn,
  // modelProvider is defined further below; deferred like eventConn above.
  resolveThinkingForPrompt: (sessionId, modelId) =>
    modelProviderInstance.resolveThinkingForPrompt(sessionId, modelId),
});

export const activeAppTasks = computed<AppTask[]>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  const hiddenBtwAgentId = sideChat!.sideChatTargetBySession.value[sid]?.agentId;
  return (rawState.tasksBySession[sid] ?? []).filter(
    (task) => task.id !== hiddenBtwAgentId,
  );
});

const taskPollerInstance = useTaskPoller(rawState, activeAppTasks);

export const turns = computed<ChatTurn[]>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  const hiddenIds = new Set(
    rawState.sideChatUserMessageIdsBySession[sid] ?? [],
  );
  const messages = (rawState.messagesBySession[sid] ?? []).filter(
    (m) => !hiddenIds.has(m.id),
  );
  const approvals = rawState.approvalsBySession[sid] ?? [];
  return messagesToTurns(
    messages,
    approvals,
    (fileId) => getKimiWebApi().getFileUrl(fileId),
    turnActive.value,
    rawState.planReviewByToolCallId,
  );
});

/** The MAIN agent of the active session has a turn in flight — the working
 *  moon's authoritative half (the optimistic `inFlight` window covers the gap
 *  before the turn.started round-trips). Background agents and BTW side chats
 *  do NOT set this; the session-busy status lives on `activity`. */
export const turnActive = computed<boolean>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return false;
  return (
    (rawState.turnActiveBySession[sid] ?? false) ||
    (rawState.sessions.find((session) => session.id === sid)?.mainTurnActive ??
      false)
  );
});

/** The working moon: the main conversation has an unfinished prompt — either
 *  submitted-but-not-terminated (`inFlight`) or a main turn in flight
 *  (`turnActive`). */
export const working = computed<boolean>(() => inFlight.value || turnActive.value);

export const tasks = computed<TaskItem[]>(() => {
  // Touch the clock so a running task's elapsed time recomputes each tick.
  void taskPoller!.taskClock.value;
  return activeAppTasks.value.map(toUiTask);
});

export const swarms = computed<SwarmGroup[]>(() =>
  buildSwarmGroups(activeAppTasks.value),
);
// Foreground/background subagents keyed by their spawning tool call id — used by
// the inline AgentSwarm tool card to stream each subagent's live progress.
export const swarmMembersByToolCallId = computed<Map<string, SwarmMember[]>>(() =>
  swarmMembersByToolCall(activeAppTasks.value),
);

export const goal = computed<AppGoal | null>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return null;
  return rawState.goalBySession[sid] ?? null;
});

/** Current todo list of the active session (TodoList tool, latest write wins). */
export const todos = computed<TodoView[]>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  return latestTodos(rawState.messagesBySession[sid] ?? []);
});

/** Live compaction state of the active session (present only while running). */
export const compaction = computed<CompactionStatus | null>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return null;
  return rawState.compactionBySession[sid] ?? null;
});

export const connection = computed<ConnectionState>(() => rawState.connection);

export const loading = computed<boolean>(() => rawState.loading);
export const sessionLoading = computed<boolean>(() => rawState.sessionLoading);
export const loadingMoreMessages = computed<boolean>(() => {
  const sid = rawState.activeSessionId;
  return sid ? (rawState.messagesLoadingMoreBySession[sid] ?? false) : false;
});
export const hasMoreMessages = computed<boolean>(() => {
  const sid = rawState.activeSessionId;
  return sid ? (rawState.messagesHasMoreBySession[sid] ?? false) : false;
});
export const loadMoreMessagesError = computed<boolean>(() => {
  const sid = rawState.activeSessionId;
  return sid ? (rawState.messagesLoadMoreErrorBySession[sid] ?? false) : false;
});
export const serverVersion = computed<string>(() => rawState.serverVersion);
export const dangerousBypassAuth = computed<boolean>(
  () => rawState.dangerousBypassAuth,
);

/**
 * Drop the cached `dangerous_bypass_auth` value read from `/meta`. Called when
 * the server demands authentication (HTTP 401) so a stale "bypass" value from
 * a previous server mode does not keep hiding the token prompt after the same
 * origin is restarted without `--dangerous-bypass-auth`.
 */
export function clearDangerousBypassAuth(): void {
  rawState.dangerousBypassAuth = false;
}

export const permission = computed<PermissionMode>(() => rawState.permission);
export const thinking = computed<ThinkingLevel | undefined>(() => rawState.thinking);
// Mode toggles reflect the ACTIVE session (or the draft when no session is
// open). Each session keeps its own value in the *BySession maps above.
export const planMode = computed<boolean>(() => {
  const sid = rawState.activeSessionId;
  return sid ? (rawState.planModeBySession[sid] ?? false) : draftModes.planMode;
});
export const swarmMode = computed<boolean>(() => {
  const sid = rawState.activeSessionId;
  return sid
    ? (rawState.swarmModeBySession[sid] ?? false)
    : draftModes.swarmMode;
});
export const goalMode = computed<boolean>(() => {
  const sid = rawState.activeSessionId;
  return sid ? (rawState.goalModeBySession[sid] ?? false) : draftModes.goalMode;
});

export const activationBadges = computed<ActivationBadges>(() => {
  const swarmCounts = countSwarmMembers(swarms.value);
  return {
    plan: planMode.value,
    goal:
      goal.value && goal.value.status !== "complete"
        ? {
            status: goal.value.status,
            turnsUsed: goal.value.turnsUsed,
            elapsedMs: goal.value.wallClockMs,
          }
        : null,
    swarm: swarmCounts.total > 0 ? swarmCounts : null,
  };
});

/** Queued messages for the active session, rendered inline at the tail of the
    transcript. Carries attachment thumbnails (resolved via getFileUrl) so image
    prompts don't render as empty bubbles. */
export const queued = computed<QueuedPromptView[]>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  const api = getKimiWebApi();
  return (rawState.queuedBySession[sid] ?? []).map((q) => ({
    text: q.text,
    attachmentCount: q.attachments?.length ?? 0,
    attachments: q.attachments?.map((a) => ({
      fileId: a.fileId,
      kind: a.kind,
      url: api.getFileUrl(a.fileId),
      name: a.name,
    })),
  }));
});

/** Pending warnings list */
export const warnings = computed<AppWarning[]>(() => rawState.warnings);

/** Active session's pending questions mapped to UIQuestion[] */
export const questions = computed<UIQuestion[]>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  return (rawState.questionsBySession[sid] ?? []).map(toUiQuestion);
});

/**
 * Pending approvals for the active session, rendered as standalone interrupt
 * cards at the end of the transcript (they do NOT need to match a loaded
 * tool_use). This is how the TUI / old web surface approvals.
 */
export const pendingApprovals = computed<
  { approvalId: string; block: ApprovalBlock; agentName?: string }[]
>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return [];
  return (rawState.approvalsBySession[sid] ?? []).map((a) => ({
    approvalId: a.approvalId,
    block: buildApprovalBlock(a),
    agentName: (a as { agentName?: string }).agentName,
  }));
});

/**
 * Activity state for the active session.
 * Priority: awaiting-approval > awaiting-question > running > idle
 *
 * `running` is main-conversation liveness — the same condition as the working
 * moon (the optimistic submit window or an in-flight main turn). The wire
 * `busy` fact deliberately includes background tasks, but everything driven
 * by `activity` (Stop button, composer/page-title spinners, send-vs-queue
 * gating) follows the main conversation only: a session left with only
 * background tasks is idle here, exactly like the retired turn-scoped status.
 */
export const activity = computed<ActivityState>(() => {
  const sid = rawState.activeSessionId;
  if (!sid) return "idle";

  const approvals = rawState.approvalsBySession[sid] ?? [];
  if (approvals.length > 0) return "awaiting-approval";

  const questionList = rawState.questionsBySession[sid] ?? [];
  if (questionList.length > 0) return "awaiting-question";

  if (inFlight.value || turnActive.value) {
    return "running";
  }

  return "idle";
});

const modelProviderInstance = useModelProviderState(rawState, {
  pushOperationFailure,
  refreshSessionStatus,
  persistSessionProfile,
  activity,
  updateSession,
  updateSessionMessages,
});

export function initChatProviders(): void {
  setSideChat(sideChatInstance);
  setTaskPoller(taskPollerInstance);
  setModelProvider(modelProviderInstance);
}

export {
  sideChatInstance,
  modelProviderInstance,
  taskPollerInstance,
};

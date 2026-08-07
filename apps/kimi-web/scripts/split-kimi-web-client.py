#!/usr/bin/env python3
"""Extract useKimiWebClient.ts into capability modules under kimi-web-client/."""
from __future__ import annotations

import os
import re

ROOT = os.path.join(os.path.dirname(__file__), "..")
SRC = os.environ.get(
    "KWC_SOURCE",
    os.path.join(ROOT, "src/composables/useKimiWebClient.ts"),
)
OUT = os.path.join(ROOT, "src/composables/client/kimi-web-client")


def read_lines(path: str) -> list[str]:
    with open(path, encoding="utf-8") as f:
        return f.read().splitlines()


def write_file(path: str, content: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content.rstrip() + "\n")


def dedent_block(lines: list[str], spaces: int = 0) -> str:
    if spaces == 0:
        return "\n".join(lines)
    prefix = " " * spaces
    out: list[str] = []
    for line in lines:
        if line.startswith(prefix):
            out.append(line[spaces:])
        elif line == "":
            out.append("")
        else:
            out.append(line)
    return "\n".join(out)


def extract(lines: list[str], start: int, end: int) -> str:
    return dedent_block(lines[start - 1 : end])


def export_functions(body: str, names: list[str]) -> str:
    for name in names:
        body = re.sub(
            rf"(^|\n)((?:async )?)function {re.escape(name)}\(",
            rf"\1export \2function {name}(",
            body,
            count=1,
        )
    return body


def export_const(body: str, name: str) -> str:
    return re.sub(
        rf"^const {re.escape(name)} =",
        f"export const {name} =",
        body,
        count=1,
        flags=re.MULTILINE,
    )


def strip_duplicate_declarations(body: str, patterns: list[str]) -> str:
    for pat in patterns:
        body = re.sub(pat, "", body, flags=re.MULTILINE)
    return body


IMPORTS: dict[str, str] = {
    "session-mutations.ts": '''import { forgetLocalTurnState } from "../useWorkspaceState";
import { STORAGE_KEYS, loadUnread, saveUnread } from "../../../lib/storage";
import type { AppMessage, AppSession } from "../../../api/types";
import { traceClientEvent, traceKeyEvent } from "../../../debug/trace";
import {
  rawState,
  eventConn,
  epochBySession,
  sessionsRequiringSnapshot,
  sessionsRetryingStaleSnapshot,
  sessionsKnownEmpty,
  enqueueEvent,
} from "./runtime";
import {
  savePlanModeToStorage,
  saveSwarmModeToStorage,
  saveGoalModeToStorage,
} from "./storage-helpers";
import { dropWsSubscription, snapshotSyncRunner } from "./warnings-snapshot";
''',
    "session-refresh.ts": '''import { computed, ref } from "vue";
import { getKimiWebApi } from "../../../api";
import { safeGetString, safeSetString } from "../../../lib/storage";
import type { AppGoal, AppSessionRuntimeStatus, ThinkingLevel } from "../../../api/types";
import {
  rawState,
  ONBOARDED_STORAGE_KEY,
  CONVERSATION_TOC_STORAGE_KEY,
  bumpOptimisticMsgSeq,
} from "./runtime";
import { updateSession } from "./session-mutations";
import { pushOperationFailure } from "./warnings-snapshot";
''',
    "event-reducer.ts": '''import { reduceAppEvent, type KimiClientState } from "../../../api/daemon/eventReducer";
import type { ThinkingLevel } from "../../../api/types";
import { toAppEvent } from "../../../api/daemon/mappers";
import { rawState, modelProvider } from "./runtime";
import {
  setSessions,
  setActiveSessionId,
  setMessagesBySession,
} from "./session-mutations";
''',
    "event-handlers.ts": '''import type { AppEvent, KimiEventMeta } from "../../../api/types";
import { rawState, appearance, sideChat, workspaceState } from "./runtime";
import { applyEvent } from "./event-reducer";
import {
  onMainTurnEnd,
  onQuestionRequested,
  onApprovalRequested,
  clearWorkingFlags,
} from "./turn-notifications";
''',
    "event-connection.ts": '''import { getKimiWebApi } from "../../../api";
import { i18n } from "../../../i18n";
import { traceKeyEvent } from "../../../debug/trace";
import type { AppNoticeDetail } from "../../../api/types";
import {
  coalesceAppRenderEvents,
  createEventBatcher,
  isRenderEvent,
  splitOversizedAppRenderEvent,
  type PendingAppEvent,
} from "../eventBatcher";
import {
  rawState,
  sessionsRequiringSnapshot,
  workspaceState,
  setEventConn,
  enqueueEvent,
} from "./runtime";
import { processEvent } from "./event-handlers";
import {
  pushWarning,
  dismissWsError,
  warningDetail,
  snapshotSyncRunner,
} from "./warnings-snapshot";
''',
    "warnings-snapshot.ts": '''import { i18n } from "../../../i18n";
import { traceKeyEvent } from "../../../debug/trace";
import { getKimiWebApi } from "../../../api";
import { isDaemonApiError, isDaemonNetworkError } from "../../../api/errors";
import { createCoalescedAsyncRunner } from "../../../lib/snapshotSync";
import { mergeSnapshotMessages } from "../../../lib/snapshotMessages";
import { mergeSnapshotSubagents } from "../../../lib/taskMerge";
import { isPlaceholderSessionUsage } from "../../../api/daemon/mappers";
import type {
  AppNotice,
  AppNoticeDetail,
  AppWarning,
} from "../../../api/types";
import {
  rawState,
  eventConn,
  epochBySession,
  sessionsRequiringSnapshot,
  sessionsRetryingStaleSnapshot,
  sessionsKnownEmpty,
  sessionWarningsPulled,
  wsSubscriptionOrder,
  sessionsWithStaleCursor,
  SESSION_NOT_FOUND_CODE,
  GOAL_ERROR_KEYS,
  MAX_WS_SUBSCRIPTIONS,
  workspaceState,
  enqueueEvent,
} from "./runtime";
import {
  forgetSession,
  updateSession,
  setSessionMessages,
  setActiveSessionId,
} from "./session-mutations";
import { refreshSessionStatus } from "./session-refresh";
import { connectEventsIfNeeded } from "./event-connection";
''',
    "view-mappers.ts": '''import { i18n } from "../../../i18n";
import type { AppApprovalRequest, AppQuestionRequest, AppTask } from "../../../api/types";
import type {
  ApprovalBlock,
  DiffLine,
  TaskItem,
  TaskState,
  UIQuestion,
} from "../../../types";
import { rawState, sessionTimeClock, SESSION_TIME_CLOCK_INTERVAL_MS, enqueueEvent } from "./runtime";
''',
    "computed-chat.ts": '''import { computed } from "vue";
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
''',
    "computed-workspace.ts": '''import { computed, ref, watch } from "vue";
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
''',
    "turn-notifications.ts": '''import type { AppApprovalRequest, AppQuestionRequest } from "../../../api/types";
import { shouldNotifyCompletion } from "../useNotification";
import { rawState, notification, sound, workspaceState } from "./runtime";
import { refreshSessionStatus } from "./session-refresh";
import { saveUnread } from "../../../lib/storage";
''',
    "bootstrap.ts": '''import { useWorkspaceState } from "../useWorkspaceState";
import {
  rawState,
  draftModes,
  appearance,
  initialized,
  connectIssue,
  selectedDiffPath,
  fileDiffLines,
  fileDiffLoading,
  sessionsKnownEmpty,
  sideChat,
  modelProvider,
  taskPoller,
  eventConn,
  setWorkspaceState,
} from "./runtime";
import {
  setSessions,
  updateSession,
  upsertSessionFront,
  appendSession,
  forgetSession,
  setActiveSessionId,
  updateSessionMessages,
} from "./session-mutations";
import {
  nextOptimisticMsgId,
  refreshSessionStatus,
  refreshSessionGoal,
  persistSessionProfile,
} from "./session-refresh";
import {
  syncSessionFromSnapshot,
  reopenSession,
  hasLoadedMessages,
  pushOperationFailure,
  goalErrorMessage,
} from "./warnings-snapshot";
import {
  mergedWorkspaces,
  workspacesView,
  status,
  workspaceIdForSession,
} from "./computed-workspace";
import { activity } from "./computed-chat";
import {
  savePermissionToStorage,
  saveActiveWorkspaceToStorage,
  saveHiddenWorkspacesToStorage,
  savePlanModeToStorage,
  saveSwarmModeToStorage,
  saveGoalModeToStorage,
} from "./storage-helpers";
import { saveUnread } from "../../../lib/storage";
''',
}

SPLITS: list[tuple[str, int, int, list[str], list[str]]] = [
    (
        "session-mutations.ts",
        343,
        530,
        [
            "setSessions",
            "updateSession",
            "upsertSessionFront",
            "appendSession",
            "removeSession",
            "clearActiveUnread",
            "recoverStaleConnection",
            "setActiveSessionId",
            "setMessagesBySession",
            "setSessionMessages",
            "updateSessionMessages",
            "removeSessionMessages",
            "forgetSession",
        ],
        [
            r"^const draftModes = reactive[\s\S]*?^\}\);\n",
            r"^const selectedDiffPath = ref[\s\S]*?^const connectIssue = ref[\s\S]*?\);\n",
        ],
    ),
    (
        "session-refresh.ts",
        556,
        723,
        [
            "refreshSessionStatus",
            "refreshSessionGoal",
            "persistSessionProfile",
            "setConversationToc",
            "setOnboarded",
            "nextOptimisticMsgId",
        ],
        [
            r"^const CONVERSATION_TOC_STORAGE_KEY[\s\S]*?^function saveConversationTocToStorage[\s\S]*?\}\n",
            r"^function loadStringFromStorage[\s\S]*?\}\n",
            r"^const onboarded = ref[\s\S]*?^function setOnboarded[\s\S]*?\}\n",
            r"^let eventConn[\s\S]*?\n",
            r"^let optimisticMsgSeq[\s\S]*?\n",
        ],
    ),
    (
        "event-reducer.ts",
        726,
        796,
        ["applyEvent"],
        [],
    ),
    (
        "event-handlers.ts",
        813,
        956,
        ["processEvent"],
        [],
    ),
    (
        "event-connection.ts",
        968,
        1059,
        ["connectEventsIfNeeded"],
        [],
    ),
    (
        "warnings-snapshot.ts",
        1085,
        1601,
        [
            "warningDetail",
            "formatDetailValue",
            "errorName",
            "errorMessage",
            "errorStack",
            "formatTimestamp",
            "formatDuration",
            "errorDetails",
            "operationFailureNotice",
            "pushWarning",
            "dismissWsError",
            "pushOperationFailure",
            "goalErrorMessage",
            "handleSessionNotFound",
            "pullSessionWarnings",
            "syncSessionFromSnapshot",
            "hasLoadedMessages",
            "retainWsSubscription",
            "dropWsSubscription",
            "reopenSession",
            "isSessionNotFoundError",
        ],
        [
            r"^const GOAL_ERROR_KEYS[\s\S]*?^\};\n",
            r"^const epochBySession[\s\S]*?^const sessionsKnownEmpty[\s\S]*?\n",
            r"^type SyncSessionResult[\s\S]*?^\n",
            r"^const MAX_WS_SUBSCRIPTIONS[\s\S]*?^const sessionsWithStaleCursor[\s\S]*?\n",
            r"^const sessionWarningsPulled[\s\S]*?\n",
        ],
    ),
    (
        "view-mappers.ts",
        1614,
        1927,
        [
            "isMainTurnActive",
            "formatTime",
            "ensureSessionTimeClock",
            "stopSessionTimeClock",
            "buildDiffLines",
            "buildApprovalBlock",
            "toUiQuestion",
            "findBashCommandForTask",
            "toUiTask",
        ],
        [
            r"^const SESSION_TIME_CLOCK_INTERVAL_MS[\s\S]*?^let sessionTimeClockTimer[\s\S]*?\n",
            r"^const sessionTimeClock = ref[\s\S]*?\n",
            r"^let sessionTimeClockTimer[\s\S]*?\n",
        ],
    ),
    (
        "computed-workspace.ts",
        2229,
        2664,
        [
            "clearDangerousBypassAuth",
            "reorderWorkspaces",
            "setWorkspaceSortMode",
            "mergedWorkspaces",
            "workspacesView",
            "workspaceIdForSession",
            "status",
        ],
        [],
    ),
    (
        "turn-notifications.ts",
        2725,
        2855,
        [
            "isUserWatching",
            "clearWorkingFlags",
            "onMainTurnEnd",
            "onQuestionRequested",
            "onApprovalRequested",
        ],
        [],
    ),
]

# session-refresh needs conversationToc + onboarded refs kept
SESSION_REFRESH_EXTRA = '''
function loadConversationTocFromStorage(): boolean {
  try {
    const raw = safeGetString(CONVERSATION_TOC_STORAGE_KEY);
    return raw === null ? true : raw === "true";
  } catch {
    return true;
  }
}
function saveConversationTocToStorage(v: boolean): void {
  try {
    safeSetString(CONVERSATION_TOC_STORAGE_KEY, v ? "true" : "false");
  } catch {
    // ignore
  }
}
export const conversationToc = ref<boolean>(loadConversationTocFromStorage());

function loadStringFromStorage(key: string): string {
  try {
    return safeGetString(key) ?? "";
  } catch {
    return "";
  }
}
export const onboarded = ref<boolean>(
  loadStringFromStorage(ONBOARDED_STORAGE_KEY) === "1",
);
'''

# warnings-snapshot needs SyncSessionResult type
WARNINGS_EXTRA = '''
export type SyncSessionResult = "ok" | "not-found" | "failed";
'''

# view-mappers HMR block
VIEW_MAPPERS_EXTRA = '''
let sessionTimeClockTimer: ReturnType<typeof setInterval> | null = null;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    stopSessionTimeClock();
    enqueueEvent.dispose();
  });
}
'''

# event-connection enqueueEvent assignment
EVENT_CONNECTION_EXTRA = '''
import { setEnqueueEvent } from "./runtime";

export function initEnqueueEvent(): void {
  setEnqueueEvent(
    createEventBatcher<PendingAppEvent>(
      ({ appEvent, meta }) => processEvent(appEvent, meta),
      ({ appEvent }) => isRenderEvent(appEvent),
      { coalesce: coalesceAppRenderEvents },
    ),
  );
}
'''

# computed-chat is special - lines 1929-2350
COMPUTED_CHAT_RANGES = (1929, 2228)


def patch_session_refresh(body: str) -> str:
    body = re.sub(
        r"export function nextOptimisticMsgId\(\): string \{[\s\S]*?\}",
        """export function nextOptimisticMsgId(): string {
  const seq = bumpOptimisticMsgSeq();
  return `msg_opt_${Date.now().toString(36)}_${seq}`;
}""",
        body,
        count=1,
    )
    return SESSION_REFRESH_EXTRA + body


def patch_session_mutations(body: str) -> str:
    return body.replace(
        "savePlanModeToStorage();",
        "savePlanModeToStorage(rawState.planModeBySession);",
    ).replace(
        "saveSwarmModeToStorage();",
        "saveSwarmModeToStorage(rawState.swarmModeBySession);",
    ).replace(
        "saveGoalModeToStorage();",
        "saveGoalModeToStorage(rawState.goalModeBySession);",
    )


def patch_warnings(body: str) -> str:
    return body + "\n" + WARNINGS_EXTRA


def patch_event_connection(body: str) -> str:
    body = re.sub(
        r"^const enqueueEvent = createEventBatcher[\s\S]*?\);\n",
        "",
        body,
    )
    body = body.replace(
        "eventConn = api.connectEvents(",
        "setEventConn(api.connectEvents(",
    )
    return body + "\n" + EVENT_CONNECTION_EXTRA


def generate_computed_chat(lines: list[str]) -> str:
    body = extract(lines, *COMPUTED_CHAT_RANGES)
    # Export all const computed = and const sideChat etc.
    for name in [
        "workspace",
        "sessions",
        "activeSessionId",
        "skills",
        "inFlight",
        "isStartingFirstPrompt",
        "activeAppTasks",
        "turns",
        "turnActive",
        "working",
        "tasks",
        "swarms",
        "swarmMembersByToolCallId",
        "goal",
        "todos",
        "compaction",
        "connection",
        "loading",
        "sessionLoading",
        "loadingMoreMessages",
        "hasMoreMessages",
        "loadMoreMessagesError",
        "serverVersion",
        "dangerousBypassAuth",
        "permission",
        "thinking",
        "planMode",
        "swarmMode",
        "goalMode",
        "activationBadges",
        "queued",
        "warnings",
        "questions",
        "pendingApprovals",
        "activity",
    ]:
        body = re.sub(
            rf"^const {re.escape(name)} =",
            f"export const {name} =",
            body,
            count=1,
            flags=re.MULTILINE,
        )
    # sideChat, taskPoller, modelProvider assign to runtime slots
    body = body.replace(
        "const sideChat = useSideChat",
        "const sideChatInstance = useSideChat",
    )
    body = body.replace(
        "const taskPoller = useTaskPoller",
        "const taskPollerInstance = useTaskPoller",
    )
    body = body.replace(
        "const modelProvider = useModelProviderState",
        "const modelProviderInstance = useModelProviderState",
    )
    body = body.replace(
        "return sid ? (modelProvider.skillsBySession",
        "return sid ? (modelProviderInstance.skillsBySession",
    )
    body = body.replace(
        "return wid ? (modelProvider.skillsByWorkspace",
        "return wid ? (modelProviderInstance.skillsByWorkspace",
    )
    body = body.replace(
        "modelProvider.resolveThinkingForPrompt",
        "modelProviderInstance.resolveThinkingForPrompt",
    )
    body += '''

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
'''
    return IMPORTS["computed-chat.ts"] + "\n" + body


def generate_computed_workspace(lines: list[str]) -> str:
    body = extract(lines, 2229, 2664)
    for name in [
        "activeWorkspaceId",
        "visibleWorkspace",
        "sessionsForView",
        "workspaceGroups",
        "attentionBySession",
        "pendingBySession",
        "attentionByWorkspace",
        "unreadBySession",
        "recentRoots",
        "availableOpenInApps",
        "authReady",
        "defaultModel",
        "managedProviderStatus",
        "config",
        "sessionCost",
        "fileDiff",
        "changes",
        "gitInfo",
        "gitDiffStats",
        "activePullRequest",
        "changesByPath",
    ]:
        body = re.sub(
            rf"^const {re.escape(name)} =",
            f"export const {name} =",
            body,
            count=1,
            flags=re.MULTILINE,
        )
    body = export_functions(
        body,
        ["clearDangerousBypassAuth", "reorderWorkspaces", "setWorkspaceSortMode"],
    )
    body = re.sub(
        r"^const mergedWorkspaces =",
        "export const mergedWorkspaces =",
        body,
        count=1,
        flags=re.MULTILINE,
    )
    body = re.sub(
        r"^const workspacesView =",
        "export const workspacesView =",
        body,
        count=1,
        flags=re.MULTILINE,
    )
    body = re.sub(
        r"^function workspaceIdForSession",
        "export function workspaceIdForSession",
        body,
        count=1,
    )
    body = re.sub(
        r"^const status =",
        "export const status =",
        body,
        count=1,
        flags=re.MULTILINE,
    )
    body = re.sub(
        r"^export const workspaceSortMode =",
        "export const workspaceSortMode =",
        body,
        count=1,
        flags=re.MULTILINE,
    )
    body = re.sub(
        r"^const workspaceSortMode =",
        "export const workspaceSortMode =",
        body,
        count=1,
        flags=re.MULTILINE,
    )
    return IMPORTS["computed-workspace.ts"] + "\n" + body


def generate_bootstrap() -> str:
    return IMPORTS["bootstrap.ts"] + '''
export function initWorkspaceState(): void {
  setWorkspaceState(useWorkspaceState(rawState, {
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
    getEventConn: () => eventConn,
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
    savePlanModeToStorage: () =>
      savePlanModeToStorage(rawState.planModeBySession),
    saveSwarmModeToStorage: () =>
      saveSwarmModeToStorage(rawState.swarmModeBySession),
    saveGoalModeToStorage: () =>
      saveGoalModeToStorage(rawState.goalModeBySession),
    draftModes,
    saveUnread,
    saveActiveWorkspaceToStorage,
    saveHiddenWorkspacesToStorage,
    goalErrorMessage,
    resetFastMoon: appearance.resetFastMoon,
    initialized,
    connectIssue,
    selectedDiffPath,
    fileDiffLines,
    fileDiffLoading,
  }));
}
'''


def generate_facade() -> str:
    return '''// apps/kimi-web/src/composables/useKimiWebClient.ts
// Thin facade — capability modules live under ./client/kimi-web-client/.

export type { Accent, ColorScheme } from "./client/useAppearance";
export type {
  ExtendedState,
  PromptAttachment,
} from "./client/kimi-web-client/types";
export type { ApprovalDecision, AppModel, AppProvider } from "../api/types";

import { ensureSessionTimeClock } from "./client/kimi-web-client/view-mappers";
import { initEnqueueEvent } from "./client/kimi-web-client/event-connection";
import { initChatProviders } from "./client/kimi-web-client/computed-chat";
import { initWorkspaceState } from "./client/kimi-web-client/bootstrap";
import {
  sideChat,
  modelProvider,
  workspaceState,
} from "./client/kimi-web-client/runtime";
import {
  workspace,
  sessions,
  activeSessionId,
  turns,
  tasks,
  activeAppTasks,
  todos,
  goal,
  swarms,
  swarmMembersByToolCallId,
  activationBadges,
  compaction,
  connection,
  loading,
  sessionLoading,
  loadingMoreMessages,
  hasMoreMessages,
  loadMoreMessagesError,
  serverVersion,
  dangerousBypassAuth,
  permission,
  thinking,
  planMode,
  swarmMode,
  goalMode,
  queued,
  warnings,
  questions,
  activity,
  turnActive,
  inFlight,
  working,
  isStartingFirstPrompt,
  skills,
} from "./client/kimi-web-client/computed-chat";
import {
  workspacesView,
  visibleWorkspace,
  activeWorkspaceId,
  sessionsForView,
  workspaceGroups,
  attentionBySession,
  pendingBySession,
  attentionByWorkspace,
  unreadBySession,
  recentRoots,
  status,
  sessionCost,
  fileDiff,
  changes,
  gitInfo,
  gitDiffStats,
  activePullRequest,
  changesByPath,
  pendingApprovals,
  availableOpenInApps,
  clearDangerousBypassAuth,
  authReady,
  defaultModel,
  managedProviderStatus,
  config,
  reorderWorkspaces,
  setWorkspaceSortMode,
  workspaceSortMode,
} from "./client/kimi-web-client/computed-workspace";
import {
  conversationToc,
  setConversationToc,
  onboarded,
  setOnboarded,
} from "./client/kimi-web-client/session-refresh";
import { appearance, notification, sound } from "./client/kimi-web-client/runtime";
import {
  selectedDiffPath,
  fileDiffLines,
  fileDiffLoading,
  initialized,
  connectIssue,
} from "./client/kimi-web-client/runtime";

let bootstrapped = false;
function ensureBootstrap(): void {
  if (bootstrapped) return;
  bootstrapped = true;
  initEnqueueEvent();
  initChatProviders();
  initWorkspaceState();
}

export function useKimiWebClient() {
  ensureBootstrap();
  ensureSessionTimeClock();

  return {
    workspace,
    sessions,
    activeSessionId,
    workspacesView,
    workspaceSortMode,
    visibleWorkspace,
    activeWorkspaceId,
    sessionsForView,
    workspaceGroups,
    attentionBySession,
    pendingBySession,
    attentionByWorkspace,
    unreadBySession,
    recentRoots,
    turns,
    tasks,
    activeAppTasks,
    todos,
    goal,
    swarms,
    swarmMembersByToolCallId,
    activationBadges,
    compaction,
    status,
    sessionCost,
    fileDiff,
    selectedDiffPath,
    fileDiffLoading,
    changes,
    gitInfo,
    gitDiffStats,
    activePullRequest,
    changesByPath,
    pendingApprovals,
    availableOpenInApps,
    connection,
    loading,
    sessionLoading,
    loadingMoreMessages,
    hasMoreMessages,
    loadMoreMessagesError,
    serverVersion,
    dangerousBypassAuth,
    clearDangerousBypassAuth,
    initialized,
    connectIssue,
    permission,
    thinking,
    planMode,
    swarmMode,
    goalMode,
    queued,
    warnings,
    questions,
    activity,
    turnActive,
    inFlight,
    working,
    isStartingFirstPrompt,
    fastMoon: appearance.fastMoon,
    models: modelProvider!.models,
    starredModelIds: modelProvider!.starredModelIds,
    providers: modelProvider!.providers,
    uiFontSize: appearance.uiFontSize,
    setUiFontSize: appearance.setUiFontSize,
    conversationToc,
    setConversationToc,
    colorScheme: appearance.colorScheme,
    setColorScheme: appearance.setColorScheme,
    accent: appearance.accent,
    setAccent: appearance.setAccent,
    notifyOnComplete: notification.notifyOnComplete,
    notifyOnQuestion: notification.notifyOnQuestion,
    notifyOnApproval: notification.notifyOnApproval,
    notifyPermission: notification.notifyPermission,
    setNotifyOnComplete: notification.setNotifyOnComplete,
    setNotifyOnQuestion: notification.setNotifyOnQuestion,
    setNotifyOnApproval: notification.setNotifyOnApproval,
    soundOnComplete: sound.soundOnComplete,
    setSoundOnComplete: sound.setSoundOnComplete,
    onboarded,
    setOnboarded,
    load: workspaceState!.load,
    selectSession: workspaceState!.selectSession,
    clearActiveSession: workspaceState!.clearActiveSession,
    loadOlderMessages: workspaceState!.loadOlderMessages,
    loadWorkspaces: workspaceState!.loadWorkspaces,
    loadMoreSessions: workspaceState!.loadMoreSessions,
    loadAllSessions: workspaceState!.loadAllSessions,
    selectWorkspace: workspaceState!.selectWorkspace,
    openWorkspace: workspaceState!.openWorkspace,
    openWorkspaceDraft: workspaceState!.openWorkspaceDraft,
    startSessionAndSendPrompt: workspaceState!.startSessionAndSendPrompt,
    startSessionAndActivateSkill: workspaceState!.startSessionAndActivateSkill,
    startSessionAndOpenSideChat: workspaceState!.startSessionAndOpenSideChat,
    addWorkspaceByPath: workspaceState!.addWorkspaceByPath,
    browseFs: workspaceState!.browseFs,
    getFsHome: workspaceState!.getFsHome,
    sendPrompt: workspaceState!.sendPrompt,
    steerPrompt: workspaceState!.steerPrompt,
    sideChatVisible: sideChat!.sideChatVisible,
    sideChatSessionId: sideChat!.sideChatSessionId,
    sideChatTurns: sideChat!.sideChatTurns,
    sideChatRunning: sideChat!.sideChatRunning,
    sideChatSending: sideChat!.sideChatSending,
    openSideChat: sideChat!.openSideChat,
    closeSideChat: sideChat!.closeSideChat,
    sendSideChatPrompt: sideChat!.sendSideChatPrompt,
    uploadImage: workspaceState!.uploadImage,
    abortCurrentPrompt: workspaceState!.abortCurrentPrompt,
    respondApproval: workspaceState!.respondApproval,
    respondQuestion: workspaceState!.respondQuestion,
    dismissQuestion: workspaceState!.dismissQuestion,
    pendingQuestionActions: workspaceState!.pendingQuestionActions,
    pendingApprovalActions: workspaceState!.pendingApprovalActions,
    cancelTask: workspaceState!.cancelTask,
    setPermission: workspaceState!.setPermission,
    setThinking: modelProvider!.setThinking,
    setPlanMode: workspaceState!.setPlanMode,
    togglePlanMode: workspaceState!.togglePlanMode,
    setSwarmMode: workspaceState!.setSwarmMode,
    toggleSwarmMode: workspaceState!.toggleSwarmMode,
    setGoalMode: workspaceState!.setGoalMode,
    toggleGoalMode: workspaceState!.toggleGoalMode,
    createGoal: workspaceState!.createGoal,
    controlGoal: workspaceState!.controlGoal,
    enqueue: workspaceState!.enqueue,
    dismissWarning: workspaceState!.dismissWarning,
    renameSession: workspaceState!.renameSession,
    renameWorkspace: workspaceState!.renameWorkspace,
    deleteWorkspace: workspaceState!.deleteWorkspace,
    reorderWorkspaces,
    setWorkspaceSortMode,
    archiveSession: workspaceState!.archiveSession,
    exportSession: workspaceState!.exportSession,
    restoreSession: workspaceState!.restoreSession,
    loadArchivedSessions: workspaceState!.loadArchivedSessions,
    compact: workspaceState!.compact,
    forkSession: workspaceState!.forkSession,
    undo: workspaceState!.undo,
    unqueue: workspaceState!.unqueue,
    reorderQueue: workspaceState!.reorderQueue,
    searchFiles: workspaceState!.searchFiles,
    loadGitStatus: workspaceState!.loadGitStatus,
    loadFileDiff: workspaceState!.loadFileDiff,
    clearFileDiff: workspaceState!.clearFileDiff,
    listDir: workspaceState!.listDir,
    readFileContent: workspaceState!.readFileContent,
    getFileDownloadUrl: workspaceState!.getFileDownloadUrl,
    openWorkspaceFile: workspaceState!.openWorkspaceFile,
    openInApp: workspaceState!.openInApp,
    revealWorkspaceFile: workspaceState!.revealWorkspaceFile,
    resolveImageUrl: workspaceState!.resolveImageUrl,
    loadModels: modelProvider!.loadModels,
    loadProviders: modelProvider!.loadProviders,
    skills,
    activateSkill: modelProvider!.activateSkill,
    setModel: modelProvider!.setModel,
    toggleStarModel: modelProvider!.toggleStarModel,
    addProvider: modelProvider!.addProvider,
    deleteProvider: modelProvider!.deleteProvider,
    refreshProvider: modelProvider!.refreshProvider,
    refreshAllProviders: modelProvider!.refreshAllProviders,
    authReady,
    defaultModel,
    managedProviderStatus,
    config,
    updateConfig: workspaceState!.updateConfig,
    checkAuth: workspaceState!.checkAuth,
    startOAuthLogin: modelProvider!.startOAuthLogin,
    pollOAuthLogin: modelProvider!.pollOAuthLogin,
    cancelOAuthLogin: modelProvider!.cancelOAuthLogin,
    logout: workspaceState!.logout,
  };
}
'''


def main() -> None:
    lines = read_lines(SRC)
    for fname, start, end, exports, strip_pats in SPLITS:
        body = extract(lines, start, end)
        for pat in strip_pats:
            body = re.sub(pat, "", body, flags=re.MULTILINE)
        body = export_functions(body, exports)
        if fname == "session-refresh.ts":
            body = patch_session_refresh(body)
        if fname == "session-mutations.ts":
            body = patch_session_mutations(body)
        if fname == "warnings-snapshot.ts":
            body = patch_warnings(body)
            body = export_const(body, "snapshotSyncRunner")
        if fname == "event-connection.ts":
            body = patch_event_connection(body)
        if fname == "view-mappers.ts":
            body += "\n" + VIEW_MAPPERS_EXTRA
        content = IMPORTS[fname] + "\n" + body
        write_file(os.path.join(OUT, fname), content)
        print(f"wrote {fname}")

    write_file(os.path.join(OUT, "computed-chat.ts"), generate_computed_chat(lines))
    print("wrote computed-chat.ts")
    write_file(
        os.path.join(OUT, "computed-workspace.ts"), generate_computed_workspace(lines)
    )
    print("wrote computed-workspace.ts")
    write_file(os.path.join(OUT, "bootstrap.ts"), generate_bootstrap())
    print("wrote bootstrap.ts")
    write_file(os.path.join(ROOT, "src/composables/useKimiWebClient.ts"), generate_facade())
    print("wrote facade useKimiWebClient.ts")


if __name__ == "__main__":
    main()

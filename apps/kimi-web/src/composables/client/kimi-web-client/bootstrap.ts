import { useWorkspaceState } from "../useWorkspaceState";
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

export function initWorkspaceState(): void {
  setWorkspaceState(useWorkspaceState(rawState, {
    taskPoller: taskPoller!,
    sideChat: sideChat!,
    modelProvider: modelProvider!,
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

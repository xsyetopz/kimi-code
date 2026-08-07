import type { ComputedRef, Ref } from "vue";
import type {
  AppMessage,
  AppSession,
  AppWorkspace,
  KimiEventConnection,
} from "../../../api/types";
import type {
  ActivityState,
  ConversationStatus,
  DiffViewLine,
  PermissionMode,
  WorkspaceView,
} from "../../../types";
import type { UseModelProviderState } from "../useModelProviderState";
import type { UseSideChat } from "../useSideChat";
import type { UseTaskPoller } from "../useTaskPoller";

export interface PersistSessionProfilePatch {
model?: string;
permissionMode?: string;
planMode?: boolean;
swarmMode?: boolean;
goalObjective?: string;
goalControl?: "pause" | "resume" | "cancel";
thinking?: string;
}

export interface UseWorkspaceStateDeps {
taskPoller: UseTaskPoller;
sideChat: UseSideChat;
modelProvider: UseModelProviderState;
pushOperationFailure: (
  operation: string,
  err: unknown,
  opts?: { title?: string; message?: string; sessionId?: string },
) => void;
activity: ComputedRef<ActivityState>;
sessionsKnownEmpty: Set<string>;
// rawState.sessions mutation funnel, owned by the facade. This module never
// assigns rawState.sessions directly — it goes through these.
setSessions: (next: AppSession[]) => void;
updateSession: (
  id: string,
  update: (session: AppSession) => AppSession,
) => void;
upsertSessionFront: (session: AppSession) => void;
appendSession: (session: AppSession) => void;
forgetSession: (id: string) => void;
setActiveSessionId: (id: string | undefined) => void;
/** Update one session's message list via a function of the current list. */
updateSessionMessages: (
  sessionId: string,
  update: (messages: AppMessage[]) => AppMessage[],
) => void;
nextOptimisticMsgId: () => string;
getEventConn: () => KimiEventConnection | null;
syncSessionFromSnapshot: (sessionId: string) => Promise<SyncSessionResult>;
reopenSession: (sessionId: string) => Promise<SyncSessionResult>;
hasLoadedMessages: (sessionId: string) => boolean;
refreshSessionStatus: (sessionId: string) => Promise<void>;
refreshSessionGoal: (sessionId: string) => Promise<void>;
/** Persist profile fields to the daemon. Resolves false (after surfacing the
 *  failure itself) when the daemon rejected the patch — awaited callers that
 *  order strictly after the profile must NOT proceed on false. */
persistSessionProfile: (
  patch: PersistSessionProfilePatch,
  sessionId?: string,
) => Promise<boolean>;
mergedWorkspaces: ComputedRef<AppWorkspace[]>;
/** Sidebar-facing workspaces in the user's (dragged) display order. */
workspacesView: ComputedRef<WorkspaceView[]>;
status: ComputedRef<ConversationStatus>;
workspaceIdForSession: (s: { workspaceId?: string; cwd: string }) => string;
savePermissionToStorage: (mode: PermissionMode) => void;
/** Persist the current per-session mode maps (read off rawState). */
savePlanModeToStorage: () => void;
saveSwarmModeToStorage: () => void;
saveGoalModeToStorage: () => void;
/** Staged mode toggles for the not-yet-created draft session. */
draftModes: { planMode: boolean; swarmMode: boolean; goalMode: boolean };
saveUnread: (changes: Record<string, boolean>) => void;
saveActiveWorkspaceToStorage: (id: string) => void;
saveHiddenWorkspacesToStorage: (roots: string[]) => void;
goalErrorMessage: (err: unknown) => string | undefined;
resetFastMoon: () => void;
initialized: Ref<boolean>;
/** Diagnostic for the connecting splash, set by checkAuth on transient
 *  failures and cleared once a check gets through. */
connectIssue: Ref<string | null>;
selectedDiffPath: Ref<string | null>;
fileDiffLines: Ref<DiffViewLine[]>;
fileDiffLoading: Ref<boolean>;
}
export type SyncSessionResult = "ok" | "not-found" | "failed";

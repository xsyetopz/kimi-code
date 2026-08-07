// Shared module-level runtime for kimi-web-client capability modules.
import { reactive, ref } from "vue";
import { createInitialState } from "../../../api/daemon/eventReducer";
import { loadUnread, safeRemove, STORAGE_KEYS } from "../../../lib/storage";
import { useAppearance } from "../useAppearance";
import { useNotification } from "../useNotification";
import { useSoundNotification } from "../useSoundNotification";
import type { KimiEventConnection } from "../../../api/types";
import type { ConnectionState, DiffViewLine } from "../../../types";
import type { ExtendedState } from "./types";
import type { UseModelProviderState } from "../useModelProviderState";
import type { UseSideChat } from "../useSideChat";
import type { UseTaskPoller } from "../useTaskPoller";
import type { UseWorkspaceState } from "../useWorkspaceState";
import type { PendingAppEvent } from "../eventBatcher";
import type { createEventBatcher } from "../eventBatcher";
import {
  loadActiveWorkspaceFromStorage,
  loadHiddenWorkspacesFromStorage,
  loadModeMapFromStorage,
  loadPermissionFromStorage,
  PLAN_MODE_STORAGE_KEY,
  SWARM_MODE_STORAGE_KEY,
  GOAL_MODE_STORAGE_KEY,
} from "./storage-helpers";

safeRemove(STORAGE_KEYS.codeFont);
safeRemove(STORAGE_KEYS.theme);
safeRemove(STORAGE_KEYS.thinking);

export const SESSION_NOT_FOUND_CODE = 40401;
export const ONBOARDED_STORAGE_KEY = STORAGE_KEYS.onboarded;
export const CONVERSATION_TOC_STORAGE_KEY = STORAGE_KEYS.conversationToc;
export const SESSION_TIME_CLOCK_INTERVAL_MS = 30_000;
export const MAX_WS_SUBSCRIPTIONS = 4;

export const GOAL_ERROR_KEYS: Record<number, string> = {
  40913: "warnings.goal.alreadyExists",
  40914: "warnings.goal.notFound",
  40915: "warnings.goal.statusInvalid",
  40916: "warnings.goal.notResumable",
  40918: "warnings.goal.objectiveTooLong",
};

export const appearance = useAppearance();
export const notification = useNotification();
export const sound = useSoundNotification();

export const rawState: ExtendedState = reactive({
  ...createInitialState(),
  connected: false,
  serverVersion: "",
  dangerousBypassAuth: false,
  workspaceName: "kimi-web",
  connection: "disconnected" as ConnectionState,
  permission: loadPermissionFromStorage(),
  thinking: undefined,
  thinkingBySession: {},
  planModeBySession: loadModeMapFromStorage(PLAN_MODE_STORAGE_KEY),
  swarmModeBySession: loadModeMapFromStorage(SWARM_MODE_STORAGE_KEY),
  goalModeBySession: loadModeMapFromStorage(GOAL_MODE_STORAGE_KEY),
  loading: false,
  sessionLoading: false,
  queuedBySession: {},
  gitStatusBySession: {},
  promptIdBySession: {},
  inFlightBySession: {},
  unreadBySession: loadUnread(),
  authReady: false,
  defaultModel: null,
  managedProviderStatus: null,
  workspaces: [],
  activeWorkspaceId: loadActiveWorkspaceFromStorage(),
  fsHome: null,
  recentRoots: [],
  hiddenWorkspaceRoots: loadHiddenWorkspacesFromStorage(),
  availableOpenInApps: [],
  config: null,
  sideChatMessagesByAgent: {},
  sideChatSendingByAgent: {},
  sideChatUserMessageIdsBySession: {},
  messagesLoadingMoreBySession: {},
  messagesHasMoreBySession: {},
  messagesLoadMoreErrorBySession: {},
  sessionsHasMoreByWorkspace: {},
  sessionsLoadingMoreByWorkspace: {},
  sessionsCursorByWorkspace: {},
  sessionsInitialCountByWorkspace: {},
  sessionsFullyLoaded: false,
});

export const draftModes = reactive<{
  planMode: boolean;
  swarmMode: boolean;
  goalMode: boolean;
}>({
  planMode: false,
  swarmMode: false,
  goalMode: false,
});

export const selectedDiffPath = ref<string | null>(null);
export const fileDiffLines = ref<DiffViewLine[]>([]);
export const fileDiffLoading = ref(false);
export const initialized = ref(false);
export const connectIssue = ref<string | null>(null);
export let eventConn: KimiEventConnection | null = null;
export let optimisticMsgSeq = 0;

export const epochBySession: Record<string, string> = {};
export const sessionsRequiringSnapshot = new Set<string>();
export const sessionsRetryingStaleSnapshot = new Set<string>();
export const sessionsKnownEmpty = new Set<string>();
export const sessionWarningsPulled = new Set<string>();
export const wsSubscriptionOrder: string[] = [];
export const sessionsWithStaleCursor = new Set<string>();

export const sessionTimeClock = ref(0);
export let sessionTimeClockTimer: ReturnType<typeof setInterval> | null = null;

export function setEventConn(conn: KimiEventConnection | null): void {
  eventConn = conn;
}

export function bumpOptimisticMsgSeq(): number {
  optimisticMsgSeq += 1;
  return optimisticMsgSeq;
}

export let sideChat: UseSideChat | null = null;
export let modelProvider: UseModelProviderState | null = null;
export let taskPoller: UseTaskPoller | null = null;
export let workspaceState: UseWorkspaceState | null = null;

export function setSideChat(next: UseSideChat): void {
  sideChat = next;
}
export function setModelProvider(next: UseModelProviderState): void {
  modelProvider = next;
}
export function setTaskPoller(next: UseTaskPoller): void {
  taskPoller = next;
}
export function setWorkspaceState(next: UseWorkspaceState): void {
  workspaceState = next;
}

type EventBatcher = ReturnType<typeof createEventBatcher<PendingAppEvent>>;
let enqueueEventRef: EventBatcher | undefined;

export function setEnqueueEvent(batcher: EventBatcher): void {
  enqueueEventRef = batcher;
}

function requireEnqueueEvent(): EventBatcher {
  if (!enqueueEventRef) {
    throw new Error("enqueueEvent not initialized — call initEnqueueEvent() first");
  }
  return enqueueEventRef;
}

/** Delegates to the batcher assigned by initEnqueueEvent(). */
export const enqueueEvent = new Proxy({} as EventBatcher, {
  get(_target, prop) {
    const batcher = requireEnqueueEvent();
    const value = batcher[prop as keyof EventBatcher];
    return typeof value === "function"
      ? (value as (...args: unknown[]) => unknown).bind(batcher)
      : value;
  },
});

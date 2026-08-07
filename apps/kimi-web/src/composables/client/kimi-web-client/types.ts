import type {
  AppConfig,
  AppMessage,
  AppWorkspace,
  ThinkingLevel,
} from "../../../api/types";
import type { KimiClientState } from "../../../api/daemon/eventReducer";
import type { ConnectionState, PermissionMode } from "../../../types";

interface GitStatusEntry {
  branch: string;
  ahead: number;
  behind: number;
  entries: Record<string, string>;
  additions: number;
  deletions: number;
  pullRequest: { number: number; state: string; url: string } | null;
}

/** An uploaded attachment to send with a prompt. */
export type PromptAttachment = {
  fileId: string;
  kind: "image" | "video" | "file";
  name?: string;
  mediaType?: string;
  size?: number;
};

/** A prompt waiting for the session to go idle. */
interface QueuedPrompt {
  text: string;
  attachments?: PromptAttachment[];
  id?: string;
}

export interface ExtendedState extends KimiClientState {
  connected: boolean;
  serverVersion: string;
  dangerousBypassAuth: boolean;
  workspaceName: string;
  connection: ConnectionState;
  permission: PermissionMode;
  thinking: ThinkingLevel | undefined;
  thinkingBySession: Record<string, ThinkingLevel>;
  planModeBySession: Record<string, boolean>;
  swarmModeBySession: Record<string, boolean>;
  goalModeBySession: Record<string, boolean>;
  loading: boolean;
  sessionLoading: boolean;
  queuedBySession: Record<string, QueuedPrompt[]>;
  gitStatusBySession: Record<string, GitStatusEntry>;
  promptIdBySession: Record<string, string>;
  inFlightBySession: Record<string, boolean>;
  unreadBySession: Record<string, boolean>;
  authReady: boolean;
  defaultModel: string | null;
  managedProviderStatus: string | null;
  workspaces: AppWorkspace[];
  activeWorkspaceId: string | null;
  fsHome: string | null;
  recentRoots: string[];
  hiddenWorkspaceRoots: string[];
  availableOpenInApps: string[];
  config: AppConfig | null;
  sideChatMessagesByAgent: Record<string, AppMessage[]>;
  sideChatSendingByAgent: Record<string, boolean>;
  sideChatUserMessageIdsBySession: Record<string, string[]>;
  messagesLoadingMoreBySession: Record<string, boolean>;
  messagesHasMoreBySession: Record<string, boolean>;
  messagesLoadMoreErrorBySession: Record<string, boolean>;
  sessionsHasMoreByWorkspace: Record<string, boolean>;
  sessionsLoadingMoreByWorkspace: Record<string, boolean>;
  sessionsCursorByWorkspace: Record<string, string | undefined>;
  sessionsInitialCountByWorkspace: Record<string, number>;
  sessionsFullyLoaded: boolean;
}

import type {
  GoalChange,
  GoalSnapshot,
  ModelAlias,
  PermissionMode,
  ProviderConfig,
  PromptPart,
  ThinkingEffort,
  ToolInputDisplay,
} from "@moonshot-ai/kimi-code-sdk";

import type {
  NotificationsConfig,
  StatusLineConfig,
  UpgradePreferences,
} from "./config";
import type { PendingApproval, PendingQuestion } from "./reverse-rpc/types";
import type { ColorToken, ThemeName } from "./theme";
import type { AgentGroupViewState } from "#/tui/projections/tool-call/agent-group";
import type { ReadGroupViewState } from "#/tui/projections/tool-call/read-group";

export type BannerDisplay = "always" | "once" | "cooldown";

export interface BannerState {
  key: string;
  tag: string | null;
  mainText: string;
  subText: string | null;
  display: BannerDisplay;
  ttlHours?: number;
}

export interface AppState {
  model: string;
  workDir: string;
  additionalDirs: readonly string[];
  sessionId: string;
  permissionMode: PermissionMode;
  planMode: boolean;
  /** Resolved profile name from --agent/--agent-file, carried to the
   * lazy-created first session when the TUI starts session-less. */
  agentProfile?: string;
  /** Raw --agent-file paths, passed to session creation alongside `agentProfile`. */
  agentFiles?: readonly string[];
  /** 'bash' when the editor is in `!` shell-command mode. */
  inputMode: "prompt" | "bash";
  swarmMode: boolean;
  /** Live thinking effort of the active session (e.g. 'off', 'on', 'high');
   * mirrors the runtime. The single source of truth for the thinking state in
   * the TUI. */
  thinkingEffort: ThinkingEffort;
  /**
   * The current `defaultPlanMode` value from config (false when absent),
   * refreshed by `hydrateLazyConfigDefaults`. Used to tell a config-driven
   * plan-mode entry apart from an explicit CLI `--plan` when lazy-creating
   * the first session (the engine applies the config default itself).
   */
  configDefaultPlanMode?: boolean;
  /**
   * Session-only thinking effort chosen (e.g. via the model picker's Alt+S)
   * while no session exists yet on the v2 engine. Applied to the first
   * lazy-created session and cleared once it exists; the engine's config
   * default is used instead when unset.
   */
  lazySessionThinking?: ThinkingEffort;
  contextUsage: number;
  contextTokens: number;
  maxContextTokens: number;
  isCompacting: boolean;
  isReplaying: boolean;
  streamingPhase: "idle" | "waiting" | "thinking" | "composing" | "shell";
  streamingStartTime: number;
  theme: ThemeName;
  version: string;
  editorCommand: string | null;
  /** Mirrors the TUI config toggle; defaults to false when absent from older fixtures. */
  disablePasteBurst?: boolean;
  notifications: NotificationsConfig;
  upgrade: UpgradePreferences;
  /** Footer status line customization from tui.toml; absent means the default layout. */
  statusLine?: StatusLineConfig;
  availableModels: Record<string, ModelAlias>;
  availableProviders: Record<string, ProviderConfig>;
  sessionTitle: string | null;
  /** Current goal snapshot for the footer badge; null/undefined when no active goal. */
  goal?: GoalSnapshot | null;
  mcpServersSummary: string | null;
  /** Optional banner shown below the welcome panel; null means no banner to render. */
  banner?: BannerState | null;
}

export interface ToolCallBlockData {
  id: string;
  name: string;
  args: Record<string, unknown>;
  description?: string;
  display?: ToolInputDisplay;
  streamingArguments?: string;
  streamingStartedAtMs?: number;
  result?: ToolResultBlockData;
  subagent?: SubagentReplayBlockData;
  /** Live Agent subagent card projection for Ink (mirrored from ToolCallComponent). */
  subagentCard?: SubagentCardViewState;
  /** Live AgentSwarm grid projection for Ink (mirrored from AgentSwarmProgressComponent). */
  agentSwarmProgress?: AgentSwarmProgressViewState;
  step?: number;
  turnId?: string;
  /** Set when the step ended (e.g. max_tokens) before the tool call's
   *  arguments finished streaming. Renderer flips the header verb to
   *  "Truncated" and stops showing the in-progress argument preview. */
  truncated?: boolean;
}

export interface ToolResultBlockData {
  tool_call_id: string;
  output: string;
  is_error?: boolean;
  synthetic?: boolean;
}

export interface SubagentReplayToolCallData {
  id: string;
  name: string;
  args: Record<string, unknown>;
  description?: string;
  result?: ToolResultBlockData;
}

export interface SubagentReplayBlockData {
  id: string;
  name?: string;
  text?: string;
  toolCalls?: readonly SubagentReplayToolCallData[];
}

export type SubagentPhase =
  | "queued"
  | "spawning"
  | "running"
  | "done"
  | "failed"
  | "backgrounded";

export interface SubagentToolActivityView {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly phase: "ongoing" | "done" | "failed";
  readonly output?: string;
}

/** Serializable Agent subagent card state for Ink and replay projection. */
export interface SubagentCardViewState {
  readonly phase: SubagentPhase | undefined;
  readonly agentName?: string;
  readonly model?: string;
  readonly spinnerFrame: number;
  readonly toolActivities: readonly SubagentToolActivityView[];
  readonly subagentText: string;
  readonly subagentThinkingText: string;
  readonly lastStreamKind: "text" | "thinking";
  readonly subagentError?: string;
  readonly contextTokens?: number;
  readonly usageTokens?: number;
  readonly elapsedSeconds?: number;
  readonly detachedFromForeground: boolean;
  readonly backgroundTerminalPhase?: "done" | "failed";
}

export type AgentSwarmMemberPhase =
  | "pending"
  | "queued"
  | "suspended"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentSwarmMemberViewState {
  readonly id: string;
  readonly agentId?: string;
  readonly phase: AgentSwarmMemberPhase;
  readonly ticks: number;
  readonly itemText: string;
  readonly latestModelText: string;
  readonly completedText?: string;
  readonly failureText?: string;
  readonly cancelledLabelText?: string;
  readonly suspendedReason?: string;
}

/** Serializable AgentSwarm grid state for Ink and replay projection. */
export interface AgentSwarmProgressViewState {
  readonly description: string;
  readonly modelDisplay: string;
  readonly promptTemplateText: string;
  readonly inputComplete: boolean;
  readonly failed: boolean;
  readonly aborted: boolean;
  readonly itemsStarted: boolean;
  readonly toolCallActive: boolean;
  readonly activitySpinnerText: string;
  readonly members: readonly AgentSwarmMemberViewState[];
}

export interface BackgroundAgentMetadata {
  readonly agentId: string;
  readonly parentToolCallId: string;
  readonly agentName?: string;
  readonly description?: string;
}

export type BackgroundAgentStatusPhase = "started" | "completed" | "failed";

export interface BackgroundAgentStatusData {
  readonly phase: BackgroundAgentStatusPhase;
  readonly headline: string;
  readonly detail?: string;
}

export type CompactionPhase = "running" | "done" | "cancelled";

export interface CompactionTranscriptData {
  readonly phase?: CompactionPhase;
  readonly result?: "cancelled";
  readonly summary?: string;
  readonly tokensBefore?: number;
  readonly tokensAfter?: number;
  readonly instruction?: string;
  readonly tip?: string;
  readonly expanded?: boolean;
  readonly blinkOn?: boolean;
}

export type ShellRunPhase = "running" | "finished" | "backgrounded";

export interface ShellRunViewState {
  readonly phase: ShellRunPhase;
  readonly startedAtMs: number;
  readonly combinedOutput: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly isError?: boolean;
}

export interface CronTranscriptData {
  readonly jobId?: string;
  readonly cron?: string;
  readonly recurring?: boolean;
  readonly coalescedCount?: number;
  readonly stale?: boolean;
  readonly missedCount?: number;
}

export type GoalTranscriptData =
  | { readonly kind: "created" }
  | { readonly kind: "lifecycle"; readonly change: GoalChange };

export type TranscriptEntryKind =
  | "welcome"
  | "user"
  | "assistant"
  | "tool_call"
  | "thinking"
  | "status"
  | "skill_activation"
  | "plugin_command"
  | "cron"
  | "goal";

export type SkillActivationTrigger =
  | "user-slash"
  | "model-tool"
  | "nested-skill";

export interface PluginCommandTranscriptData {
  readonly activationId: string;
  readonly pluginId: string;
  readonly commandName: string;
  readonly args?: string;
  readonly trigger: "user-slash";
}

export interface TranscriptEntry {
  id: string;
  kind: TranscriptEntryKind;
  turnId?: string;
  renderMode: "markdown" | "plain" | "notice";
  content: string;
  /**
   * True only for entries holding real model-authored text (created by the
   * assistant stream). Derived cards — hook results, goal completions, goal
   * reminders — share kind 'assistant' but are not replies, so /copy must
   * skip them.
   */
  modelText?: boolean;
  color?: ColorToken;
  detail?: string;
  /** Optional override for the leading bullet of a 'user' message entry. An empty string suppresses the bullet entirely (used by shell-command echoes so `$` replaces the sparkles marker). */
  bullet?: string;
  toolCallData?: ToolCallBlockData;
  agentGroupData?: AgentGroupViewState;
  readGroupData?: ReadGroupViewState;
  backgroundAgentStatus?: BackgroundAgentStatusData;
  compactionData?: CompactionTranscriptData;
  shellRunData?: ShellRunViewState;
  cronData?: CronTranscriptData;
  goalData?: GoalTranscriptData;
  imageAttachmentIds?: readonly number[];
  skillActivationId?: string;
  skillName?: string;
  skillArgs?: string;
  skillTrigger?: SkillActivationTrigger;
  pluginCommandData?: PluginCommandTranscriptData;
}

export type LivePaneMode = "idle" | "waiting" | "thinking" | "tool" | "session";

export interface LivePaneState {
  mode: LivePaneMode;
  pendingApproval: PendingApproval | null;
  pendingQuestion: PendingQuestion | null;
}

export interface QueuedMessage {
  readonly text: string;
  readonly agentId?: string;
  readonly parts?: readonly PromptPart[];
  readonly imageAttachmentIds?: readonly number[];
  /** `bash` for a `!` shell command queued while another command is running;
   *  undefined (=`prompt`) for a normal message. */
  readonly mode?: "prompt" | "bash";
}

/**
 * One unit of Ctrl-S steer input: a queued message or the editor draft,
 * with the media parts extracted at submit/paste time so images and video
 * tags survive the steer path (which accepts full prompt parts, not just
 * text).
 */
export interface SteerInputItem {
  readonly text: string;
  readonly parts?: readonly PromptPart[];
  readonly imageAttachmentIds?: readonly number[];
}

export const INITIAL_LIVE_PANE: LivePaneState = {
  mode: "idle",
  pendingApproval: null,
  pendingQuestion: null,
};

// ---------------------------------------------------------------------------
// TUI startup / options types (extracted from kimi-tui.ts)
// ---------------------------------------------------------------------------

export interface TUIStartupOptions {
  readonly sessionFlag?: string;
  readonly continueLast: boolean;
  readonly yolo: boolean;
  readonly auto: boolean;
  readonly plan: boolean;
  readonly model?: string;
  /** Resolved profile name from --agent/--agent-file; bound to the startup session only. */
  readonly agentProfile?: string;
  /** Raw --agent-file paths, passed to session creation alongside `agentProfile`. */
  readonly agentFiles?: readonly string[];
  readonly startupNotice?: string;
}

export type TUIStartupState = "pending" | "ready" | "picker";

export interface KimiTUIOptions {
  initialAppState: AppState;
  startup: TUIStartupOptions;
}

export interface PendingExit {
  readonly kind: "ctrl-c" | "ctrl-d";
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface LoginProgressSpinnerHandle {
  stop(opts: { ok: boolean; label: string }): void;
  setLabel(label: string): void;
}

export type ProgressSpinnerHandle = LoginProgressSpinnerHandle;

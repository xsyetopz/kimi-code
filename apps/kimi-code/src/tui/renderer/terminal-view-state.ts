import type { PendingApproval, PendingQuestion } from "../reverse-rpc/types";
import type {
  AppState,
  LivePaneState,
  QueuedMessage,
  TranscriptEntry,
  TUIStartupState,
} from "../types";

const SLASH_INPUT_PATTERN = /^\/(?<prefix>[^\s]*)$/u;

/** Modes understood by terminal renderers, independent of the widget toolkit. */
export type TerminalActivityMode =
  | "hidden"
  | "idle"
  | "session"
  | "waiting"
  | "thinking"
  | "composing"
  | "tool";

/** The app fields needed by a terminal renderer, without runtime UI objects. */
export interface TerminalAppView {
  readonly model: string;
  readonly workDir: string;
  readonly additionalDirs: readonly string[];
  readonly sessionId: string;
  readonly sessionTitle: string | null;
  readonly permissionMode: AppState["permissionMode"];
  readonly planMode: boolean;
  readonly agentProfile: string | undefined;
  readonly agentFiles: readonly string[] | undefined;
  readonly inputMode: AppState["inputMode"];
  readonly swarmMode: boolean;
  readonly thinkingEffort: AppState["thinkingEffort"];
  readonly contextUsage: number;
  readonly contextTokens: number;
  readonly maxContextTokens: number;
  readonly isCompacting: boolean;
  readonly isReplaying: boolean;
  readonly streamingPhase: AppState["streamingPhase"];
  readonly theme: AppState["theme"];
  readonly version: string;
  readonly editorCommand: string | null;
  readonly disablePasteBurst: boolean | undefined;
  readonly notifications: AppState["notifications"];
  readonly upgrade: AppState["upgrade"];
  readonly statusLine: AppState["statusLine"];
  readonly goal: AppState["goal"];
  readonly mcpServersSummary: string | null;
  readonly banner: AppState["banner"];
}

export interface TerminalActivityView {
  readonly mode: TerminalActivityMode;
  readonly tip: string | undefined;
}

export interface TerminalQueueView {
  readonly messages: readonly QueuedMessage[];
  readonly isCompacting: boolean;
  readonly isStreaming: boolean;
  readonly canSteerImmediately: boolean;
}

/** Editor data needed by React to render and keep the input surface in sync. */
export interface TerminalEditorView {
  readonly text: string;
  readonly cursorLine: number;
  readonly cursorColumn: number;
  readonly inputMode: "prompt" | "bash";
  readonly autocomplete: readonly string[];
}

export interface TerminalSessionView {
  readonly id: string;
  readonly title: string | null;
  readonly lastPrompt: string | null;
  readonly workDir: string;
  readonly updatedAt: number;
}

export interface TerminalHelpCommandView {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
}

export interface TerminalTrustPromptView {
  readonly workDir: string;
  readonly gatedMcpServers: readonly string[];
}

export interface TerminalDialogView {
  readonly active: "session-picker" | "help" | "trust-prompt" | null;
  readonly pendingApproval: PendingApproval | null;
  readonly pendingQuestion: PendingQuestion | null;
  readonly sessions: readonly TerminalSessionView[];
  readonly loadingSessions: boolean;
  readonly sessionsScope: "cwd" | "all";
  readonly helpCommands: readonly TerminalHelpCommandView[];
  readonly trustPrompt: TerminalTrustPromptView | null;
  readonly selectedIndex: number;
  /** Scroll offset for renderer-owned long-form dialogs such as `/help`. */
  readonly scrollTop: number;
}

/**
 * Renderer-neutral terminal state. It contains data and derived visibility
 * only; no kimi-tui, Ink, terminal, or session methods cross this boundary.
 */
export interface TerminalViewState {
  readonly app: TerminalAppView;
  readonly startup: TUIStartupState;
  readonly transcript: readonly TranscriptEntry[];
  readonly livePane: Readonly<LivePaneState>;
  readonly activity: TerminalActivityView;
  readonly queue: TerminalQueueView;
  readonly editor: TerminalEditorView;
  readonly dialog: TerminalDialogView;
  readonly toolOutputExpanded: boolean;
  readonly externalEditorRunning: boolean;
  readonly queuedMessageDispatchPending: boolean;
  readonly swarmModeEntry: "manual" | "task" | undefined;
}

/** Fields read from the current coordinator; runtime UI objects are excluded. */
export interface TerminalViewSource {
  readonly appState: AppState;
  readonly startupState: TUIStartupState;
  readonly transcriptEntries: readonly TranscriptEntry[];
  readonly livePane: LivePaneState;
  readonly queuedMessages: readonly QueuedMessage[];
  readonly editor?: Omit<TerminalEditorView, "autocomplete"> & {
    readonly autocomplete?: readonly string[];
  };
  readonly activeDialog: TerminalDialogView["active"];
  readonly dialogSelectedIndex?: number;
  readonly sessions?: readonly TerminalSessionView[];
  readonly loadingSessions?: boolean;
  readonly sessionsScope?: "cwd" | "all";
  readonly helpCommands?: readonly TerminalHelpCommandView[];
  readonly trustPrompt?: TerminalTrustPromptView | null;
  readonly dialogScrollTop?: number;
  readonly toolOutputExpanded: boolean;
  readonly externalEditorRunning: boolean;
  readonly queuedMessageDispatchPending: boolean;
  readonly swarmModeEntry: "manual" | "task" | undefined;
  readonly deferUserMessages: boolean;
  readonly activityTip: string | undefined;
}

/**
 * Resolve activity visibility exactly once for every renderer. The existing
 * kimi-tui renderer and the future Ink renderer therefore share the same rules.
 */
export function resolveTerminalActivityMode(
  source: Pick<TerminalViewSource, "appState" | "activeDialog" | "livePane">,
): TerminalActivityMode {
  if (source.activeDialog === "session-picker") return "hidden";
  if (source.livePane.pendingApproval !== null) return "hidden";
  if (source.appState.isCompacting) return "hidden";
  if (source.livePane.pendingQuestion !== null) return "hidden";

  const streamingPhase = source.appState.streamingPhase;
  if (streamingPhase === "shell") return "waiting";
  if (
    source.livePane.mode === "idle" &&
    (streamingPhase === "thinking" || streamingPhase === "composing")
  ) {
    return streamingPhase;
  }
  return source.livePane.mode;
}

function projectAppState(appState: AppState): TerminalAppView {
  return {
    model: appState.model,
    workDir: appState.workDir,
    additionalDirs: [...appState.additionalDirs],
    sessionId: appState.sessionId,
    sessionTitle: appState.sessionTitle,
    permissionMode: appState.permissionMode,
    planMode: appState.planMode,
    agentProfile: appState.agentProfile,
    agentFiles:
      appState.agentFiles === undefined ? undefined : [...appState.agentFiles],
    inputMode: appState.inputMode,
    swarmMode: appState.swarmMode,
    thinkingEffort: appState.thinkingEffort,
    contextUsage: appState.contextUsage,
    contextTokens: appState.contextTokens,
    maxContextTokens: appState.maxContextTokens,
    isCompacting: appState.isCompacting,
    isReplaying: appState.isReplaying,
    streamingPhase: appState.streamingPhase,
    theme: appState.theme,
    version: appState.version,
    editorCommand: appState.editorCommand,
    disablePasteBurst: appState.disablePasteBurst,
    notifications: appState.notifications,
    upgrade: appState.upgrade,
    statusLine: appState.statusLine,
    goal: appState.goal,
    mcpServersSummary: appState.mcpServersSummary,
    banner: appState.banner,
  };
}

function projectEditor(
  editor:
    | (Omit<TerminalEditorView, "autocomplete"> & {
        readonly autocomplete?: readonly string[];
      })
    | undefined,
  commands: readonly TerminalHelpCommandView[],
): TerminalEditorView {
  const value = {
    ...(editor ?? {
      text: "",
      cursorLine: 0,
      cursorColumn: 0,
      inputMode: "prompt" as const,
    }),
    autocomplete: editor?.autocomplete ?? [],
  };
  const match =
    value.inputMode === "prompt" ? SLASH_INPUT_PATTERN.exec(value.text) : null;
  const prefix = match?.groups?.["prefix"]?.toLowerCase();
  if (value.autocomplete.length > 0 || match === null) return value;
  const autocomplete =
    prefix === undefined
      ? []
      : commands
          .filter(
            (command) =>
              command.name.toLowerCase().startsWith(prefix) ||
              command.aliases.some((alias) =>
                alias.toLowerCase().startsWith(prefix),
              ),
          )
          .slice(0, 8)
          .map((command) => `/${command.name} — ${command.description}`);
  return { ...value, autocomplete };
}

/** Build a stable snapshot for any terminal renderer. */
export function createTerminalViewState(
  source: TerminalViewSource,
): TerminalViewState {
  const app = projectAppState(source.appState);
  return {
    app,
    startup: source.startupState,
    transcript: [...source.transcriptEntries],
    livePane: { ...source.livePane },
    activity: {
      mode: resolveTerminalActivityMode(source),
      tip: source.activityTip,
    },
    queue: {
      messages: [...source.queuedMessages],
      isCompacting: app.isCompacting,
      isStreaming: app.streamingPhase !== "idle",
      canSteerImmediately: !source.deferUserMessages,
    },
    editor: projectEditor(source.editor, source.helpCommands ?? []),
    dialog: {
      active: source.activeDialog,
      pendingApproval: source.livePane.pendingApproval,
      pendingQuestion: source.livePane.pendingQuestion,
      sessions: [...(source.sessions ?? [])],
      loadingSessions: source.loadingSessions ?? false,
      sessionsScope: source.sessionsScope ?? "cwd",
      helpCommands: [...(source.helpCommands ?? [])],
      trustPrompt: source.trustPrompt ?? null,
      selectedIndex: source.dialogSelectedIndex ?? 0,
      scrollTop: source.dialogScrollTop ?? 0,
    },
    toolOutputExpanded: source.toolOutputExpanded,
    externalEditorRunning: source.externalEditorRunning,
    queuedMessageDispatchPending: source.queuedMessageDispatchPending,
    swarmModeEntry: source.swarmModeEntry,
  };
}

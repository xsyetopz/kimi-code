import process from "node:process";
import type { DeviceAuthorization } from "@moonshot-ai/kimi-code-oauth";
import type {
  ApprovalRequest,
  ApprovalResponse,
  BackgroundTaskInfo,
  CreateSessionOptions,
  KimiHarness,
  PermissionMode,
  PluginCommandDef,
  PromptPart,
  Session,
  SkillSummary,
  WorkspaceTrustInfo,
} from "@moonshot-ai/kimi-code-sdk";
import { effectiveModelAlias, log } from "@moonshot-ai/kimi-code-sdk";
import {
  type Component,
  deleteAllKittyImages,
  type Focusable,
  getCapabilities,
  Key,
  matchesKey,
  Spacer,
} from "@moonshot-ai/kimi-tui";
import { resolve } from "pathe";
import type { CLIOptions } from "#/cli/options";
import { copyTextToClipboard } from "#/utils/clipboard/clipboard-text";
import {
  appendInputHistory,
  loadInputHistory,
} from "#/utils/history/input-history";
import { openUrl } from "#/utils/open-url";
import { getInputHistoryFile } from "#/utils/paths";
import { detectFdPath, ensureFdPath } from "#/utils/process/fd-detect";
import { quoteShellArg } from "#/utils/shell-quote";
import { startupTrace } from "#/utils/startup-trace";
import { restoreTerminalModes } from "#/utils/terminal-restore";
import { BannerProvider } from "./banner/banner-provider.ts";
import {
  readBannerDisplayState,
  writeBannerDisplayState,
} from "./banner/state.ts";
import * as slashCommands from "./commands/dispatch.ts";
import {
  BUILTIN_SLASH_COMMANDS,
  buildPluginSlashCommands,
  buildSkillSlashCommands,
  isExperimentalFlagEnabled,
  type KimiSlashCommand,
  type SkillListSession,
  setExperimentalFeatures,
  sortSlashCommands,
} from "./commands/index.ts";
import { BannerComponent } from "./components/chrome/banner.ts";
import { DeviceCodeBoxComponent } from "./components/chrome/device-code-box.ts";
import { GutterContainer } from "./components/chrome/gutter-container.ts";
import {
  MoonLoader,
  type SpinnerStyle,
} from "./components/chrome/moon-loader.ts";
import { WelcomeComponent } from "./components/chrome/welcome.ts";
import { pickRandomWorkingTip } from "./components/chrome/working-tips.ts";
import {
  ApprovalPanelComponent,
  type ApprovalPanelResponse,
} from "./components/dialogs/approval-panel.ts";
import {
  type ApprovalPreviewBlock,
  ApprovalPreviewViewer,
} from "./components/dialogs/approval-preview.ts";
import {
  approvalPreviewMaxScroll,
  approvalPreviewViewableRows,
  buildApprovalPreviewBody,
  findApprovalPreviewBlock,
} from "./components/dialogs/approval-preview-body.ts";
import { CompactionComponent } from "./components/dialogs/compaction.ts";
import { HelpPanelComponent } from "./components/dialogs/help-panel.ts";
import { defaultThinkingEffortFor } from "./components/dialogs/model-selector.ts";
import {
  buildQuestionDisplayOptions,
  isQuestionOtherOption,
  questionOtherOptionIndex,
} from "./components/dialogs/question-dialog-options.ts";
import { QuestionDialogComponent } from "./components/dialogs/question-dialog.ts";
import {
  SessionPickerComponent,
  type SessionRow,
} from "./components/dialogs/session-picker.ts";
import {
  type TrustPromptChoice,
  TrustPromptComponent,
} from "./components/dialogs/trust-prompt.ts";
import {
  FileMentionProvider,
  type SlashAutocompleteCommand,
} from "./components/editor/file-mention-provider.ts";
import { AssistantMessageComponent } from "./components/messages/assistant-message.ts";
import { BackgroundAgentStatusComponent } from "./components/messages/background-agent-status.ts";
import { CronMessageComponent } from "./components/messages/cron-message.ts";
import { buildGoalMarker } from "./components/messages/goal-markers.ts";
import {
  GoalCompletionMessageComponent,
  GoalSetMessageComponent,
} from "./components/messages/goal-panel.ts";
import { PluginCommandComponent } from "./components/messages/plugin-command.ts";
import { ShellRunComponent } from "./components/messages/shell-run.ts";
import { SkillActivationComponent } from "./components/messages/skill-activation.ts";
import {
  NoticeMessageComponent,
  StatusMessageComponent,
} from "./components/messages/status-message.ts";
import { StepSummaryComponent } from "./components/messages/step-summary.ts";
import { ThinkingComponent } from "./components/messages/thinking.ts";
import { ToolCallComponent } from "./components/messages/tool-call.ts";
import {
  ReplayTurnBoundaryComponent,
  UserMessageComponent,
} from "./components/messages/user-message.ts";
import {
  ActivityPaneComponent,
  type ActivityPaneMode,
} from "./components/panes/activity-pane.ts";
import { QueuePaneComponent } from "./components/panes/queue-pane.ts";
import type { TuiConfig } from "./config.ts";
import {
  LLM_NOT_SET_MESSAGE,
  MAIN_AGENT_ID,
  NO_ACTIVE_SESSION_MESSAGE,
  PRODUCT_NAME,
  SESSIONLESS_STARTUP_NOTICE,
} from "./constant/kimi-tui.ts";
import { CHROME_GUTTER } from "./constant/rendering.ts";
import { MAX_TERMINAL_TITLE_LENGTH } from "./constant/terminal.ts";
import { AuthFlowController } from "./controllers/auth-flow.ts";
import { BtwPanelController } from "./controllers/btw-panel.ts";
import { ClipboardImageHintController } from "./controllers/clipboard-image-hint.ts";
import { EditorKeyboardController } from "./controllers/editor-keyboard.ts";
import { SessionEventHandler } from "./controllers/session-event-handler.ts";
import { SessionReplayRenderer } from "./controllers/session-replay.ts";
import { StreamingUIController } from "./controllers/streaming-ui.ts";
import { TasksBrowserController } from "./controllers/tasks-browser.ts";
import { installRainbowDance } from "./easter-eggs/dance.ts";
import {
  type InkTerminalRenderer,
  type InkTerminalRendererOptions,
  mountInkTerminalRenderer,
} from "./renderer/ink-terminal-renderer.ts";
import {
  resetInkOverlayApproval,
  resetInkOverlayQuestion,
} from "./renderer/ink-overlay-state.ts";
import {
  type PromptSemanticAction,
  routePromptEditorInput,
} from "./renderer/prompt-editor-input.ts";
import {
  createPromptEditorState,
  type PromptEditorAction,
  type PromptEditorState,
  promptEditorLineColumn,
  reducePromptEditor,
} from "./renderer/prompt-editor-state.ts";
import { TerminalOwnership } from "./renderer/terminal-owner.ts";
import {
  createTerminalViewState,
  resolveTerminalActivityMode,
  type TerminalHelpCommandView,
  type TerminalSessionView,
  type TerminalTrustPromptView,
  type TerminalViewState,
} from "./renderer/terminal-view-state.ts";
import { adaptPanelResponse } from "./reverse-rpc/approval/adapter.ts";
import { ApprovalController } from "./reverse-rpc/approval/controller.ts";
import { createApprovalRequestHandler } from "./reverse-rpc/approval/handler.ts";
import { registerReverseRPCHandlers } from "./reverse-rpc/index.ts";
import { QuestionController } from "./reverse-rpc/question/controller.ts";
import { createQuestionAskHandler } from "./reverse-rpc/question/handler.ts";
import type {
  ApprovalPanelData,
  QuestionPanelData,
} from "./reverse-rpc/types.ts";
import type { ColorToken, ResolvedTheme, ThemeName } from "./theme/index.ts";
import {
  currentTheme,
  getBuiltInPalette,
  getColorPalette,
  isBuiltInTheme,
} from "./theme/index.ts";
import { createTUIState, type TUIState } from "./tui-state.ts";
import {
  type AppState,
  INITIAL_LIVE_PANE,
  type KimiTUIOptions,
  type LivePaneState,
  type LoginProgressSpinnerHandle,
  type QueuedMessage,
  type SteerInputItem,
  type TranscriptEntry,
} from "./types.ts";
import { hasDispose, isExpandable } from "./utils/component-capabilities.ts";
import { isDeadTerminalError } from "./utils/dead-terminal.ts";
import { formatErrorMessage } from "./utils/event-payload.ts";
import { pickForegroundTasks } from "./utils/foreground-task.ts";
import {
  type ImageAttachment,
  ImageAttachmentStore,
} from "./utils/image-attachment-store.ts";
import {
  extractMediaAttachments,
  rewriteMediaPlaceholders,
} from "./utils/image-placeholder.ts";
import { installInputLatencyProbe } from "./utils/input-latency.ts";
import { REPLAY_TURN_LIMIT } from "./utils/message-replay.ts";
import { hasPatchChanges } from "./utils/object-patch.ts";
import { sessionRowsForPicker } from "./utils/session-picker-rows.ts";
import { formatBashOutputForDisplay } from "./utils/shell-output.ts";
import {
  combineStartupNotice,
  isOAuthLoginRequiredError,
} from "./utils/startup.ts";
import { installTerminalFocusTracking } from "./utils/terminal-focus.ts";
import { notifyTerminalOnce } from "./utils/terminal-notification.ts";
import { installTerminalThemeTracking } from "./utils/terminal-theme.ts";
import { thinkingEffortFromConfig } from "./utils/thinking-config.ts";
import { detectTmuxKeyboardWarning } from "./utils/tmux-keyboard.ts";
import { isPrintableChar, printableChar } from "./utils/printable-key.ts";
import {
  getTranscriptComponentEntry,
  markTranscriptComponent,
} from "./utils/transcript-component-metadata.ts";
import { nextTranscriptId } from "./utils/transcript-id.ts";
import {
  groupTurns,
  TRANSCRIPT_EXPAND_TURNS,
  TRANSCRIPT_HYSTERESIS,
  TRANSCRIPT_KEEP_RECENT_ASSISTANT,
  TRANSCRIPT_KEEP_RECENT_ASSISTANT_COMPLETED,
  TRANSCRIPT_KEEP_RECENT_STEPS,
  TRANSCRIPT_MAX_TURNS,
  TRANSCRIPT_WINDOW_ENABLED,
  turnsToTrim,
} from "./utils/transcript-window.ts";

export type { TUIState } from "./tui-state.ts";
export { createTUIState } from "./tui-state.ts";
export type {
  KimiTUIOptions,
  LoginProgressSpinnerHandle,
  TUIStartupOptions,
  TUIStartupState,
} from "./types.ts";

export interface KimiTUIStartupInput {
  readonly cliOptions: CLIOptions;
  /** Profile name resolved from cliOptions --agent/--agent-file (see resolveAgentProfileSelection). */
  readonly agentProfile?: string;
  readonly additionalDirs?: readonly string[];
  readonly tuiConfig: TuiConfig;
  readonly version: string;
  readonly workDir: string;
  readonly startupNotice?: string;
  /** Enables the v2-only startup/session behavior for embedded callers. */
  readonly engineV2?: boolean;
  /** Selects the terminal owner; Ink is the default and kimi-tui is rollback-only. */
  readonly terminalRenderer?: "kimi-tui" | "ink";
}

type EffectiveActivityPaneMode = ActivityPaneMode | "idle" | "session";
type LoadingTipKind = "moon" | "composing";

function loadingTipKind(
  mode: EffectiveActivityPaneMode,
): LoadingTipKind | undefined {
  if (mode === "waiting" || mode === "tool") return "moon";
  if (mode === "composing") return "composing";
  return undefined;
}

function sameStringArrays(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

type MutableCreateSessionOptions = {
  -readonly [P in keyof CreateSessionOptions]: CreateSessionOptions[P];
};

function createInitialAppState(input: KimiTUIStartupInput): AppState {
  const startupPermission: PermissionMode = input.cliOptions.auto
    ? "auto"
    : input.cliOptions.yolo
      ? "yolo"
      : "manual";
  return {
    model: "",
    workDir: input.workDir,
    additionalDirs: [...(input.additionalDirs ?? [])],
    sessionId: "",
    permissionMode: startupPermission,
    planMode: input.cliOptions.plan,
    inputMode: "prompt",
    swarmMode: false,
    thinkingEffort: "off",
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 0,
    isCompacting: false,
    isReplaying: false,
    streamingPhase: "idle",
    streamingStartTime: 0,
    theme: input.tuiConfig.theme,
    version: input.version,
    editorCommand: input.tuiConfig.editorCommand,
    disablePasteBurst: input.tuiConfig.disablePasteBurst,
    notifications: input.tuiConfig.notifications,
    upgrade: input.tuiConfig.upgrade,
    statusLine: input.tuiConfig.statusLine,
    availableModels: {},
    availableProviders: {},
    sessionTitle: null,
    goal: null,
    mcpServersSummary: null,
    banner: undefined,
  };
}

interface SendMessageOptions {
  readonly parts?: readonly PromptPart[];
  readonly imageAttachmentIds?: readonly number[];
  readonly hasMedia?: boolean;
}

/**
 * Flatten steer items into the payload `session.steer` expects: the
 * historical `'\n\n'`-joined string when nothing carries media, or a
 * merged part list when any item has extracted media parts (queued image
 * messages, or the editor draft after placeholder extraction).
 *
 * Items are separated by the historical `'\n\n'`, which merges into the
 * adjacent text part. The one exception is two touching media parts: a
 * standalone `{type:'text',text:'\n\n'}` between them would be rejected
 * by `normalizePromptInput` as an empty text part, so the separator is
 * dropped there (media parts are self-delimiting anyway).
 */
function combineSteerInput(
  items: readonly SteerInputItem[],
): string | PromptPart[] {
  const hasMedia = items.some(
    (item) => item.parts !== undefined && item.parts.length > 0,
  );
  if (!hasMedia) return items.map((item) => item.text).join("\n\n");
  const parts: PromptPart[] = [];
  for (const item of items) {
    const startsWithMedia =
      item.parts !== undefined &&
      item.parts.length > 0 &&
      item.parts[0]?.type !== "text";
    const lastIsMedia = parts.length > 0 && parts.at(-1)?.type !== "text";
    if (parts.length > 0 && !(lastIsMedia && startsWithMedia)) {
      appendSteerText(parts, "\n\n");
    }
    if (item.parts !== undefined && item.parts.length > 0) {
      for (const part of item.parts) {
        if (part.type === "text") appendSteerText(parts, part.text);
        else parts.push(part);
      }
    } else {
      appendSteerText(parts, item.text);
    }
  }
  return parts;
}

function appendSteerText(parts: PromptPart[], text: string): void {
  const last = parts.at(-1);
  if (last?.type === "text") {
    parts[parts.length - 1] = { type: "text", text: last.text + text };
    return;
  }
  parts.push({ type: "text", text });
}

/** How long the one-shot "moved to background" footer hint stays visible. */
const DETACH_HINT_DISPLAY_MS = 4_000;

export class KimiTUI {
  readonly harness: KimiHarness;
  readonly options: KimiTUIOptions;
  session: Session | undefined;
  state: TUIState;
  /** In-flight lazy session creation (v2 engine), shared by concurrent first-use triggers. */
  private ensureSessionPromise: Promise<Session | undefined> | null = null;
  private readonly approvalController = new ApprovalController();
  private readonly questionController = new QuestionController();
  private readonly reverseRpcDisposers: Array<() => void> = [];
  private skillCommands: readonly KimiSlashCommand[] = [];
  readonly skillCommandMap = new Map<string, string>();
  private pluginCommands: readonly KimiSlashCommand[] = [];
  readonly pluginCommandMap = new Map<string, string>();
  private readonly imageStore = new ImageAttachmentStore();
  private fdPath: string | null = detectFdPath();
  private fdDownloadStarted = false;
  sessionEventUnsubscribe: (() => void) | undefined;
  cancelInFlight: (() => void) | undefined;
  deferUserMessages = false;
  aborted = false;
  private terminalFocusTrackingDispose: (() => void) | undefined;
  private terminalThemeTrackingDispose: (() => void) | undefined;
  private clipboardImageHintController:
    | ClipboardImageHintController
    | undefined;
  private uninstallRainbowDance: () => void;
  private signalCleanupHandlers: Array<() => void> = [];
  private isShuttingDown = false;
  private backgroundRefreshPromise: Promise<void> | undefined;
  /** Whether the harness runs on the agent-core-v2 engine (lazy session creation). */
  readonly engineV2: boolean;
  private startupNotice: string | undefined;
  private lastActivityMode: string | undefined;
  private currentLoadingTip:
    | { kind: LoadingTipKind; tip: string | undefined }
    | undefined = undefined;
  private trustPromptView: TerminalTrustPromptView | null = null;
  private trustPromptChoiceResolver:
    | ((choice: TrustPromptChoice) => void)
    | undefined;
  private inkSessionPickerSelect: ((session: SessionRow) => void) | undefined;
  private inkSessionPickerCancel: (() => void) | undefined;
  private inkSessionPickerToggleScope:
    | ((sessionId: string) => void)
    | undefined;
  /** Optional Ink bridge used by the staged renderer migration. */
  private inkRenderer: InkTerminalRenderer | undefined;
  private readonly terminalRenderer: "kimi-tui" | "ink";
  private readonly terminalOwnership = new TerminalOwnership();
  private inkOwnsTerminal(): boolean {
    return this.terminalRenderer === "ink";
  }

  private get inkOverlay() {
    return this.state.inkOverlay;
  }

  private get promptEditorState(): PromptEditorState {
    return this.state.promptEditorState;
  }

  private set promptEditorState(state: PromptEditorState) {
    this.state.promptEditorState = state;
  }

  private lastHistoryContent: string | undefined;
  // Live `!` shell output entries, keyed by commandId so concurrent commands
  // each update their own card and stale events are dropped. Mutated in place
  // as `shell.output` events arrive; removed when the command completes.
  // `taskId` (from `shell.started`) lets ctrl+b detach the exact task.
  private readonly shellOutputStreams = new Map<
    string,
    { entry: TranscriptEntry; component: ShellRunComponent; taskId?: string }
  >();
  readonly streamingUI: StreamingUIController;
  readonly authFlow: AuthFlowController;
  readonly btwPanelController: BtwPanelController;
  readonly sessionEventHandler: SessionEventHandler;
  readonly sessionReplay: SessionReplayRenderer;
  readonly tasksBrowserController: TasksBrowserController;
  readonly editorKeyboard: EditorKeyboardController;

  /** Timer that auto-clears the one-shot "moved to background" footer hint. */
  private detachHintClearTimer: ReturnType<typeof setTimeout> | undefined;

  // The currently-mounted approval panel, if any. Kept so the full-screen
  // preview viewer can restore focus to the exact same instance (and its
  // selection / feedback state) when it closes.
  private activeApprovalPanel: ApprovalPanelComponent | undefined;
  // Active full-screen approval preview. While set, the root UI's normal
  // children are stashed in `savedChildren`; closing restores them.
  private approvalPreview:
    | {
        component: ApprovalPreviewViewer;
        savedChildren: readonly Component[];
        panel: ApprovalPanelComponent;
      }
    | undefined;

  public onExit?: (exitCode?: number) => Promise<void>;

  /** URL opened in the browser just before exit (e.g. by `/web`); printed by onExit. */
  public exitOpenUrl: string | undefined;

  /**
   * Task that takes over the process after the TUI shuts down, instead of
   * exiting (`/web` starting a new server: the server keeps this terminal
   * attached until Ctrl+C). Set via {@link setExitForegroundTask}.
   */
  public exitForegroundTask: ((exitCode: number) => Promise<void>) | undefined;

  track(event: string, properties?: Parameters<KimiHarness["track"]>[1]): void {
    this.harness.track(event, properties);
  }

  /** Current terminal owner, exposed for lifecycle diagnostics and tests. */
  get terminalRendererOwner(): "none" | "kimi-tui" | "ink" {
    return this.terminalOwnership.current;
  }

  constructor(harness: KimiHarness, startupInput: KimiTUIStartupInput) {
    this.harness = harness;
    const tuiOptions: KimiTUIOptions = {
      initialAppState: createInitialAppState(startupInput),
      startup: {
        continueLast: startupInput.cliOptions.continue,
        yolo: startupInput.cliOptions.yolo,
        auto: startupInput.cliOptions.auto,
        plan: startupInput.cliOptions.plan,
        agentFiles: startupInput.cliOptions.agentFiles,
        ...(startupInput.cliOptions.session === undefined
          ? {}
          : { sessionFlag: startupInput.cliOptions.session }),
        ...(startupInput.cliOptions.model === undefined
          ? {}
          : { model: startupInput.cliOptions.model }),
        ...(startupInput.agentProfile === undefined
          ? {}
          : { agentProfile: startupInput.agentProfile }),
        ...(startupInput.startupNotice === undefined
          ? {}
          : { startupNotice: startupInput.startupNotice }),
      },
    };
    this.options = tuiOptions;
    // Embedded callers inherit the same React/Ink owner as the production CLI;
    // kimi-tui remains available only when a caller explicitly opts into the
    // rollback renderer during the migration window.
    this.engineV2 = startupInput.engineV2 ?? false;
    this.terminalRenderer = startupInput.terminalRenderer ?? "ink";
    this.startupNotice = startupInput.startupNotice;
    this.state = createTUIState(tuiOptions);
    this.uninstallRainbowDance = installRainbowDance(() => {
      this.state.ui.requestRender();
    });

    this.reverseRpcDisposers.push(
      ...registerReverseRPCHandlers(
        this.approvalController,
        this.questionController,
        {
          showApprovalPanel: (payload) => {
            this.showApprovalPanel(payload);
          },
          hideApprovalPanel: () => {
            this.hideApprovalPanel();
          },
          showQuestionDialog: (payload) => {
            this.showQuestionDialog(payload);
          },
          hideQuestionDialog: () => {
            this.hideQuestionDialog();
          },
        },
      ),
    );
    this.streamingUI = new StreamingUIController(this);
    this.authFlow = new AuthFlowController(this);
    this.btwPanelController = new BtwPanelController(this);
    this.sessionEventHandler = new SessionEventHandler(this);
    this.sessionReplay = new SessionReplayRenderer(this);
    this.tasksBrowserController = new TasksBrowserController(this);
    this.editorKeyboard = new EditorKeyboardController(this, this.imageStore);
    this.editorKeyboard.install();
    this.buildLayout();
  }

  // =========================================================================
  // Autocomplete & Skill Commands
  // =========================================================================

  private getSlashCommands(): readonly KimiSlashCommand[] {
    const builtins = sortSlashCommands(BUILTIN_SLASH_COMMANDS).filter(
      (command) => isExperimentalFlagEnabled(command.experimentalFlag),
    );
    return [...builtins, ...this.skillCommands, ...this.pluginCommands];
  }

  private setupAutocomplete(): void {
    const slashCommands: SlashAutocompleteCommand[] =
      this.getSlashCommands().map((cmd) => {
        const completer = cmd.completeArgs;
        return {
          name: cmd.name,
          aliases: cmd.aliases,
          description: cmd.description,
          ...(cmd.argumentHint !== undefined
            ? { argumentHint: cmd.argumentHint }
            : {}),
          ...(completer !== undefined
            ? { getArgumentCompletions: (prefix: string) => completer(prefix) }
            : {}),
        };
      });
    const provider = new FileMentionProvider(
      slashCommands,
      this.state.appState.workDir,
      this.fdPath,
      this.state.appState.additionalDirs,
      () => this.state.appState.inputMode,
    );
    this.state.editor.setAutocompleteProvider(provider);

    const argumentHints = new Map<string, string>();
    for (const cmd of slashCommands) {
      if (cmd.argumentHint === undefined) continue;
      argumentHints.set(cmd.name, cmd.argumentHint);
      for (const alias of cmd.aliases ?? []) {
        argumentHints.set(alias, cmd.argumentHint);
      }
    }
    this.state.editor.setArgumentHints(argumentHints);
    this.refreshPromptCompletions();
  }

  refreshSlashCommandAutocomplete(): void {
    this.setupAutocomplete();
  }

  async refreshSkillCommands(session?: SkillListSession): Promise<void> {
    if (session === undefined) {
      // v2 engine: skills live on the workspace handler, not the session, so
      // they are available before the first (lazy) session is created — the
      // workspace catalog is the same merged view a session would serve.
      if (this.engineV2) {
        try {
          const skills = await this.harness.listWorkspaceSkills(
            this.state.appState.workDir,
          );
          this.applySkillCommands(skills);
          return;
        } catch {
          return;
        }
      }
      this.skillCommands = [];
      this.skillCommandMap.clear();
      this.setupAutocomplete();
      return;
    }

    let skills;
    try {
      skills = await session.listSkills();
    } catch {
      return;
    }
    this.applySkillCommands(skills);
  }

  private applySkillCommands(skills: readonly SkillSummary[]): void {
    const skillCommands = buildSkillSlashCommands(skills);
    this.skillCommands = skillCommands.commands;
    this.skillCommandMap.clear();
    for (const [commandName, skillName] of skillCommands.commandMap) {
      this.skillCommandMap.set(commandName, skillName);
    }
    this.setupAutocomplete();
  }

  async refreshPluginCommands(session?: Session): Promise<void> {
    if (session === undefined) {
      // v2 engine: the enabled plugin commands are an app-global live view,
      // available before the first (lazy) session is created.
      if (this.engineV2) {
        try {
          const defs = await this.harness.listPluginCommands();
          this.applyPluginCommands(defs);
          return;
        } catch {
          return;
        }
      }
      this.pluginCommands = [];
      this.pluginCommandMap.clear();
      this.setupAutocomplete();
      return;
    }

    let defs;
    try {
      defs = await session.listPluginCommands();
    } catch {
      return;
    }
    this.applyPluginCommands(defs);
  }

  private applyPluginCommands(defs: readonly PluginCommandDef[]): void {
    const pluginSlashCommands = buildPluginSlashCommands(defs);
    this.pluginCommands = pluginSlashCommands.commands;
    this.pluginCommandMap.clear();
    for (const [commandName, body] of pluginSlashCommands.commandMap) {
      this.pluginCommandMap.set(commandName, body);
    }
    this.setupAutocomplete();
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  async start(): Promise<void> {
    startupTrace("tui:start");
    // Signal handlers must be installed before raw mode to avoid EIO loops.
    this.registerSignalHandlers();
    // Outer try rolls back signal listeners on startup failure.
    try {
      startupTrace("trustPrompt:begin");
      const trustPromptStartedLoop = await this.maybeRunWorkspaceTrustPrompt();
      startupTrace("trustPrompt:end");
      startupTrace("initMainTui:begin");
      const shouldReplayHistory = await this.initMainTui();
      startupTrace("initMainTui:end");
      // Debug-only input→render latency overlay (KIMI_TUI_INPUT_LATENCY=1).
      if (process.env["KIMI_TUI_INPUT_LATENCY"])
        installInputLatencyProbe(this.state.ui);
      // When the trust prompt already started the event loop, starting it
      // again would mount a second renderer and duplicate stdin listeners.
      if (!trustPromptStartedLoop) this.startEventLoop();
      startupTrace("eventLoop:started");
      try {
        this.startBackgroundFdAutocomplete();
        startupTrace("finishStartup:begin");
        await this.finishStartup(shouldReplayHistory);
        startupTrace("finishStartup:end");
      } catch (error) {
        this.disposeTerminalTracking();
        this.state.ui.stop();
        throw error;
      }
    } catch (error) {
      this.unregisterSignalHandlers();
      throw error;
    }
  }

  private async loadBanner(): Promise<void> {
    const provider = new BannerProvider(this.state.appState.version);
    const displayState = await readBannerDisplayState();
    const now = new Date();
    const banner = await provider.load(fetch, {
      state: displayState,
      now,
    });
    this.state.appState.banner = banner;
    if (banner === null) return;

    this.renderBanner();
    this.state.ui.requestRender();

    if (banner.display === "always") return;
    try {
      await writeBannerDisplayState({
        version: 1,
        shown: {
          ...displayState.shown,
          [banner.key]: { lastShownAt: now.toISOString() },
        },
      });
    } catch {
      // Best-effort: banner display state should never block startup.
    }
  }

  private renderBanner(): void {
    if (
      this.state.appState.banner === null ||
      this.state.appState.banner === undefined
    ) {
      return;
    }
    if (
      this.state.transcriptContainer.children.some(
        (child) => child instanceof BannerComponent,
      )
    ) {
      return;
    }
    const welcomeIndex = this.state.transcriptContainer.children.findIndex(
      (child) => child instanceof WelcomeComponent,
    );
    const banner = new BannerComponent(this.state.appState.banner);
    if (welcomeIndex >= 0) {
      this.state.transcriptContainer.children.splice(
        welcomeIndex + 1,
        0,
        banner,
      );
    } else {
      this.state.transcriptContainer.children.unshift(banner);
    }
    this.state.transcriptContainer.invalidate();
  }

  private async initMainTui(): Promise<boolean> {
    const shouldReplayHistory = await this.init();

    // Mount only after init() succeeds; see mountFooter().
    this.mountFooter();
    this.renderWelcome();
    void this.loadBanner();
    this.setupAutocomplete();
    void this.loadPersistedInputHistory();
    this.state.editorContainer.clear();
    this.state.editorContainer.addChild(this.state.editor);
    this.state.ui.setFocus(this.state.editor);
    return shouldReplayHistory;
  }

  private startEventLoop(): void {
    // Dispose any previous focus/clipboard/theme tracking so re-entering the
    // event loop (e.g. a future TUI reconnect) can't stack duplicate listeners.
    this.disposeTerminalTracking();
    if (this.terminalRenderer === "ink") {
      this.startInkEventLoop();
      return;
    }
    if (this.terminalOwnership.current === "ink") {
      throw new Error("Cannot start kimi-tui while Ink owns the terminal.");
    }
    this.state.ui.start();
    this.terminalOwnership.claim("kimi-tui");
    this.startClipboardImageHintController();
    this.terminalFocusTrackingDispose = installTerminalFocusTracking(
      this.state,
    );
    this.refreshTerminalThemeTracking();
  }

  /** Start the staged Ink owner without starting kimi-tui's terminal loop. */
  private startInkEventLoop(): void {
    if (this.terminalOwnership.current === "kimi-tui") {
      // A handoff must stop the old terminal first; otherwise both renderers
      // would attach stdin listeners and write competing screen diffs.
      this.state.ui.stop();
      this.terminalOwnership.release("kimi-tui");
    }
    if (this.terminalOwnership.current === "ink") return;

    // TUI.requestRender() remains used by existing controllers, but its
    // output is suppressed while stopped. Ink is the sole stdout owner.
    this.state.ui.stop();
    this.mountInkRenderer({
      onInput: (data) => this.handleInkInput(data),
    });
    this.startClipboardImageHintController();
    this.terminalFocusTrackingDispose = installTerminalFocusTracking(
      this.state,
    );
    this.refreshTerminalThemeTracking();
  }

  /** Temporarily release whichever renderer owns the terminal (external editor). */
  suspendTerminal(): void {
    this.disposeTerminalTracking();
    this.unmountInkRenderer();
    try {
      this.state.ui.stop();
    } finally {
      this.terminalOwnership.release("kimi-tui");
      this.terminalOwnership.release("ink");
    }
  }

  /** Reacquire the configured terminal owner after an external editor exits. */
  resumeTerminal(): void {
    this.startEventLoop();
  }

  /** Route normal prompt input through the renderer-neutral editor model. */
  private handleInkInput(data: string): void {
    if (this.inkOverlay.approvalPreviewBlock !== null) {
      if (this.handleInkApprovalPreviewInput(data)) return;
      this.updateInkRenderer();
      return;
    }
    const hasLegacyDialog =
      this.state.activeDialog !== null ||
      this.state.livePane.pendingApproval !== null ||
      this.state.livePane.pendingQuestion !== null;
    if (hasLegacyDialog) {
      if (this.handleInkSimpleDialogInput(data)) return;
      this.state.ui.dispatchInput(data);
      this.updateInkRenderer();
      return;
    }

    const route = routePromptEditorInput(this.promptEditorState, data);
    if (route.type === "action") {
      this.applyPromptEditorAction(route.action);
    } else if (route.type === "submit") {
      this.syncLegacyPromptEditor();
      this.handleUserInput(route.text);
      this.promptEditorState = reducePromptEditor(this.promptEditorState, {
        type: "set-text",
        text: "",
      });
      this.syncLegacyPromptEditor();
      this.updateInkRenderer();
    } else if (route.type === "semantic") {
      this.handlePromptSemantic(route.action);
    }
  }

  /** Handle dialogs whose interaction model is represented in the Ink snapshot. */
  private handleInkSimpleDialogInput(data: string): boolean {
    if (this.state.livePane.pendingApproval !== null) {
      return this.handleInkApprovalInput(data);
    }
    if (this.state.livePane.pendingQuestion !== null) {
      return this.handleInkQuestionInput(data);
    }
    const dialog = this.state.activeDialog;
    if (dialog === "help") {
      const printable = printableChar(data);
      if (
        matchesKey(data, Key.escape) ||
        matchesKey(data, Key.enter) ||
        printable === "q" ||
        printable === "Q"
      ) {
        this.hideHelpPanel();
        return true;
      }
      if (matchesKey(data, Key.up)) {
        this.inkOverlay.dialogScrollTop = Math.max(0, this.inkOverlay.dialogScrollTop - 1);
        this.updateInkRenderer();
        return true;
      }
      if (matchesKey(data, Key.down)) {
        this.inkOverlay.dialogScrollTop += 1;
        this.updateInkRenderer();
        return true;
      }
      if (matchesKey(data, Key.pageUp)) {
        this.inkOverlay.dialogScrollTop = Math.max(0, this.inkOverlay.dialogScrollTop - 10);
        this.updateInkRenderer();
        return true;
      }
      if (matchesKey(data, Key.pageDown)) {
        this.inkOverlay.dialogScrollTop += 10;
        this.updateInkRenderer();
        return true;
      }
      return true;
    }
    if (dialog !== "trust-prompt" && dialog !== "session-picker") return false;
    const count =
      dialog === "trust-prompt" ? 2 : Math.min(8, this.state.sessions.length);
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      if (count === 0) return true;
      const delta = matchesKey(data, Key.up) ? -1 : 1;
      this.inkOverlay.dialogSelectedIndex =
        (this.inkOverlay.dialogSelectedIndex + delta + count) % count;
      this.updateInkRenderer();
      return true;
    }
    if (matchesKey(data, Key.escape)) {
      if (dialog === "trust-prompt") {
        this.trustPromptChoiceResolver?.("distrust");
      } else {
        this.inkSessionPickerCancel?.();
      }
      return true;
    }
    if (dialog === "session-picker" && matchesKey(data, Key.ctrl("a"))) {
      const selected = this.state.sessions[this.inkOverlay.dialogSelectedIndex];
      this.inkSessionPickerToggleScope?.(
        selected?.id ?? this.state.appState.sessionId,
      );
      return true;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
      if (dialog === "trust-prompt") {
        this.trustPromptChoiceResolver?.(
          this.inkOverlay.dialogSelectedIndex === 0 ? "trust" : "distrust",
        );
      } else {
        const selected = this.state.sessions[this.inkOverlay.dialogSelectedIndex];
        if (selected !== undefined) this.inkSessionPickerSelect?.(selected);
      }
      return true;
    }
    return false;
  }

  private handleInkApprovalInput(data: string): boolean {
    const approval = this.state.livePane.pendingApproval;
    if (approval === null) return false;
    const choices = approval.data.choices;
    const count = choices.length;

    if (this.inkOverlay.approvalFeedbackMode) {
      if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
        this.inkOverlay.approvalFeedbackMode = false;
        this.inkOverlay.approvalFeedbackText = "";
        if (count > 0) {
          const delta = matchesKey(data, Key.up) ? -1 : 1;
          this.inkOverlay.dialogSelectedIndex =
            (this.inkOverlay.dialogSelectedIndex + delta + count) % count;
        }
        this.updateInkRenderer();
        return true;
      }
      if (matchesKey(data, Key.escape)) {
        this.inkOverlay.approvalFeedbackMode = false;
        this.inkOverlay.approvalFeedbackText = "";
        this.updateInkRenderer();
        return true;
      }
      if (matchesKey(data, Key.enter)) {
        this.submitInkApproval(
          this.inkOverlay.dialogSelectedIndex,
          this.inkOverlay.approvalFeedbackText,
        );
        return true;
      }
      if (matchesKey(data, Key.backspace) || data === "\u007f") {
        this.inkOverlay.approvalFeedbackText = this.inkOverlay.approvalFeedbackText.slice(
          0,
          -1,
        );
        this.updateInkRenderer();
        return true;
      }
      const printable = printableChar(data);
      if (isPrintableChar(printable)) {
        this.inkOverlay.approvalFeedbackText += printable;
        this.updateInkRenderer();
      }
      return true;
    }

    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl("c")) ||
      matchesKey(data, Key.ctrl("d"))
    ) {
      this.approvalController.respond(
        adaptPanelResponse({ response: "rejected" }),
      );
      return true;
    }

    if (matchesKey(data, Key.ctrl("e"))) {
      const block = this.findInkApprovalPreviewBlock();
      if (block !== undefined) this.openInkApprovalPreview(block);
      return true;
    }

    if (count === 0) return true;
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      const delta = matchesKey(data, Key.up) ? -1 : 1;
      this.inkOverlay.dialogSelectedIndex = (this.inkOverlay.dialogSelectedIndex + delta + count) % count;
      this.updateInkRenderer();
      return true;
    }
    if (matchesKey(data, Key.enter)) {
      this.selectInkApproval(this.inkOverlay.dialogSelectedIndex);
      return true;
    }

    const printable = printableChar(data);
    const numericIndex = Number(printable) - 1;
    if (
      Number.isInteger(numericIndex) &&
      numericIndex >= 0 &&
      numericIndex < count
    ) {
      this.selectInkApproval(numericIndex);
      return true;
    }
    return true;
  }

  private selectInkApproval(index: number): void {
    const approval = this.state.livePane.pendingApproval;
    if (approval === null) return;
    const option = approval.data.choices[index];
    if (option === undefined) return;
    if (option.requires_feedback === true) {
      this.inkOverlay.dialogSelectedIndex = index;
      this.inkOverlay.approvalFeedbackMode = true;
      this.inkOverlay.approvalFeedbackText = "";
      this.updateInkRenderer();
      return;
    }
    this.submitInkApproval(index);
  }

  private submitInkApproval(index: number, feedback = ""): void {
    const approval = this.state.livePane.pendingApproval;
    if (approval === null) return;
    const option = approval.data.choices[index];
    if (option === undefined) return;
    this.approvalController.respond(
      adaptPanelResponse({
        response: option.response,
        feedback: feedback.length > 0 ? feedback : undefined,
        selected_label: option.selected_label,
      }),
    );
  }

  private resetInkApprovalDialogState(): void {
    resetInkOverlayApproval(this.inkOverlay);
  }

  private findInkApprovalPreviewBlock(): ApprovalPreviewBlock | undefined {
    const approval = this.state.livePane.pendingApproval;
    if (approval === null) return;
    return findApprovalPreviewBlock(approval.data.display);
  }

  private openInkApprovalPreview(block: ApprovalPreviewBlock): void {
    if (this.inkOverlay.approvalPreviewBlock !== null) return;
    this.inkOverlay.approvalPreviewBlock = block;
    this.inkOverlay.approvalPreviewScrollTop = 0;
    this.updateInkRenderer();
  }

  private handleInkApprovalPreviewInput(data: string): boolean {
    if (this.inkOverlay.approvalPreviewBlock === null) return false;
    const rows = this.state.terminal.rows;
    const viewable = approvalPreviewViewableRows(rows);
    const printable = printableChar(data);

    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl("e")) ||
      printable === "q" ||
      printable === "Q"
    ) {
      this.closeApprovalPreview();
      return true;
    }
    if (matchesKey(data, Key.up) || printable === "k") {
      this.scrollInkApprovalPreview(-1, viewable);
      return true;
    }
    if (matchesKey(data, Key.down) || printable === "j") {
      this.scrollInkApprovalPreview(1, viewable);
      return true;
    }
    if (matchesKey(data, Key.pageUp) || printable === " " || data === "\x02") {
      this.scrollInkApprovalPreview(-Math.max(1, viewable - 1), viewable);
      return true;
    }
    if (matchesKey(data, Key.pageDown) || data === "\x06") {
      this.scrollInkApprovalPreview(Math.max(1, viewable - 1), viewable);
      return true;
    }
    if (matchesKey(data, Key.home) || printable === "g") {
      this.inkOverlay.approvalPreviewScrollTop = 0;
      this.updateInkRenderer();
      return true;
    }
    if (matchesKey(data, Key.end) || printable === "G") {
      const lineCount = buildApprovalPreviewBody(this.inkOverlay.approvalPreviewBlock)
        .lines.length;
      this.inkOverlay.approvalPreviewScrollTop = approvalPreviewMaxScroll(
        lineCount,
        viewable,
      );
      this.updateInkRenderer();
      return true;
    }
    return true;
  }

  private scrollInkApprovalPreview(delta: number, viewable: number): void {
    if (this.inkOverlay.approvalPreviewBlock === null) return;
    const lineCount = buildApprovalPreviewBody(this.inkOverlay.approvalPreviewBlock)
      .lines.length;
    const maxScroll = approvalPreviewMaxScroll(lineCount, viewable);
    this.inkOverlay.approvalPreviewScrollTop = Math.max(
      0,
      Math.min(this.inkOverlay.approvalPreviewScrollTop + delta, maxScroll),
    );
    this.updateInkRenderer();
  }

  private resetInkQuestionDialogState(): void {
    resetInkOverlayQuestion(this.inkOverlay);
  }

  private isInkSimpleQuestion(payload: QuestionPanelData): boolean {
    return payload.questions.length === 1;
  }

  private handleInkQuestionInput(data: string): boolean {
    const pending = this.state.livePane.pendingQuestion;
    if (pending === null) return false;
    if (!this.isInkSimpleQuestion(pending.data)) return false;

    const question = pending.data.questions[0];
    if (question === undefined) return false;
    const options = buildQuestionDisplayOptions(question);
    const optionCount = options.length;

    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl("c")) ||
      matchesKey(data, Key.ctrl("d"))
    ) {
      if (this.inkOverlay.questionOtherMode) {
        this.inkOverlay.questionOtherMode = false;
        this.inkOverlay.questionOtherText = "";
        this.updateInkRenderer();
        return true;
      }
      this.questionController.respond({ answers: [] });
      return true;
    }

    if (optionCount === 0) return true;

    if (this.inkOverlay.questionOtherMode) {
      if (matchesKey(data, Key.backspace)) {
        this.inkOverlay.questionOtherText = this.inkOverlay.questionOtherText.slice(
          0,
          -1,
        );
        this.updateInkRenderer();
        return true;
      }
      const printable = printableChar(data);
      if (printable !== undefined && isPrintableChar(printable)) {
        this.inkOverlay.questionOtherText += printable;
        this.updateInkRenderer();
        return true;
      }
      if (matchesKey(data, Key.enter)) {
        const value = this.inkOverlay.questionOtherText.trim();
        if (value.length === 0) return true;
        this.inkOverlay.questionOtherMode = false;
        this.inkOverlay.questionOtherText = "";
        if (question.multi_select) {
          this.inkOverlay.questionMultiSelections.add(
            questionOtherOptionIndex(question),
          );
          this.inkOverlay.questionCommittedOtherText = value;
          this.inkOverlay.questionOtherMode = false;
          this.inkOverlay.questionOtherText = "";
          this.updateInkRenderer();
          return true;
        }
        this.questionController.respond({
          answers: [value],
          method: "enter",
        });
        return true;
      }
      return true;
    }

    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      const delta = matchesKey(data, Key.up) ? -1 : 1;
      this.inkOverlay.dialogSelectedIndex =
        (this.inkOverlay.dialogSelectedIndex + delta + optionCount) % optionCount;
      this.updateInkRenderer();
      return true;
    }

    if (question.multi_select) {
      if (matchesKey(data, Key.space)) {
        const index = this.inkOverlay.dialogSelectedIndex;
        if (isQuestionOtherOption(question, index)) {
          this.inkOverlay.questionOtherMode = true;
          this.inkOverlay.questionOtherText = "";
          this.updateInkRenderer();
          return true;
        }
        if (this.inkOverlay.questionMultiSelections.has(index)) {
          this.inkOverlay.questionMultiSelections.delete(index);
        } else {
          this.inkOverlay.questionMultiSelections.add(index);
        }
        this.updateInkRenderer();
        return true;
      }
      if (matchesKey(data, Key.enter)) {
        const labels = options.flatMap((option, index) => {
          if (!this.inkOverlay.questionMultiSelections.has(index)) return [];
          if (option.kind === "other") {
            const other = this.inkOverlay.questionCommittedOtherText.trim();
            return other.length > 0 ? [other] : [];
          }
          return option.label.length > 0 ? [option.label] : [];
        });
        this.questionController.respond({
          answers: labels.length > 0 ? [labels.join(", ")] : [],
          method: "enter",
        });
        return true;
      }
      return true;
    }

    if (matchesKey(data, Key.enter)) {
      const index = this.inkOverlay.dialogSelectedIndex;
      if (isQuestionOtherOption(question, index)) {
        this.inkOverlay.questionOtherMode = true;
        this.inkOverlay.questionOtherText = "";
        this.updateInkRenderer();
        return true;
      }
      const selected = options[index];
      this.questionController.respond({
        answers: selected === undefined ? [] : [selected.label],
        method: "enter",
      });
      return true;
    }

    const printable = printableChar(data);
    const numericIndex = Number(printable) - 1;
    if (
      Number.isInteger(numericIndex) &&
      numericIndex >= 0 &&
      numericIndex < optionCount
    ) {
      if (isQuestionOtherOption(question, numericIndex)) {
        this.inkOverlay.dialogSelectedIndex = numericIndex;
        this.inkOverlay.questionOtherMode = true;
        this.inkOverlay.questionOtherText = "";
        this.updateInkRenderer();
        return true;
      }
      const selected = options[numericIndex];
      this.questionController.respond({
        answers: selected === undefined ? [] : [selected.label],
        method: "number_key",
      });
      return true;
    }
    return true;
  }

  /** Refresh Ink after an asynchronous clipboard/image editor callback. */
  updatePromptEditorView(): void {
    if (!this.inkOwnsTerminal()) {
      this.syncPromptEditorFromLegacy();
    }
    this.updateInkRenderer();
  }

  private handlePromptSemantic(action: PromptSemanticAction): void {
    const consumed = this.editorKeyboard.dispatchPromptSemantic(action);
    if (!consumed && action === "ctrl-b") {
      this.applyPromptEditorAction({ type: "move-left" });
      return;
    }
    if (!consumed && action === "up-empty") {
      this.applyPromptEditorAction({ type: "history-up" });
      return;
    }
    if (!consumed && action === "down-empty") {
      this.applyPromptEditorAction({ type: "history-down" });
      return;
    }
    if (!this.inkOwnsTerminal()) {
      this.syncPromptEditorFromLegacy();
    }
    this.updateInkRenderer();
  }

  private applyPromptEditorAction(action: PromptEditorAction): void {
    this.promptEditorState = reducePromptEditor(this.promptEditorState, action);
    this.syncLegacyPromptEditor();
    this.refreshPromptCompletions();
    this.updateEditorBorderHighlight(this.promptEditorState.text);
    if (!this.inkOwnsTerminal()) {
      this.state.ui.requestRender();
    }
    this.updateInkRenderer();
  }

  private syncLegacyPromptEditor(): void {
    if (this.inkOwnsTerminal()) {
      if (this.state.appState.inputMode !== this.promptEditorState.inputMode) {
        this.setAppState({ inputMode: this.promptEditorState.inputMode });
      }
      return;
    }
    const editor = this.state.editor;
    if (editor.getText() !== this.promptEditorState.text) {
      editor.setText(this.promptEditorState.text);
    }
    if (editor.inputMode !== this.promptEditorState.inputMode) {
      editor.inputMode = this.promptEditorState.inputMode;
    }
    if (this.state.appState.inputMode !== this.promptEditorState.inputMode) {
      this.setAppState({ inputMode: this.promptEditorState.inputMode });
    }
  }

  private syncPromptEditorFromLegacy(): void {
    if (this.inkOwnsTerminal()) return;
    const editor = this.state.editor;
    const cursor = editor.getCursor();
    const text = editor.getText();
    this.promptEditorState = createPromptEditorState({
      text,
      cursor:
        text
          .split("\n")
          .slice(0, cursor.line)
          .reduce((sum, line) => sum + line.length + 1, 0) + cursor.col,
      inputMode: editor.inputMode,
      history: this.promptEditorState.history,
    });
    this.refreshPromptCompletions();
  }

  private refreshPromptCompletions(): void {
    const { text, inputMode } = this.promptEditorState;
    if (inputMode !== "prompt" || !/^\/\S*$/u.test(text)) {
      this.promptEditorState = reducePromptEditor(this.promptEditorState, {
        type: "completion-cancel",
      });
      return;
    }
    const prefix = text.slice(1).toLowerCase();
    const items = this.getSlashCommands()
      .filter(
        (command) =>
          command.name.toLowerCase().startsWith(prefix) ||
          (command.aliases ?? []).some((alias) =>
            alias.toLowerCase().startsWith(prefix),
          ),
      )
      .slice(0, 8)
      .map((command) => `/${command.name}`);
    this.promptEditorState = reducePromptEditor(this.promptEditorState, {
      type: "completion-set",
      items,
    });
  }

  private startClipboardImageHintController(): void {
    this.clipboardImageHintController = new ClipboardImageHintController({
      ui: this.state.ui,
      footer: this.state.footer,
      getModelSupportsImage: () =>
        this.supportsCurrentModelCapability("image_in"),
      requestRender: () => {
        this.state.ui.requestRender();
      },
    });
    this.clipboardImageHintController.start();
  }

  private startBackgroundFdAutocomplete(): void {
    if (this.fdPath !== null || this.fdDownloadStarted) return;
    this.fdDownloadStarted = true;

    void ensureFdPath()
      .then((fdPath) => {
        if (fdPath === null) return;
        this.fdPath = fdPath;
        this.setupAutocomplete();
      })
      .catch(() => {
        // Best-effort background bootstrap: autocomplete keeps using the filesystem fallback.
      });
  }

  private async refreshProviderModelsInBackground(): Promise<void> {
    try {
      const result = await this.authFlow.refreshProviderModels();
      for (const c of result.changed) {
        if (c.added <= 0) continue;
        this.showStatus(
          `${c.providerName} · +${String(c.added)} model${c.added > 1 ? "s" : ""}.`,
        );
      }
      for (const f of result.failed) {
        this.showStatus(
          `Skipped refreshing ${f.provider}: ${f.reason}`,
          "warning",
        );
      }
    } catch {
      // Best-effort: startup must not crash on background refresh failures.
    }
  }

  private async finishStartup(shouldReplayHistory: boolean): Promise<void> {
    if (this.startupNotice !== undefined) {
      this.showStatus(this.startupNotice);
      this.startupNotice = undefined;
    }
    void this.showTmuxKeyboardWarningIfNeeded();
    // Config diagnostics (deprecated keys/env vars, invalid sections) in
    // warning yellow at boot; `run-prompt`/`run-v2-print` print them to
    // stderr for non-interactive runs.
    void this.showConfigWarningsIfAny();
    if (this.state.startupState === "picker") {
      void this.bootstrapFromPicker();
      return;
    }
    if (shouldReplayHistory) {
      await this.sessionReplay.hydrateFromReplay(this.requireSession());
      this.applyStartupPermissionAndPlanToAppState();
    }
    const resumeState = this.session?.getResumeState();
    if (resumeState?.warning !== undefined) {
      this.showStatus(`Warning: ${resumeState.warning}`, "warning");
    }
    if (this.session !== undefined) {
      this.sessionEventHandler.startSubscription();
      void this.showSessionWarnings(this.session);
    }
    void this.fetchSessions();
    if (this.session !== undefined) {
      this.updateTerminalTitle();
    }
    void this.refreshSkillCommands(this.session);
    void this.refreshPluginCommands(this.session);
  }

  private async showSessionWarnings(session: Session): Promise<void> {
    try {
      const warnings = await session.getSessionWarnings();
      if (this.session !== session) return;
      for (const warning of warnings) {
        const severity = warning.severity === "error" ? "error" : "warning";
        this.showStatus(`Warning: ${warning.message}`, severity);
      }
    } catch {
      // Best-effort: startup must not block on warning retrieval.
    }
  }

  private async showTmuxKeyboardWarningIfNeeded(): Promise<void> {
    const warning = await detectTmuxKeyboardWarning();
    if (warning === undefined || this.aborted) return;
    this.showStatus(warning, "warning");
  }

  private async init(): Promise<boolean> {
    setExperimentalFeatures(await this.harness.getExperimentalFeatures());
    await this.authFlow.refreshAvailableModels();
    this.backgroundRefreshPromise = this.refreshProviderModelsInBackground();

    const { startup } = this.options;
    const { workDir } = this.state.appState;
    let session: Session | undefined;
    let shouldReplayHistory = false;
    const isResumeStartup =
      startup.sessionFlag !== undefined || startup.continueLast;
    const createSessionOptions: MutableCreateSessionOptions = {
      workDir,
      model: startup.model,
      permission: startup.auto ? "auto" : startup.yolo ? "yolo" : undefined,
      planMode: startup.plan ? true : undefined,
      // --agent/--agent-file bind the startup session only; sessions created
      // later in this process fall back to the default profile.
      agentProfile: startup.agentProfile,
      agentFiles: startup.agentFiles?.length
        ? [...startup.agentFiles]
        : undefined,
    };
    if (this.state.appState.additionalDirs.length > 0) {
      createSessionOptions.additionalDirs = [
        ...this.state.appState.additionalDirs,
      ];
    }

    try {
      if (isResumeStartup) {
        if (startup.sessionFlag === "") {
          this.state.startupState = "picker";
          this.updateInkRenderer();
          return false;
        }

        if (startup.sessionFlag !== undefined) {
          const sessions = await this.harness.listSessions({
            sessionId: startup.sessionFlag,
            workDir,
          });
          const target = sessions[0];
          if (target === undefined) {
            throw new Error(`Session "${startup.sessionFlag}" not found.`);
          }
          if (resolve(target.workDir) !== resolve(workDir)) {
            this.state.ui.stop();
            process.stderr.write(
              `${currentTheme.fg(
                "warning",
                `Session "${startup.sessionFlag}" was created under a different directory.\n` +
                  `  cd "${target.workDir}" && kimi -r ${startup.sessionFlag}`,
              )}\n\n`,
            );
            throw new Error(
              `Session "${startup.sessionFlag}" was created under a different directory.`,
            );
          }
          session = await this.harness.resumeSession({
            id: startup.sessionFlag,
            additionalDirs: createSessionOptions.additionalDirs,
            replayTurnLimit: REPLAY_TURN_LIMIT,
          });
          shouldReplayHistory = true;
        } else {
          const sessions = await this.harness.listSessions({ workDir });
          const target = sessions[0];
          if (target !== undefined) {
            session = await this.harness.resumeSession({
              id: target.id,
              additionalDirs: createSessionOptions.additionalDirs,
              replayTurnLimit: REPLAY_TURN_LIMIT,
            });
            shouldReplayHistory = true;
          } else {
            session = await this.harness.createSession(createSessionOptions);
            this.startupNotice = combineStartupNotice(
              this.startupNotice,
              `No sessions to continue under "${workDir}"; starting a fresh session.`,
            );
          }
        }
      } else if (this.engineV2) {
        // Lazy session creation (v2 engine): start session-less and create the
        // session on the first message. Startup flags are carried in appState
        // and applied when that session is created; until then the footer
        // shows the config defaults the engine would apply at createSession
        // time (model, permission, plan mode, thinking effort, context cap).
        await this.hydrateLazyConfigDefaults();
        this.appendStartupNotice(SESSIONLESS_STARTUP_NOTICE);
      } else {
        session = await this.harness.createSession(createSessionOptions);
      }
      if (session !== undefined && shouldReplayHistory) {
        await this.applyStartupModesToResumedSession(session);
        if (startup.model !== undefined) {
          await session.setModel(startup.model);
        }
      }
    } catch (error) {
      if (!isOAuthLoginRequiredError(error)) throw error;
      this.authFlow.enterLoginRequiredStartupState();
      return false;
    }

    if (!this.engineV2 && session === undefined) {
      throw new Error("Startup session was not initialized.");
    }
    if (session !== undefined) {
      await this.setSession(session);
      await this.syncRuntimeState(session);
    }
    this.applyStartupPermissionAndPlanToAppState();
    this.state.startupState = "ready";
    this.updateInkRenderer();
    return shouldReplayHistory;
  }

  async stop(exitCode?: number): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    this.unregisterSignalHandlers();
    this.aborted = true;
    // Give the startup provider-model refresh a brief chance to finish before
    // the harness closes (and the process exits): its config writes are each
    // atomic, so draining can only ever leave a complete file behind. Bounded
    // so a slow network never delays the exit.
    if (this.backgroundRefreshPromise !== undefined) {
      await Promise.race([
        this.backgroundRefreshPromise,
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
    }
    this.streamingUI.discardPending();
    // Stop background polling, streaming intervals, and per-component timers
    // before tearing the UI down, so they can't keep firing requestRender after
    // stop() returns (or leak when stop() runs without process.exit).
    this.tasksBrowserController.close();
    this.btwPanelController.clear();
    this.stopActivitySpinner();
    this.streamingUI.disposeActiveCompactionBlock();
    this.streamingUI.resetToolUi();
    this.disposeTranscriptChildren();
    this.editorKeyboard.dispose();
    this.state.footer.dispose();
    for (const dispose of this.reverseRpcDisposers) {
      dispose();
    }
    this.reverseRpcDisposers.length = 0;
    this.disposeTerminalTracking();
    // Restore the terminal even if closing the session / harness throws — a
    // SIGTERM during a network or MCP shutdown must not leave the user stuck in
    // raw mode with a hidden cursor.
    try {
      await this.closeSession("shutting down");
      await this.harness.close();
    } finally {
      this.unmountInkRenderer();
      this.sessionEventHandler.stopAllMcpServerStatusSpinners();
      this.uninstallRainbowDance();
      try {
        await this.state.terminal.drainInput();
      } catch {
        // best effort — the terminal may already be dead (SIGHUP / EIO).
      }
      try {
        this.state.ui.stop();
      } catch {
        // best effort terminal restore.
      }
    }
    if (this.onExit) {
      await this.onExit(exitCode);
    }
  }

  // SIGHUP / dead-terminal EIO → emergencyTerminalExit (no cleanup, avoids
  // EIO write-loop that can pin a CPU core). SIGTERM → normal stop().
  private registerSignalHandlers(): void {
    this.unregisterSignalHandlers();

    const signals: NodeJS.Signals[] = ["SIGTERM"];
    if (process.platform !== "win32") {
      signals.push("SIGHUP");
    }

    for (const signal of signals) {
      const handler = (): void => {
        if (signal === "SIGHUP") {
          this.emergencyTerminalExit();
          return;
        }
        // Registering a SIGTERM listener disables Node's default exit(143),
        // so we must reinstate it after stop() or on failure.
        this.stop(143).then(
          () => {
            process.exit(143);
          },
          () => {
            this.emergencyTerminalExit(143);
          },
        );
      };
      process.prependListener(signal, handler);
      this.signalCleanupHandlers.push(() => {
        process.off(signal, handler);
      });
    }

    const terminalErrorHandler = (error: Error): void => {
      if (isDeadTerminalError(error)) {
        this.emergencyTerminalExit();
      }
    };
    process.stdout.on("error", terminalErrorHandler);
    process.stderr.on("error", terminalErrorHandler);
    this.signalCleanupHandlers.push(() => {
      process.stdout.off("error", terminalErrorHandler);
    });
    this.signalCleanupHandlers.push(() => {
      process.stderr.off("error", terminalErrorHandler);
    });
  }

  private unregisterSignalHandlers(): void {
    const handlers = this.signalCleanupHandlers;
    this.signalCleanupHandlers = [];
    for (const cleanup of handlers) cleanup();
  }

  // Exit codes follow POSIX 128+signum: 129 = SIGHUP, 143 = SIGTERM.
  private emergencyTerminalExit(exitCode = 129): never {
    this.isShuttingDown = true;
    this.unregisterSignalHandlers();
    // Best-effort terminal restore: stop() may not have run (SIGHUP) or may
    // have thrown (SIGTERM cleanup failure), so recover raw mode / cursor /
    // bracketed paste before exiting instead of leaving the user's shell broken.
    restoreTerminalModes();
    process.exit(exitCode);
  }

  private disposeTerminalTracking(): void {
    this.stopTerminalThemeTracking();
    this.clipboardImageHintController?.stop();
    this.clipboardImageHintController = undefined;
    this.terminalFocusTrackingDispose?.();
    this.terminalFocusTrackingDispose = undefined;
  }

  private buildLayout(): void {
    const { ui } = this.state;
    ui.clear();
    ui.addChild(this.state.transcriptContainer);
    ui.addChild(this.state.activityContainer);
    ui.addChild(this.state.todoPanelContainer);
    ui.addChild(this.state.queueContainer);
    ui.addChild(this.state.btwPanelContainer);
    ui.addChild(this.state.editorContainer);
    // Footer is mounted later (mountFooter), not here.
  }

  // Footer is the only chrome with content before a session is ready, so
  // mounting it at construction lets a stray pre-start render leak it to the
  // terminal — e.g. above the error when resuming a missing session. Mount it
  // only once init() succeeds. FooterComponent isn't a Container, so wrap it to
  // pick up the same outer gutter as the panels above.
  private mountFooter(): void {
    const footerWrap = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
    footerWrap.addChild(this.state.footer);
    this.state.ui.addChild(footerWrap);
  }

  // =========================================================================
  // Input Dispatch
  // =========================================================================

  handlePlanToggle(next: boolean): void {
    void slashCommands.handlePlanCommand(this, next ? "on" : "off");
  }

  handleInputModeChange(mode: "prompt" | "bash"): void {
    this.setAppState({ inputMode: mode });
    this.promptEditorState = reducePromptEditor(this.promptEditorState, {
      type: "set-mode",
      inputMode: mode,
    });
    this.updateEditorBorderHighlight();
  }

  /** {@link EditorKeyboardController} ink prompt bridge methods. */
  inkOwnsPromptEditor(): boolean {
    return this.inkOwnsTerminal();
  }

  getPromptEditorText(): string {
    return this.promptEditorState.text;
  }

  setPromptEditorText(text: string): void {
    this.applyPromptEditorAction({ type: "set-text", text });
  }

  getPromptInputMode(): "prompt" | "bash" {
    return this.promptEditorState.inputMode;
  }

  setPromptInputMode(mode: "prompt" | "bash"): void {
    this.handleInputModeChange(mode);
  }

  insertPromptEditorText(text: string): void {
    this.applyPromptEditorAction({ type: "insert", text });
  }

  requestPromptEditorRender(): void {
    this.updateInkRenderer();
  }

  handleUserInput(text: string): void {
    const wasBashMode = this.state.appState.inputMode === "bash";
    if (wasBashMode) {
      // A submit always exits bash mode (the `!` is consumed by this command).
      this.state.editor.inputMode = "prompt";
      this.handleInputModeChange("prompt");
    }
    if (text.trim().length === 0) return;
    if (this.state.appState.isReplaying) {
      this.showError("Cannot send input while session history is replaying.");
      return;
    }
    // Shell commands are stored with a leading `!` so ↑ recall can tell them
    // apart from prompts and restore bash mode (see CustomEditor's mode-aware
    // history navigation). The `!` is stripped again when the entry is recalled.
    const historyText = wasBashMode ? `!${text}` : text;
    void this.persistInputHistory(historyText);
    if (wasBashMode) {
      // Only one foreground action at a time: queue the shell command while
      // another shell command is running or an agent turn is in progress.
      if (this.state.appState.streamingPhase !== "idle") {
        this.enqueueMessage(text, undefined, "bash");
        this.updateQueueDisplay();
        this.state.ui.requestRender();
        return;
      }
      void this.runShellCommandFromInput(text);
      return;
    }
    slashCommands.dispatchInput(this, text);
  }

  private async runShellCommandFromInput(command: string): Promise<void> {
    let session = this.session;
    if (session === undefined) {
      if (!this.engineV2) {
        this.showError("No active session for shell command.");
        return;
      }
      session = await this.ensureSession();
      if (session === undefined) return;
      // A concurrent first message may have started a prompt while this lazy
      // creation was in flight (both inputs share the same creation promise);
      // honor the busy gate here, like handleUserInput does before the await,
      // instead of running the shell command concurrently with an agent turn.
      if (this.state.appState.streamingPhase !== "idle") {
        this.enqueueMessage(command, undefined, "bash");
        this.updateQueueDisplay();
        this.state.ui.requestRender();
        return;
      }
    }
    // Echo the command locally (bash-input) with a `$` prompt. The agent also
    // records it for resume; this is the live view.
    this.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: "user",
      turnId: undefined,
      renderMode: "plain",
      content: currentTheme.fg("shellMode", `$ ${command}`),
      bullet: "",
    });
    // Create the live output entry up front. ShellRunComponent owns its own
    // rendering (running card → final view) and is mutated in place as output
    // streams in and on completion.
    const commandId = nextTranscriptId();
    const outputEntry: TranscriptEntry = {
      id: commandId,
      kind: "status",
      turnId: undefined,
      renderMode: "plain",
      content: "",
    };
    const outputComponent = new ShellRunComponent(() =>
      this.state.ui.requestRender(),
    );
    this.shellOutputStreams.set(commandId, {
      entry: outputEntry,
      component: outputComponent,
    });
    this.state.transcriptEntries.push(outputEntry);
    markTranscriptComponent(outputComponent, outputEntry);
    this.state.transcriptContainer.addChild(outputComponent);
    // Treat command execution as a streaming phase so input queues, the activity
    // pane shows the moon spinner, and ctrl+b is enabled while it runs.
    this.setAppState({ streamingPhase: "shell" });
    this.state.ui.requestRender();

    this.track("shell_command");

    void session.runShellCommand(command, { commandId }).then(
      ({ stdout, stderr, isError, backgrounded }) => {
        this.finishShellOutput(
          commandId,
          stdout,
          stderr,
          isError,
          backgrounded,
        );
      },
      (error: unknown) => {
        const message = formatErrorMessage(error);
        this.finishShellOutput(commandId, "", message, true);
        this.showError(`Shell command failed: ${message}`);
      },
    );
  }

  handleShellOutput(event: {
    commandId: string;
    update: { kind: string; text?: string };
  }): void {
    const stream = this.shellOutputStreams.get(event.commandId);
    if (stream === undefined) return;
    const text = event.update.text ?? "";
    if (text.length === 0) return;
    stream.component.append(text);
  }

  handleShellStarted(event: { commandId: string; taskId: string }): void {
    const stream = this.shellOutputStreams.get(event.commandId);
    if (stream === undefined) return;
    stream.taskId = event.taskId;
  }

  cancelRunningShellCommand(): void {
    const session = this.session;
    if (session === undefined) return;
    for (const commandId of this.shellOutputStreams.keys()) {
      void session.cancelShellCommand(commandId).catch((error: unknown) => {
        this.showError(
          `Failed to cancel shell command: ${formatErrorMessage(error)}`,
        );
      });
    }
  }

  private finishShellOutput(
    commandId: string,
    stdout: string,
    stderr: string,
    isError?: boolean,
    backgrounded?: boolean,
  ): void {
    const stream = this.shellOutputStreams.get(commandId);
    if (stream === undefined) return;
    if (backgrounded === true) {
      // The command was moved to the background; detachRunningShellCommand owns
      // the UI and the model notification, so there is nothing to render here.
      return;
    }
    stream.component.finish(stdout, stderr, isError);
    // Keep the transcript entry's metadata in sync for anything that reads it
    // (export / copy). The component renders itself.
    stream.entry.content = formatBashOutputForDisplay(stdout, stderr, isError);
    this.shellOutputStreams.delete(commandId);
    // When the last shell command finishes, leave the shell streaming phase,
    // release one queued message (if any), and refresh the activity pane.
    if (this.shellOutputStreams.size === 0) {
      this.setAppState({ streamingPhase: "idle" });
      this.drainOneQueuedMessage();
    }
  }

  private drainOneQueuedMessage(): void {
    const item = this.shiftQueuedMessage();
    if (item === undefined) return;
    const session = this.session;
    if (session === undefined) return;
    if (item.mode === "bash") {
      void this.runShellCommandFromInput(item.text);
    } else {
      this.sendQueuedMessage(session, item);
    }
    this.updateQueueDisplay();
  }

  async sendNormalUserInput(text: string): Promise<void> {
    if (this.btwPanelController.sendUserInput(text)) return;
    if (this.state.appState.model.trim().length === 0) {
      this.showError(LLM_NOT_SET_MESSAGE);
      return;
    }
    let extraction: ReturnType<typeof extractMediaAttachments>;
    try {
      // Pasted videos are copied into the cache and expand to a `file://`
      // `video_url` part; the engine resolves (uploads or degrades) them
      // inside the turn, so submission stays fully synchronous.
      extraction = extractMediaAttachments(text, this.imageStore);
    } catch (error) {
      // A video cache copy failed (unwritable cache dir, vanished source…);
      // nothing was dispatched.
      this.showError(
        `Failed to prepare media attachment: ${formatErrorMessage(error)}`,
      );
      return;
    }
    if (!this.validateMediaCapabilities(extraction)) return;
    let session = this.session;
    if (session === undefined) {
      if (!this.engineV2) {
        this.showError(LLM_NOT_SET_MESSAGE);
        return;
      }
      session = await this.ensureSession();
      if (session === undefined) return;
    }
    if (extraction.hasMedia) {
      this.sendMessage(session, text, {
        hasMedia: true,
        parts: extraction.parts,
        imageAttachmentIds: extraction.imageAttachmentIds,
      });
    } else {
      this.sendMessage(session, text);
    }
    this.updateQueueDisplay();
    this.state.ui.requestRender();
  }

  validateMediaCapabilities(extraction: {
    hasMedia: boolean;
    imageAttachmentIds: readonly number[];
    videoAttachmentIds: readonly number[];
  }): boolean {
    if (!extraction.hasMedia) return true;
    if (
      extraction.imageAttachmentIds.length > 0 &&
      !this.supportsCurrentModelCapability("image_in")
    ) {
      this.showError("Current model does not support image input.");
      return false;
    }
    if (
      extraction.videoAttachmentIds.length > 0 &&
      !this.supportsCurrentModelCapability("video_in")
    ) {
      this.showError("Current model does not support video input.");
      return false;
    }
    return true;
  }

  private supportsCurrentModelCapability(capability: string): boolean {
    const capabilities =
      this.state.appState.availableModels[this.state.appState.model]
        ?.capabilities;
    if (capabilities === undefined) return true;
    return capabilities.includes(capability);
  }

  private async loadPersistedInputHistory(): Promise<void> {
    try {
      const file = getInputHistoryFile(this.state.appState.workDir);
      const entries = await loadInputHistory(file);
      for (const entry of entries) {
        this.promptEditorState = reducePromptEditor(this.promptEditorState, {
          type: "history-add",
          text: entry.content,
        });
        if (!this.inkOwnsTerminal()) {
          this.state.editor.addToHistory(entry.content);
        }
      }
      this.lastHistoryContent = entries.at(-1)?.content;
    } catch {
      // best-effort
    }
  }

  private async persistInputHistory(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    if (trimmed === this.lastHistoryContent) return;
    this.promptEditorState = reducePromptEditor(this.promptEditorState, {
      type: "history-add",
      text: trimmed,
    });
    if (!this.inkOwnsTerminal()) {
      this.state.editor.addToHistory(trimmed);
    }
    try {
      const file = getInputHistoryFile(this.state.appState.workDir);
      const written = await appendInputHistory(
        file,
        trimmed,
        this.lastHistoryContent,
      );
      if (written) this.lastHistoryContent = trimmed;
    } catch {
      this.lastHistoryContent = trimmed;
    }
  }

  recallLastQueued(): QueuedMessage | undefined {
    if (this.state.queuedMessages.length === 0) return;
    const last = this.state.queuedMessages.at(-1)!;
    this.state.queuedMessages = this.state.queuedMessages.slice(0, -1);
    return last;
  }

  // =========================================================================
  // Session Requests / Queues
  // =========================================================================

  private enqueueMessage(
    text: string,
    options?: SendMessageOptions,
    mode?: "prompt" | "bash",
  ): void {
    this.state.queuedMessages.push({
      text,
      agentId: this.harness.interactiveAgentId,
      parts: options?.parts,
      imageAttachmentIds:
        options?.imageAttachmentIds !== undefined &&
        options.imageAttachmentIds.length > 0
          ? options.imageAttachmentIds
          : undefined,
      mode,
    });
    this.track("input_queue");
  }

  beginSessionRequest(): void {
    this.streamingUI.setTurnId(undefined);
    this.streamingUI.resetLiveText();
    this.streamingUI.resetToolUi();
    this.streamingUI.resetToolCallState();

    this.patchLivePane({
      mode: "waiting",
      pendingApproval: null,
      pendingQuestion: null,
    });
    this.setAppState({
      streamingPhase: "waiting",
      streamingStartTime: Date.now(),
    });
  }

  failSessionRequest(message: string): void {
    this.setAppState({ streamingPhase: "idle" });
    this.resetLivePane();
    this.showError(message);
  }

  sendQueuedMessage(session: Session, item: QueuedMessage): void {
    if (item.mode === "bash") {
      void this.runShellCommandFromInput(item.text);
      return;
    }
    this.harness.withInteractiveAgent(item.agentId ?? MAIN_AGENT_ID, () => {
      this.sendMessageInternal(session, item.text, {
        parts: item.parts,
        imageAttachmentIds: item.imageAttachmentIds,
      });
    });
  }

  requestQueuedGoalPromotion(): void {
    this.sessionEventHandler.requestQueuedGoalPromotion();
  }

  private sendMessageInternal(
    session: Session,
    input: string,
    options?: SendMessageOptions,
  ): void {
    const imageAttachmentIds =
      options?.imageAttachmentIds !== undefined &&
      options.imageAttachmentIds.length > 0
        ? options.imageAttachmentIds
        : undefined;
    this.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: "user",
      turnId: undefined,
      renderMode: "plain",
      content: input,
      imageAttachmentIds,
    });

    this.beginSessionRequest();

    const sdkInput = options?.parts ?? input;
    // While a goal is being pursued the engine holds its active turn across the
    // whole continuation loop, so a fresh prompt races the goal driver at every
    // continuation boundary and is rejected with `turn.agent_busy`, dropping
    // the message. Steer instead: the engine buffers it into the running goal
    // turn, or launches a turn of its own if the loop just ended.
    if (this.state.appState.goal?.status === "active") {
      void session.steer(sdkInput).catch((error: unknown) => {
        const message = formatErrorMessage(error);
        // Same reset as the prompt path: beginSessionRequest already moved the
        // TUI to the waiting phase, and no turn events may follow a failed
        // steer (e.g. the session is gone), which would leave the UI stuck
        // queueing input behind a request that never completes.
        this.failSessionRequest(`Failed to steer: ${message}`);
      });
      return;
    }
    void session.prompt(sdkInput).catch((error: unknown) => {
      const message = formatErrorMessage(error);
      this.failSessionRequest(`Failed to send: ${message}`);
    });
  }

  sendSkillActivation(
    session: Session,
    skillName: string,
    skillArgs: string,
  ): void {
    // Args are a plain-text channel, so pasted media can't ride along as
    // inline parts. Skill args are XML-escaped on render (renderSkillAttributes
    // + expandSkillParameters), so rewrite placeholders into escape-proof
    // plain-text file references the model can open with ReadMediaFile.
    let rewrite: ReturnType<typeof rewriteMediaPlaceholders>;
    try {
      rewrite = rewriteMediaPlaceholders(skillArgs, this.imageStore, "plain");
    } catch (error) {
      // Cache copy failed (unwritable cache dir, vanished video source…);
      // nothing has been dispatched yet, so just report and keep the input.
      this.showError(
        `Failed to prepare media attachment: ${formatErrorMessage(error)}`,
      );
      return;
    }
    if (!this.validateMediaCapabilities(rewrite)) return;
    this.beginSessionRequest();
    void session
      .activateSkill(skillName, rewrite.text)
      .catch((error: unknown) => {
        const message = formatErrorMessage(error);
        this.failSessionRequest(`Skill "${skillName}" failed: ${message}`);
      });
  }

  activatePluginCommand(
    session: Session,
    pluginId: string,
    commandName: string,
    args: string,
  ): void {
    // Plugin command args are expanded verbatim (no XML escaping), so the
    // standard <image|video path> tag convention works — see
    // sendSkillActivation for the escaped-channel variant.
    let rewrite: ReturnType<typeof rewriteMediaPlaceholders>;
    try {
      rewrite = rewriteMediaPlaceholders(args, this.imageStore, "tag");
    } catch (error) {
      this.showError(
        `Failed to prepare media attachment: ${formatErrorMessage(error)}`,
      );
      return;
    }
    if (!this.validateMediaCapabilities(rewrite)) return;
    this.beginSessionRequest();
    void session
      .activatePluginCommand(pluginId, commandName, rewrite.text)
      .catch((error: unknown) => {
        const message = formatErrorMessage(error);
        this.failSessionRequest(
          `Command "${pluginId}:${commandName}" failed: ${message}`,
        );
      });
  }

  private sendMessage(
    session: Session,
    input: string,
    options?: SendMessageOptions,
  ): void {
    if (
      this.deferUserMessages ||
      this.state.appState.streamingPhase !== "idle" ||
      this.state.appState.isCompacting
    ) {
      this.enqueueMessage(input, options);
      return;
    }
    this.sendMessageInternal(session, input, options);
  }

  steerMessage(session: Session, input: readonly SteerInputItem[]): void {
    if (this.deferUserMessages || this.state.appState.isCompacting) {
      for (const item of input) {
        this.enqueueMessage(item.text, item);
      }
      return;
    }
    if (this.state.appState.streamingPhase === "idle") {
      for (const item of input) {
        this.sendMessageInternal(session, item.text, item);
      }
      return;
    }

    for (const item of input) {
      this.appendTranscriptEntry({
        id: nextTranscriptId(),
        kind: "user",
        turnId: this.streamingUI.getTurnContext().turnId,
        renderMode: "plain",
        content: item.text,
        imageAttachmentIds:
          item.imageAttachmentIds !== undefined &&
          item.imageAttachmentIds.length > 0
            ? item.imageAttachmentIds
            : undefined,
      });
    }

    void session.steer(combineSteerInput(input)).catch((error: unknown) => {
      const message = formatErrorMessage(error);
      this.showError(`Failed to steer: ${message}`);
    });
  }

  // =========================================================================
  // State & Accessors
  // =========================================================================

  setStartupReady(): void {
    this.state.startupState = "ready";
    this.updateInkRenderer();
  }

  clearQueuedMessages(): void {
    this.state.queuedMessages = [];
    this.updateQueueDisplay();
    this.updateInkRenderer();
  }

  shiftQueuedMessage(): QueuedMessage | undefined {
    if (this.state.queuedMessages.length === 0) return;
    const [first, ...rest] = this.state.queuedMessages;
    this.state.queuedMessages = rest;
    this.updateQueueDisplay();
    this.updateInkRenderer();
    return first;
  }

  pushTranscriptEntry(entry: TranscriptEntry): void {
    this.state.transcriptEntries.push(entry);
    this.updateInkRenderer();
  }

  setExternalEditorRunning(running: boolean): void {
    this.state.externalEditorRunning = running;
    this.updateInkRenderer();
  }

  setTasksBrowser(value: TUIState["tasksBrowser"]): void {
    this.state.tasksBrowser = value;
  }

  appendStartupNotice(extra: string): void {
    this.startupNotice = combineStartupNotice(this.startupNotice, extra);
  }

  get backgroundTasks(): ReadonlyMap<string, BackgroundTaskInfo> {
    return this.sessionEventHandler.backgroundTasks;
  }

  getCurrentSessionId(): string {
    return this.state.appState.sessionId;
  }

  hasSessionContent(): boolean {
    return this.state.transcriptEntries.length > 0;
  }

  setExitOpenUrl(url: string): void {
    this.exitOpenUrl = url;
  }

  setExitForegroundTask(task: (exitCode: number) => Promise<void>): void {
    this.exitForegroundTask = task;
  }

  async getStartupMcpMs(): Promise<number> {
    const session = this.session;
    if (session === undefined) return 0;
    try {
      const metrics = await session.getMcpStartupMetrics();
      return metrics.durationMs;
    } catch {
      return 0;
    }
  }

  setAppState(patch: Partial<AppState>): void {
    if (!hasPatchChanges(this.state.appState, patch)) return;
    const additionalDirsChanged =
      "additionalDirs" in patch &&
      !sameStringArrays(
        this.state.appState.additionalDirs,
        patch.additionalDirs ?? [],
      );
    const busyChanged = "streamingPhase" in patch || "isCompacting" in patch;
    Object.assign(this.state.appState, patch);
    if ("planMode" in patch) this.updateEditorBorderHighlight();
    this.state.footer.setState(this.state.appState);
    this.updateActivityPane();
    if (busyChanged) {
      this.updateQueueDisplay();
      this.sessionEventHandler.retryQueuedGoalPromotion();
    }
    if (additionalDirsChanged) this.setupAutocomplete();
    this.state.ui.requestRender();
    this.updateInkRenderer();
  }

  patchLivePane(patch: Partial<LivePaneState>): void {
    if (!hasPatchChanges(this.state.livePane, patch)) return;
    Object.assign(this.state.livePane, patch);
    this.updateActivityPane();
    this.state.ui.requestRender();
    this.updateInkRenderer();
  }

  resetLivePane(): void {
    this.state.livePane = { ...INITIAL_LIVE_PANE };
    this.updateActivityPane();
    this.state.ui.requestRender();
    this.updateInkRenderer();
  }

  private syncAdditionalDirs(session: Session): void {
    const additionalDirs = session.summary?.additionalDirs ?? [];
    if (sameStringArrays(this.state.appState.additionalDirs, additionalDirs))
      return;
    this.setAppState({ additionalDirs: [...additionalDirs] });
  }

  // =========================================================================
  // Session Runtime
  // =========================================================================

  requireSession(): Session {
    if (this.session === undefined) {
      throw new Error(NO_ACTIVE_SESSION_MESSAGE);
    }
    return this.session;
  }

  /**
   * Seed appState with the config defaults the v2 engine would apply at
   * createSession time (model, permission, plan mode, thinking effort,
   * context cap), so the footer and the lazy create path reflect them while
   * no session exists. Runs at session-less startup and again on /reload
   * while still session-less, so externally edited defaults take effect
   * before the first lazy-created session.
   */
  async hydrateLazyConfigDefaults(): Promise<void> {
    const { startup } = this.options;
    const config = await this.harness.getConfig({ reload: true });
    const patch: Partial<AppState> = {};
    const startupModel = startup.model ?? config.defaultModel;
    if (startupModel !== undefined) {
      patch.model = startupModel;
      const selected = config.models?.[startupModel];
      if (selected?.maxContextSize !== undefined) {
        patch.maxContextTokens = selected.maxContextSize;
      }
    } else {
      // The default disappeared from config (edited externally): clear the
      // previously hydrated value instead of passing a stale explicit model
      // to the first lazy-created session.
      patch.model = "";
      patch.maxContextTokens = 0;
    }
    // CLI --auto/--yolo/--plan win over config defaults; the flags are
    // re-applied by applyStartupPermissionAndPlanToAppState at startup.
    if (!(startup.auto || startup.yolo)) {
      // Reset to manual when the default was removed from config — a stale
      // elevated mode must not be passed to the first lazy-created session.
      patch.permissionMode = config.defaultPermissionMode ?? "manual";
    }
    // Track the config default itself (vs an explicit CLI --plan) so the lazy
    // create path can tell which one would activate plan mode; a removed
    // default also clears the hydrated footer value.
    patch.configDefaultPlanMode = config.defaultPlanMode === true;
    if (!startup.plan) {
      patch.planMode = config.defaultPlanMode === true;
    }
    const effort = thinkingEffortFromConfig(config.thinking);
    if (effort !== undefined) {
      patch.thinkingEffort = effort;
    } else if (startupModel !== undefined) {
      // No concrete effort configured: mirror the engine, which resolves the
      // model's default effort at createSession time.
      const raw = config.models?.[startupModel];
      if (raw !== undefined) {
        const providerType = config.providers?.[raw.provider]?.type;
        patch.thinkingEffort = defaultThinkingEffortFor(
          effectiveModelAlias(raw, providerType ?? raw.protocol),
        );
      }
    }
    if (
      startup.agentProfile !== undefined ||
      startup.agentFiles !== undefined
    ) {
      patch.agentProfile = startup.agentProfile;
      patch.agentFiles = startup.agentFiles?.length
        ? [...startup.agentFiles]
        : undefined;
    }
    this.setAppState(patch);
  }

  private async createSessionFromCurrentState(
    bindStartupAgent = false,
  ): Promise<Session> {
    const model = this.state.appState.model.trim();
    if (model.length === 0) {
      throw new Error(LLM_NOT_SET_MESSAGE);
    }
    // With an active session, carry the live plan state. Session-less (lazy
    // creation / `/new` before the first session) on v2, pass only the
    // explicit CLI --plan intent — and only when the engine is not already
    // applying `defaultPlanMode` at create time (sessionLifecycleService),
    // since re-entering an active plan mode throws. On v1 (which never
    // pre-fills plan mode from config), keep the historical appState value.
    const explicitPlanMode =
      this.session !== undefined || !this.engineV2
        ? this.state.appState.planMode
        : this.options.startup.plan &&
          this.state.appState.configDefaultPlanMode !== true;
    const options: MutableCreateSessionOptions = {
      workDir: this.state.appState.workDir,
      model,
      // With an active session, carry the live effort. Session-less (lazy
      // creation / `/new` before the first session), carry the session-only
      // thinking override chosen via Alt+S if any — never the initial 'off'
      // default, which would force thinking off where the engine's config or
      // model default would apply.
      thinking:
        this.session === undefined
          ? this.state.appState.lazySessionThinking
          : this.state.appState.thinkingEffort,
      permission: this.state.appState.permissionMode,
      planMode: explicitPlanMode ? true : undefined,
    };
    if (this.state.appState.additionalDirs.length > 0) {
      options.additionalDirs = [...this.state.appState.additionalDirs];
    }
    if (bindStartupAgent) {
      // The --agent/--agent-file startup binding is consumed by the first
      // lazy-created session; `/new` sessions fall back to the default profile.
      if (this.state.appState.agentProfile !== undefined) {
        options.agentProfile = this.state.appState.agentProfile;
      }
      if (this.state.appState.agentFiles !== undefined) {
        options.agentFiles = [...this.state.appState.agentFiles];
      }
    }
    return this.harness.createSession(options);
  }

  /**
   * Lazy-create the session on first use (v2 engine, session-less startup).
   * Returns the existing session, or creates one from the current state and
   * runs the same assembly `createNewSession` performs. Returns undefined and
   * shows the error when creation fails; callers must still guard on
   * `appState.model`.
   *
   * Concurrent first-use triggers (a double Enter, or a slash command right
   * after a prompt) both observe `session === undefined`, so the first caller
   * owns the creation and the rest share the in-flight promise — otherwise
   * two sessions would be created and the later `setSession` would close the
   * first one mid-dispatch.
   */
  async ensureSession(): Promise<Session | undefined> {
    // Even when a session is already assigned, a previous lazy creation may
    // still be finishing its assembly (runtime sync, command refresh,
    // subscription). Wait for it so callers never dispatch against a
    // partially initialized session.
    if (this.ensureSessionPromise !== null) return this.ensureSessionPromise;
    if (this.session !== undefined) return this.session;
    this.ensureSessionPromise = this.lazyCreateSession().finally(() => {
      this.ensureSessionPromise = null;
    });
    return this.ensureSessionPromise;
  }

  /** Await the in-flight lazy session creation, if any (v2); no-op otherwise. */
  async waitForLazyCreation(): Promise<void> {
    await this.ensureSessionPromise;
  }

  private async lazyCreateSession(): Promise<Session | undefined> {
    let session: Session;
    try {
      session = await this.createSessionFromCurrentState(true);
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.showError(`Failed to start a session: ${msg}`);
      return;
    }
    this.resetSessionRuntime();
    await this.setSession(session);
    this.setAppState({ sessionId: session.id });
    try {
      await this.activateRuntime();
      await this.syncRuntimeState(session);
    } catch (error) {
      this.sessionEventHandler.startSubscription();
      const msg = formatErrorMessage(error);
      this.showError(`Post-create setup failed: ${msg}`);
      return;
    }
    try {
      await this.refreshSkillCommands(session);
      await this.refreshPluginCommands(session);
    } catch {
      /* keep the new session usable even if dynamic skills fail */
    }
    this.sessionEventHandler.startSubscription();
    void this.showSessionWarnings(session);
    // The session-only thinking override was consumed by this session; the
    // runtime status now owns the displayed effort.
    if (this.state.appState.lazySessionThinking !== undefined) {
      this.setAppState({ lazySessionThinking: undefined });
    }
    return session;
  }

  async setSession(session: Session): Promise<void> {
    const previous = this.unloadCurrentSession("switching session");
    await previous?.close();
    this.session = session;
    this.registerSessionHandlers(session);
    this.syncAdditionalDirs(session);
  }

  async syncRuntimeState(
    session: Session = this.requireSession(),
  ): Promise<void> {
    const [status, goalResult] = await Promise.all([
      session.getStatus(),
      session.getGoal(),
    ]);
    this.setAppState({
      sessionId: session.id,
      model: status.model ?? "",
      thinkingEffort: status.thinkingEffort,
      permissionMode: status.permission,
      planMode: status.planMode,
      swarmMode: status.swarmMode ?? false,
      contextTokens: status.contextTokens,
      maxContextTokens: status.maxContextTokens,
      contextUsage: status.contextUsage,
      sessionTitle: session.summary?.title ?? null,
      goal: goalResult.goal,
    });
    this.syncAdditionalDirs(session);
  }

  // Apply --auto/--yolo/--plan startup flags to a resumed session. The resumed
  // session may already be in plan mode from its persisted records, and
  // re-entering plan mode throws, so only enable it when it is not active yet.
  // setPermission is idempotent and needs no such guard.
  private async applyStartupModesToResumedSession(
    session: Session,
  ): Promise<void> {
    const { startup } = this.options;
    if (startup.auto) {
      await session.setPermission("auto");
    } else if (startup.yolo) {
      await session.setPermission("yolo");
    }
    if (startup.plan) {
      const status = await session.getStatus();
      if (!status.planMode) {
        await session.setPlanMode(true);
      }
    }
  }

  // Re-apply startup flags that the user explicitly passed on the command line.
  // syncRuntimeState and session-replay hydration can both read stale persisted
  // values, so this guarantees the footer reflects the CLI intent.
  private applyStartupPermissionAndPlanToAppState(): void {
    const { startup } = this.options;
    if (startup.auto) {
      this.setAppState({ permissionMode: "auto" });
    } else if (startup.yolo) {
      this.setAppState({ permissionMode: "yolo" });
    }
    if (startup.plan) {
      this.setAppState({ planMode: true });
    }
  }

  // Plan mode is set by createSession — do not re-enter it here.
  private async activateRuntime(): Promise<void> {
    const session = this.requireSession();
    await session.setPermission(this.state.appState.permissionMode);
    await this.syncRuntimeState(session);
  }

  async closeSession(reason: string): Promise<void> {
    const previous = this.unloadCurrentSession(reason);
    await previous?.close();
  }

  private unloadCurrentSession(reason: string): Session | undefined {
    const previous = this.session;
    this.sessionEventUnsubscribe?.();
    this.sessionEventUnsubscribe = undefined;
    this.clearReverseRpcPanels();
    previous?.setApprovalHandler(undefined);
    previous?.setQuestionHandler(undefined);
    this.approvalController.cancelAll(reason);
    this.questionController.cancelAll(reason);
    this.session = undefined;
    this.state.swarmModeEntry = undefined;
    this.setAppState({ goal: null });
    return previous;
  }

  private clearReverseRpcPanels(): void {
    for (const dispose of this.reverseRpcDisposers) {
      dispose();
    }
    this.reverseRpcDisposers.length = 0;
  }

  private registerSessionHandlers(session: Session): void {
    session.setApprovalHandler(
      createApprovalRequestHandler(
        this.approvalController,
        (request, response) => {
          this.appendApprovalTranscriptEntry(request, response);
        },
      ),
    );
    session.setQuestionHandler(
      createQuestionAskHandler(this.questionController),
    );
  }

  async fetchSessions(
    scope: "cwd" | "all" = this.state.sessionsScope,
  ): Promise<void> {
    this.state.loadingSessions = true;
    this.state.sessionsScope = scope;
    try {
      const sessions =
        scope === "all"
          ? await this.harness.listSessions({})
          : await this.harness.listSessions({
              workDir: this.state.appState.workDir,
            });
      this.state.sessions = sessionRowsForPicker(
        sessions,
        this.state.appState.sessionId,
        this.hasSessionContent(),
      );
    } catch (error) {
      // The picker must keep working (it renders the empty state), but a
      // swallowed failure surfaces as a misleading "No sessions found." —
      // keep a log trail so the real error stays discoverable.
      log.warn("failed to fetch sessions for picker", { error: String(error) });
    } finally {
      this.state.loadingSessions = false;
    }
  }

  updateTerminalTitle(): void {
    const trimmed = this.state.appState.sessionTitle?.trim() ?? "";
    const label =
      trimmed.length > 0
        ? trimmed.slice(0, MAX_TERMINAL_TITLE_LENGTH)
        : PRODUCT_NAME;
    this.state.terminal.setTitle(label);
  }

  resetSessionRuntime(): void {
    this.aborted = false;
    this.streamingUI.discardPending();
    this.state.queuedMessages = [];
    this.state.swarmModeEntry = undefined;
    this.streamingUI.resetToolCallState();
    this.streamingUI.resetToolUi();
    this.sessionEventHandler.resetRuntimeState();
    this.tasksBrowserController.close();
    this.btwPanelController.clear();
    this.state.footer.setBackgroundCounts({ bashTasks: 0, agentTasks: 0 });
    this.streamingUI.setTodoList([]);
    this.streamingUI.setTurnId(undefined);
    this.setAppState({ mcpServersSummary: null });
    this.streamingUI.setStep(0);
    this.streamingUI.resetLiveText();
    this.updateQueueDisplay();
  }

  private async showResumeOtherWorkDirHint(session: SessionRow): Promise<void> {
    this.hideSessionPicker();
    const command = `cd ${quoteShellArg(session.work_dir)} && kimi --resume ${quoteShellArg(session.id)}`;
    const message = `Current session is in a different working directory.\n  To resume, run: ${command}`;
    try {
      await copyTextToClipboard(command);
      this.showStatus(`${message}\n  Command copied to clipboard`, "warning");
    } catch {
      this.showStatus(
        `${message}\n  Failed to copy command to clipboard`,
        "warning",
      );
    }
  }

  private async resumeSession(targetSessionId: string): Promise<boolean> {
    // A first-use lazy creation may still be in flight: wait it out so the
    // checks below see settled state — the pending prompt would otherwise
    // replace the resumed session when creation completes.
    await this.waitForLazyCreation();
    if (targetSessionId === this.state.appState.sessionId) {
      this.showStatus("Already on this session.");
      return true;
    }
    if (this.state.appState.streamingPhase !== "idle") {
      this.showError(
        "Cannot switch sessions while streaming — press Esc or Ctrl-C first.",
      );
      return false;
    }
    if (this.state.appState.isReplaying) {
      this.showError("Cannot switch sessions while history is replaying.");
      return false;
    }

    let session: Session;
    try {
      session = await this.harness.resumeSession({
        id: targetSessionId,
        replayTurnLimit: REPLAY_TURN_LIMIT,
      });
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.showError(`Failed to resume session ${targetSessionId}: ${msg}`);
      return false;
    }

    await this.switchToSession(session, `Resumed session (${session.id}).`);
    return true;
  }

  async switchToSession(
    session: Session,
    statusMessage: string,
  ): Promise<void> {
    this.resetSessionRuntime();
    await this.setSession(session);
    await this.syncRuntimeState(session);
    this.updateTerminalTitle();
    try {
      await this.refreshSkillCommands(this.session);
      await this.refreshPluginCommands(this.session);
    } catch {
      /* keep the switched session usable even if dynamic skills fail */
    }
    this.clearTranscriptAndRedraw();
    try {
      await this.sessionReplay.hydrateFromReplay(session);
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.showError(`Failed to replay session history: ${msg}`);
    } finally {
      this.sessionEventHandler.startSubscription();
    }
    const resumeState = session.getResumeState();
    if (resumeState?.warning !== undefined) {
      this.showStatus(`Warning: ${resumeState.warning}`, "warning");
    }
    this.showStatus(statusMessage);
    void this.showSessionWarnings(session);
  }

  async reloadCurrentSessionView(
    session: Session,
    statusMessage: string,
  ): Promise<void> {
    this.sessionEventUnsubscribe?.();
    this.sessionEventUnsubscribe = undefined;
    this.clearReverseRpcPanels();
    session.setApprovalHandler(undefined);
    session.setQuestionHandler(undefined);
    this.approvalController.cancelAll("reloading session");
    this.questionController.cancelAll("reloading session");

    this.resetSessionRuntime();
    this.session = session;
    this.registerSessionHandlers(session);
    await this.syncRuntimeState(session);
    this.updateTerminalTitle();
    try {
      await this.refreshSkillCommands(session);
      await this.refreshPluginCommands(session);
    } catch {
      /* keep the reloaded session usable even if dynamic skills fail */
    }
    this.sessionEventHandler.startSubscription();
    const resumeState = session.getResumeState();
    if (resumeState?.warning !== undefined) {
      this.showStatus(`Warning: ${resumeState.warning}`, "warning");
    }
    this.showStatus(statusMessage);
    void this.showSessionWarnings(session);
  }

  async createNewSession(): Promise<void> {
    if (this.state.appState.isReplaying) {
      this.showError("Cannot start a new session while history is replaying.");
      return;
    }

    let session: Session;
    try {
      session = await this.createSessionFromCurrentState();
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.showError(`Failed to start a new session: ${msg}`);
      return;
    }

    this.resetSessionRuntime();
    await this.setSession(session);
    this.setAppState({ sessionId: session.id });
    try {
      await this.activateRuntime();
      await this.syncRuntimeState(session);
    } catch (error) {
      this.sessionEventHandler.startSubscription();
      const msg = formatErrorMessage(error);
      this.showError(`Post-create setup failed: ${msg}`);
      return;
    }
    try {
      await this.refreshSkillCommands(this.session);
      await this.refreshPluginCommands(this.session);
    } catch {
      /* keep the new session usable even if dynamic skills fail */
    }
    this.sessionEventHandler.startSubscription();
    this.clearTranscriptAndRedraw();
    this.showStatus(`Started a new session (${session.id}).`);
    void this.showSessionWarnings(session);
    void this.showConfigWarningsIfAny();
  }

  /** Surface config.toml load warnings (degraded or kept-previous config) in the status bar. */
  private async showConfigWarningsIfAny(): Promise<void> {
    try {
      const { warnings } = await this.harness.getConfigDiagnostics();
      for (const warning of warnings) {
        this.showStatus(warning, "warning");
      }
    } catch {
      /* diagnostics are best-effort */
    }
  }

  // =========================================================================
  // Transcript Rendering
  // =========================================================================

  private createTranscriptComponent(entry: TranscriptEntry): Component | null {
    if (entry.compactionData !== undefined) {
      const data = entry.compactionData;
      const block = new CompactionComponent(this.state.ui, data.instruction);
      if (data.result === "cancelled") {
        block.markCanceled();
      } else {
        block.markDone(data.tokensBefore, data.tokensAfter, data.summary);
        if (this.state.toolOutputExpanded) {
          block.setExpanded(true);
        }
      }
      return block;
    }

    switch (entry.kind) {
      case "user": {
        const images = entry.imageAttachmentIds
          ?.map((id) => this.imageStore.get(id))
          .filter((a): a is ImageAttachment => a?.kind === "image");
        return new UserMessageComponent(entry.content, images, entry.bullet);
      }
      case "skill_activation":
        return new SkillActivationComponent(
          entry.skillName ?? entry.content,
          entry.skillArgs,
          entry.skillTrigger,
        );
      case "plugin_command": {
        const data = entry.pluginCommandData;
        if (data === undefined) return null;
        return new PluginCommandComponent(
          data.pluginId,
          data.commandName,
          data.args,
        );
      }
      case "cron":
        return new CronMessageComponent(entry.content, entry.cronData ?? {});
      case "goal":
        if (entry.goalData?.kind === "created") {
          return new GoalSetMessageComponent();
        }
        if (entry.goalData?.kind === "lifecycle") {
          return buildGoalMarker(
            entry.goalData.change,
            this.state.toolOutputExpanded,
          );
        }
        return null;
      case "assistant": {
        if (entry.content.trimStart().startsWith("✓ Goal complete")) {
          return new GoalCompletionMessageComponent(entry.content);
        }
        const component = new AssistantMessageComponent();
        component.updateContent(entry.content);
        return component;
      }
      case "thinking": {
        const thinking = new ThinkingComponent(entry.content, true);
        if (this.state.toolOutputExpanded) thinking.setExpanded(true);
        return thinking;
      }
      case "tool_call":
        if (entry.toolCallData) {
          const tc = new ToolCallComponent(
            entry.toolCallData,
            entry.toolCallData.result,
            this.state.ui,
            this.state.appState.workDir,
          );
          if (this.state.toolOutputExpanded) tc.setExpanded(true);
          return tc;
        }
        if (entry.backgroundAgentStatus !== undefined) {
          return new BackgroundAgentStatusComponent(
            entry.backgroundAgentStatus,
          );
        }
        return entry.renderMode === "notice"
          ? new NoticeMessageComponent(entry.content, entry.detail)
          : new StatusMessageComponent(entry.content, entry.color);
      case "status":
        if (entry.backgroundAgentStatus !== undefined) {
          return new BackgroundAgentStatusComponent(
            entry.backgroundAgentStatus,
          );
        }
        return entry.renderMode === "notice"
          ? new NoticeMessageComponent(entry.content, entry.detail)
          : new StatusMessageComponent(entry.content, entry.color);
      case "welcome":
        return null;
      default:
        return null;
    }
  }

  appendTranscriptEntry(entry: TranscriptEntry): void {
    this.state.transcriptEntries.push(entry);
    const component = this.createTranscriptComponent(entry);
    if (component) {
      markTranscriptComponent(component, entry);
      this.state.transcriptContainer.addChild(component);
    }
    const trimmed = this.trimTranscriptWindow();
    const merged = this.mergeCurrentTurnSteps();
    if (component || trimmed || merged) {
      this.state.ui.requestRender();
    }
    this.updateInkRenderer();
  }

  private appendApprovalTranscriptEntry(
    request: ApprovalRequest,
    response: ApprovalResponse,
  ): void {
    if (
      request.toolName === "ExitPlanMode" ||
      request.display.kind === "plan_review" ||
      request.display.kind === "goal_start"
    )
      return;
    const parts: string[] = [];
    switch (response.decision) {
      case "approved":
        parts.push(
          response.scope === "session" ? "Approved for session" : "Approved",
        );
        break;
      case "rejected":
        parts.push("Rejected");
        break;
      case "cancelled":
        parts.push("Cancelled");
        break;
    }
    parts.push(`: ${request.action}`);
    if (response.feedback !== undefined && response.feedback.length > 0) {
      parts.push(` — "${response.feedback}"`);
    }
    this.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: "status",
      turnId: request.turnId === undefined ? undefined : String(request.turnId),
      renderMode: "notice",
      content: parts.join(""),
    });
  }

  private renderWelcome(): void {
    if (
      this.state.transcriptContainer.children.some(
        (child) => child instanceof WelcomeComponent,
      )
    ) {
      return;
    }
    const welcome = new WelcomeComponent(this.state.appState);
    this.state.transcriptContainer.addChild(welcome);
  }

  private clearTerminalInlineImages(): void {
    if (getCapabilities().images !== "kitty") return;
    this.state.terminal.write(deleteAllKittyImages());
  }

  private disposeTranscriptChildren(): void {
    // Dispose disposable children (e.g. ShellRunComponent's 1s timer,
    // ThinkingComponent's spinner) before dropping them, so a /clear, session
    // switch, or shutdown can't leak intervals that keep firing requestRender
    // on a removed component.
    for (const child of this.state.transcriptContainer.children) {
      if (hasDispose(child)) child.dispose();
    }
  }

  private clearTranscriptAndRedraw(): void {
    this.streamingUI.discardPending();
    this.state.transcriptEntries = [];
    this.streamingUI.disposeActiveCompactionBlock();
    this.streamingUI.resetLiveText();
    this.streamingUI.resetToolUi();
    this.sessionEventHandler.stopAllMcpServerStatusSpinners();
    this.disposeTranscriptChildren();
    this.state.transcriptContainer.clear();
    this.btwPanelController.clear();
    this.clearTerminalInlineImages();
    this.state.todoPanel.clear();
    this.state.todoPanelContainer.clear();
    this.imageStore.clear();
    this.renderWelcome();
    this.updateInkRenderer();
    // No forced full render on session reset: let the differential renderer
    // converge on its own (a mass change above the viewport still makes the
    // engine repaint everything, but nothing is forced destructively here).
    this.state.ui.requestRender();
  }

  private isTurnBoundaryComponent(child: Component): boolean {
    if (
      !(
        child instanceof UserMessageComponent ||
        child instanceof SkillActivationComponent ||
        child instanceof PluginCommandComponent ||
        child instanceof ReplayTurnBoundaryComponent
      )
    ) {
      return false;
    }
    const entry = getTranscriptComponentEntry(child);
    if (entry === undefined) return false;
    // Live user messages / slash activations have an undefined turnId; replayed
    // ones get a `replay:N` turnId. Both start a new turn. Steer messages carry
    // a defined non-replay turnId and are not boundaries.
    return entry.turnId === undefined || entry.turnId.startsWith("replay:");
  }

  private trimTranscriptWindow(): boolean {
    if (!TRANSCRIPT_WINDOW_ENABLED || TRANSCRIPT_MAX_TURNS <= 0) return false;
    // Session replay already caps history to its own turn limit; trimming during
    // replay would shrink it further and fight that limit.
    if (this.state.appState.isReplaying) return false;

    const children = this.state.transcriptContainer.children;

    // Trim whole turns by *position* in the child list rather than by entry
    // lookup — otherwise only the (registered) user message would be removed and
    // the rest of the turn would be left behind.
    const boundaries: number[] = [];
    for (let i = 0; i < children.length; i++) {
      if (this.isTurnBoundaryComponent(children[i]!)) boundaries.push(i);
    }

    const turns = groupTurns(this.state.transcriptEntries);

    const toRemove = turnsToTrim(
      turns,
      TRANSCRIPT_MAX_TURNS,
      TRANSCRIPT_HYSTERESIS,
    );
    if (toRemove.size === 0) return false;

    // Reclaim image bytes referenced by trimmed user messages. The transcript
    // renders historical thumbnails via imageStore.get(id), so an attachment can
    // only be dropped once its owning user message leaves the transcript.
    for (const entry of toRemove) {
      if (entry.kind === "user" && entry.imageAttachmentIds !== undefined) {
        this.imageStore.removeMany(entry.imageAttachmentIds);
      }
    }

    let boundariesToRemove = 0;
    for (const entry of toRemove) {
      if (
        (entry.kind === "user" ||
          entry.kind === "skill_activation" ||
          entry.kind === "plugin_command") &&
        entry.turnId === undefined
      ) {
        boundariesToRemove++;
      }
    }
    if (boundariesToRemove === 0) {
      this.state.transcriptEntries = this.state.transcriptEntries.filter(
        (e) => !toRemove.has(e),
      );
      return true;
    }

    let boundariesSeen = 0;
    let cutoff = 0;
    for (let i = 0; i < children.length; i++) {
      if (this.isTurnBoundaryComponent(children[i]!)) {
        if (boundariesSeen === boundariesToRemove) {
          cutoff = i;
          break;
        }
        boundariesSeen++;
      }
    }

    const componentsToRemove: Component[] = [];
    for (let i = 0; i < cutoff; i++) {
      const child = children[i]!;
      if (child instanceof WelcomeComponent) continue;
      componentsToRemove.push(child);
    }
    for (const child of componentsToRemove) {
      // kimi-tui Container.removeChild (not a DOM node); `child.remove()` does not exist.
      // oxlint-disable-next-line unicorn/prefer-dom-node-remove
      this.state.transcriptContainer.removeChild(child);
      if (hasDispose(child)) child.dispose();
    }

    this.state.transcriptEntries = this.state.transcriptEntries.filter(
      (e) => !toRemove.has(e),
    );
    return true;
  }

  mergeCurrentTurnSteps(): boolean {
    return this.foldCurrentTurnContent(
      TRANSCRIPT_KEEP_RECENT_STEPS,
      TRANSCRIPT_KEEP_RECENT_ASSISTANT,
    );
  }

  /**
   * Fold the just-finished turn's assistant messages down to the completed-turn
   * cap: while a turn is live it may keep TRANSCRIPT_KEEP_RECENT_ASSISTANT
   * messages mounted, but once it ends only the conclusion-bearing tail stays.
   * Called when a turn finishes; the finished turn is still the current one at
   * that point (no newer boundary exists yet).
   */
  mergeCompletedTurnAssistants(): boolean {
    return this.foldCurrentTurnContent(
      TRANSCRIPT_KEEP_RECENT_STEPS,
      TRANSCRIPT_KEEP_RECENT_ASSISTANT_COMPLETED,
    );
  }

  private foldCurrentTurnContent(
    keepSteps: number,
    keepAssistants: number,
  ): boolean {
    if (keepSteps <= 0 && keepAssistants <= 0) return false;
    const children = this.state.transcriptContainer.children;

    // Find the start of the current turn (last turn-starting user message).
    let turnStart = -1;
    for (let i = children.length - 1; i >= 0; i--) {
      if (this.isTurnBoundaryComponent(children[i]!)) {
        turnStart = i;
        break;
      }
    }
    if (turnStart < 0) return false;

    // Locate an existing summary, the assistant messages, and the mergeable steps.
    let summaryIndex = -1;
    const stepIndices: number[] = [];
    const assistantIndices: number[] = [];
    for (let i = turnStart + 1; i < children.length; i++) {
      const child = children[i]!;
      if (child instanceof StepSummaryComponent) {
        summaryIndex = i;
        continue;
      }
      if (child instanceof AssistantMessageComponent) {
        assistantIndices.push(i);
        continue;
      }
      stepIndices.push(i);
    }

    // Fold the oldest steps / assistant messages beyond their respective caps;
    // the most recent ones stay mounted. Children are chronological, so the
    // oldest of each kind sit at the front of their index lists.
    const stepMergeCount =
      keepSteps > 0 ? Math.max(0, stepIndices.length - keepSteps) : 0;
    const assistantMergeCount =
      keepAssistants > 0
        ? Math.max(0, assistantIndices.length - keepAssistants)
        : 0;
    if (stepMergeCount === 0 && assistantMergeCount === 0) return false;
    const toMergeIndices = [
      ...stepIndices.slice(0, stepMergeCount),
      ...assistantIndices.slice(0, assistantMergeCount),
    ];

    let thinkingCount = 0;
    let toolCount = 0;
    for (const idx of toMergeIndices) {
      const child = children[idx]!;
      if (child instanceof ThinkingComponent) thinkingCount++;
      else if (child instanceof ToolCallComponent) toolCount++;
    }
    if (thinkingCount === 0 && toolCount === 0 && assistantMergeCount === 0)
      return false;

    let summary: StepSummaryComponent;
    if (summaryIndex >= 0) {
      summary = children[summaryIndex] as StepSummaryComponent;
      summary.addCounts(thinkingCount, toolCount, assistantMergeCount);
    } else {
      summary = new StepSummaryComponent();
      summary.addCounts(thinkingCount, toolCount, assistantMergeCount);
    }

    // Rebuild children: keep everything except the merged steps, with the summary
    // sitting right after the user message.
    const toMergeSet = new Set(toMergeIndices);
    const newChildren: Component[] = [];
    for (let i = 0; i <= turnStart; i++) newChildren.push(children[i]!);
    newChildren.push(summary);
    for (let i = turnStart + 1; i < children.length; i++) {
      if (i === summaryIndex) continue;
      if (toMergeSet.has(i)) continue;
      newChildren.push(children[i]!);
    }

    for (const idx of toMergeIndices) {
      const child = children[idx]!;
      if (hasDispose(child)) child.dispose();
    }

    children.splice(0, children.length, ...newChildren);
    return true;
  }

  mergeAllTurnSteps(): void {
    if (
      TRANSCRIPT_KEEP_RECENT_STEPS <= 0 &&
      TRANSCRIPT_KEEP_RECENT_ASSISTANT_COMPLETED <= 0
    )
      return;
    const children = this.state.transcriptContainer.children;

    const boundaries: number[] = [];
    for (let i = 0; i < children.length; i++) {
      if (this.isTurnBoundaryComponent(children[i]!)) boundaries.push(i);
    }
    if (boundaries.length === 0) return;

    const newChildren: Component[] = [];
    const toDispose: Component[] = [];
    for (let i = 0; i < boundaries[0]!; i++) newChildren.push(children[i]!);

    for (let t = 0; t < boundaries.length; t++) {
      const turnStart = boundaries[t]!;
      const turnEnd =
        t + 1 < boundaries.length ? boundaries[t + 1]! : children.length;
      newChildren.push(children[turnStart]!);

      let summaryIndex = -1;
      const stepIndices: number[] = [];
      const assistantIndices: number[] = [];
      for (let i = turnStart + 1; i < turnEnd; i++) {
        const child = children[i]!;
        if (child instanceof StepSummaryComponent) summaryIndex = i;
        else if (child instanceof AssistantMessageComponent)
          assistantIndices.push(i);
        else stepIndices.push(i);
      }

      const stepMergeCount =
        TRANSCRIPT_KEEP_RECENT_STEPS > 0
          ? Math.max(0, stepIndices.length - TRANSCRIPT_KEEP_RECENT_STEPS)
          : 0;
      // Replayed turns are all completed turns, so the stricter completed-turn
      // assistant cap applies (matching what live turns fold to on turn end).
      const assistantMergeCount =
        TRANSCRIPT_KEEP_RECENT_ASSISTANT_COMPLETED > 0
          ? Math.max(
              0,
              assistantIndices.length -
                TRANSCRIPT_KEEP_RECENT_ASSISTANT_COMPLETED,
            )
          : 0;
      if (stepMergeCount > 0 || assistantMergeCount > 0) {
        const toMergeIndices = [
          ...stepIndices.slice(0, stepMergeCount),
          ...assistantIndices.slice(0, assistantMergeCount),
        ];
        let thinkingCount = 0;
        let toolCount = 0;
        for (const idx of toMergeIndices) {
          const child = children[idx]!;
          if (child instanceof ThinkingComponent) thinkingCount++;
          else if (child instanceof ToolCallComponent) toolCount++;
        }
        let summary: StepSummaryComponent;
        if (summaryIndex >= 0) {
          summary = children[summaryIndex] as StepSummaryComponent;
          summary.addCounts(thinkingCount, toolCount, assistantMergeCount);
        } else {
          summary = new StepSummaryComponent();
          summary.addCounts(thinkingCount, toolCount, assistantMergeCount);
        }
        newChildren.push(summary);
        for (const idx of toMergeIndices) toDispose.push(children[idx]!);
        const toMergeSet = new Set(toMergeIndices);
        for (let i = turnStart + 1; i < turnEnd; i++) {
          if (i === summaryIndex) continue;
          if (toMergeSet.has(i)) continue;
          newChildren.push(children[i]!);
        }
      } else {
        for (let i = turnStart + 1; i < turnEnd; i++)
          newChildren.push(children[i]!);
      }
    }

    for (const child of toDispose) {
      if (hasDispose(child)) child.dispose();
    }
    children.splice(0, children.length, ...newChildren);
  }

  showStatus(message: string, color?: ColorToken): void {
    this.state.transcriptContainer.addChild(
      new StatusMessageComponent(message, color),
    );
    this.state.ui.requestRender();
  }

  showNotice(title: string, detail?: string): void {
    this.state.transcriptContainer.addChild(
      new NoticeMessageComponent(title, detail),
    );
    this.state.ui.requestRender();
  }

  showError(message: string): void {
    this.showStatus(`Error: ${message}`, "error");
  }

  showLoginProgressSpinner(label: string): LoginProgressSpinnerHandle {
    return this.showProgressSpinner(label);
  }

  showProgressSpinner(label: string): LoginProgressSpinnerHandle {
    const tint = (s: string): string => currentTheme.fg("primary", s);
    const spinner = new MoonLoader(this.state.ui, "braille", tint, label);
    this.state.transcriptContainer.addChild(new Spacer(1));
    this.state.transcriptContainer.addChild(spinner);
    this.state.ui.requestRender();
    return {
      stop: ({ ok, label: finalLabel }) => {
        spinner.stop();
        const tone = ok ? "success" : "error";
        const symbol = ok ? "✓" : "✗";
        spinner.setText(currentTheme.fg(tone, `${symbol} ${finalLabel}`));
        this.state.ui.requestRender();
      },
      setLabel: (nextLabel) => {
        spinner.setLabel(nextLabel);
      },
    };
  }

  showLoginAuthorizationPrompt(
    auth: DeviceAuthorization,
  ): LoginProgressSpinnerHandle {
    openUrl(auth.verificationUriComplete);
    this.state.transcriptContainer.addChild(
      new DeviceCodeBoxComponent({
        title: "Sign in to Kimi Code",
        url: auth.verificationUriComplete,
        code: auth.userCode,
        hint: "Press Ctrl-C to cancel",
      }),
    );
    this.state.ui.requestRender();
    return this.showLoginProgressSpinner("Waiting for authorization…");
  }

  // =========================================================================
  // Panes / Presentation State
  // =========================================================================

  updateActivityPane(): void {
    const effectiveMode = this.resolveActivityPaneMode();
    const tipKind = loadingTipKind(effectiveMode);
    // Pick a fresh loading tip when the loading kind changes. The same kind
    // covers waiting/tool (both moon spinners) and any intermediate thinking
    // phase, so a continuous burst of tool calls does not flip tips. Clear the
    // cache only when there is no loading UI at all.
    if (
      effectiveMode === "idle" ||
      effectiveMode === "session" ||
      effectiveMode === "hidden"
    ) {
      this.currentLoadingTip = undefined;
    } else if (
      tipKind !== undefined &&
      (this.currentLoadingTip === undefined ||
        this.currentLoadingTip.kind !== tipKind)
    ) {
      const previousTip = this.currentLoadingTip?.tip;
      this.currentLoadingTip = {
        kind: tipKind,
        tip: pickRandomWorkingTip(previousTip)?.text,
      };
    }
    this.syncTerminalProgress(this.shouldShowTerminalProgress(effectiveMode));
    const placeSpinnerInAgentSwarm =
      this.shouldPlaceActivitySpinnerInAgentSwarm(effectiveMode);
    const activityModeKey = `${effectiveMode}:${placeSpinnerInAgentSwarm ? "swarm" : "pane"}`;

    if (
      activityModeKey === this.lastActivityMode &&
      (effectiveMode === "waiting" ||
        effectiveMode === "thinking" ||
        effectiveMode === "tool")
    ) {
      if (placeSpinnerInAgentSwarm) {
        this.syncAgentSwarmActivitySpinner(
          this.state.activitySpinner?.instance,
        );
      }
      this.updateInkRenderer();
      return;
    }

    this.lastActivityMode = activityModeKey;
    this.state.activityContainer.clear();

    switch (effectiveMode) {
      case "hidden":
        this.stopActivitySpinner();
        this.syncAgentSwarmActivitySpinner(undefined);
        this.state.ui.requestRender();
        this.updateInkRenderer();
        return;
      case "waiting": {
        const spinner = this.ensureActivitySpinner("moon");
        this.syncAgentSwarmActivitySpinner(
          placeSpinnerInAgentSwarm ? spinner : undefined,
        );
        if (placeSpinnerInAgentSwarm) break;
        this.state.activityContainer.addChild(
          new ActivityPaneComponent({
            mode: "waiting",
            spinner,
            tip: this.currentLoadingTip?.tip,
          }),
        );
        break;
      }
      case "thinking": {
        this.stopActivitySpinner();
        this.syncAgentSwarmActivitySpinner(undefined);
        break;
      }
      case "composing": {
        const spinner = this.ensureActivitySpinner(
          "braille",
          "working...",
          (s) => currentTheme.fg("primary", s),
        );
        this.syncAgentSwarmActivitySpinner(undefined);
        this.state.activityContainer.addChild(
          new ActivityPaneComponent({
            mode: "composing",
            spinner,
            tip: this.currentLoadingTip?.tip,
          }),
        );
        break;
      }
      case "tool": {
        const spinner = this.ensureActivitySpinner("moon");
        this.syncAgentSwarmActivitySpinner(
          placeSpinnerInAgentSwarm ? spinner : undefined,
        );
        if (placeSpinnerInAgentSwarm) break;
        this.state.activityContainer.addChild(
          new ActivityPaneComponent({
            mode: "tool",
            spinner,
            tip: this.currentLoadingTip?.tip,
          }),
        );
        break;
      }
      case "idle":
      case "session": {
        this.stopActivitySpinner();
        this.syncAgentSwarmActivitySpinner(undefined);
        // Keep a placeholder row so the activity area does not fully shrink
        // when the spinner is removed at the end of streaming; combined with
        // kimi-tui's clamp, this avoids a destructive full redraw (viewport jump).
        this.state.activityContainer.addChild(new Spacer(1));
        break;
      }
    }
    this.state.ui.requestRender();
    this.updateInkRenderer();
  }

  private resolveActivityPaneMode(): EffectiveActivityPaneMode {
    return resolveTerminalActivityMode(this.state);
  }

  updateQueueDisplay(): void {
    this.state.queueContainer.clear();
    const queued = this.state.queuedMessages;
    if (queued.length === 0) {
      this.updateInkRenderer();
      return;
    }

    this.state.queueContainer.addChild(
      new QueuePaneComponent({
        messages: queued,
        isCompacting: this.state.appState.isCompacting,
        isStreaming: this.state.appState.streamingPhase !== "idle",
        canSteerImmediately: !this.deferUserMessages,
      }),
    );
    this.updateInkRenderer();
  }

  /** Snapshot terminal data for renderer implementations without UI objects. */
  getTerminalViewState(): TerminalViewState {
    if (this.terminalRenderer === "kimi-tui") {
      this.syncPromptEditorFromLegacy();
    }
    const helpCommands: readonly TerminalHelpCommandView[] =
      this.getSlashCommands().map((command) => ({
        name: command.name,
        aliases: [...command.aliases],
        description: command.description,
      }));
    const sessions: readonly TerminalSessionView[] = this.state.sessions.map(
      (session) => ({
        id: session.id,
        title: session.title,
        lastPrompt: session.last_prompt ?? null,
        workDir: session.work_dir,
        updatedAt: session.updated_at,
      }),
    );
    return createTerminalViewState({
      appState: this.state.appState,
      startupState: this.state.startupState,
      transcriptEntries: this.state.transcriptEntries,
      livePane: this.state.livePane,
      queuedMessages: this.state.queuedMessages,
      editor: {
        text: this.promptEditorState.text,
        cursorLine: promptEditorLineColumn(this.promptEditorState).line,
        cursorColumn: promptEditorLineColumn(this.promptEditorState).column,
        inputMode: this.promptEditorState.inputMode,
        autocomplete: this.promptEditorState.completion?.items ?? [],
      },
      activeDialog: this.state.activeDialog,
      dialogSelectedIndex: this.inkOverlay.dialogSelectedIndex,
      dialogScrollTop: this.inkOverlay.dialogScrollTop,
      approvalFeedbackMode: this.inkOverlay.approvalFeedbackMode,
      approvalFeedbackText: this.inkOverlay.approvalFeedbackText,
      questionOtherMode: this.inkOverlay.questionOtherMode,
      questionOtherText: this.inkOverlay.questionOtherText,
      questionMultiSelections: [...this.inkOverlay.questionMultiSelections],
      sessions,
      loadingSessions: this.state.loadingSessions,
      sessionsScope: this.state.sessionsScope,
      helpCommands,
      trustPrompt: this.trustPromptView,
      approvalPreview:
        this.inkOverlay.approvalPreviewBlock === null
          ? null
          : {
              block: this.inkOverlay.approvalPreviewBlock,
              scrollTop: this.inkOverlay.approvalPreviewScrollTop,
            },
      toolOutputExpanded: this.state.toolOutputExpanded,
      externalEditorRunning: this.state.externalEditorRunning,
      queuedMessageDispatchPending: this.state.queuedMessageDispatchPending,
      swarmModeEntry: this.state.swarmModeEntry,
      deferUserMessages: this.deferUserMessages,
      activityTip: this.currentLoadingTip?.tip,
    });
  }

  /**
   * Mount the Ink renderer at the coordinator boundary.
   *
   * Ink is the default terminal owner. During the staged migration, input is
   * still dispatched through the coordinator's focus tree while kimi-tui output
   * stays stopped; only one renderer owns stdin/stdout at a time. Callers
   * using the explicit rollback renderer must release kimi-tui before mounting
   * this renderer.
   */
  mountInkRenderer(options?: InkTerminalRendererOptions): InkTerminalRenderer {
    if (this.inkRenderer !== undefined) return this.inkRenderer;
    if (this.terminalOwnership.current === "kimi-tui") {
      throw new Error(
        "Cannot mount Ink while kimi-tui owns the terminal; stop kimi-tui first.",
      );
    }
    this.inkRenderer = mountInkTerminalRenderer(
      this.getTerminalViewState(),
      options,
    );
    this.terminalOwnership.claim("ink");
    return this.inkRenderer;
  }

  /** Push the latest coordinator snapshot to the mounted Ink bridge. */
  updateInkRenderer(): void {
    this.inkRenderer?.update(this.getTerminalViewState());
  }

  /** Unmount the staged Ink bridge; safe to call repeatedly during shutdown. */
  unmountInkRenderer(): void {
    const renderer = this.inkRenderer;
    this.inkRenderer = undefined;
    renderer?.unmount();
    this.terminalOwnership.release("ink");
  }

  toggleToolOutputExpansion(): void {
    this.state.toolOutputExpanded = !this.state.toolOutputExpanded;
    const children = this.state.transcriptContainer.children;

    // A component is expandable only if it sits at or after the start of the
    // (totalTurns - expandTurns)-th turn — i.e. it belongs to one of the most
    // recent `expandTurns` turns. Position-based so it also covers streaming
    // components that have no entry in the metadata map.
    const boundaries: number[] = [];
    for (let i = 0; i < children.length; i++) {
      if (this.isTurnBoundaryComponent(children[i]!)) boundaries.push(i);
    }
    const expandCutoff =
      TRANSCRIPT_EXPAND_TURNS <= 0
        ? children.length
        : boundaries.length > TRANSCRIPT_EXPAND_TURNS
          ? boundaries[boundaries.length - TRANSCRIPT_EXPAND_TURNS]!
          : 0;

    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      if (!isExpandable(child)) continue;
      child.setExpanded(this.state.toolOutputExpanded && i >= expandCutoff);
    }
    // Differential render only — no destructive full redraw on expand/collapse.
    // (When the expanded region reaches above the viewport, the engine's own
    // fallback may still do a full render; that path is not forced from here.)
    this.state.ui.requestRender();
  }

  toggleTodoPanelExpansion(): void {
    this.state.todoPanel.toggleExpanded();
    this.state.ui.requestRender();
  }

  private async detachRunningShellCommand(): Promise<void> {
    // Only one `!` command runs at a time (input is queued while busy).
    const next = this.shellOutputStreams.entries().next();
    if (next.done) {
      this.showDetachHint("No shell command running.");
      return;
    }
    const [commandId, stream] = next.value;
    if (stream.taskId === undefined) {
      this.showDetachHint("Command is still starting — try again.");
      return;
    }
    const session = this.session;
    if (session === undefined) return;
    try {
      const info = await session.detachBackgroundTask(stream.taskId);
      if (info === undefined) {
        this.showDetachHint("Command already finished.");
        return;
      }
    } catch (error) {
      this.showError(
        `Failed to move to background: ${formatErrorMessage(error)}`,
      );
      return;
    }
    // Finalize the card as backgrounded and drop the stream so the eventual
    // runShellCommand resolution (which carries background metadata) is a no-op
    // instead of overwriting this view.
    stream.component.finishBackgrounded();
    stream.entry.content = "Moved to background.";
    this.shellOutputStreams.delete(commandId);
    // The backgrounded command's notification turn (started by agent-core via
    // appendSystemReminderAndNotify) owns the streaming phase and drains the
    // queue when it completes, so we intentionally leave both untouched here.
    this.showDetachHint("Moved to background. /tasks to view.");
  }

  async detachCurrentForegroundTask(): Promise<void> {
    // A running `!` shell command takes priority over agent foreground tasks.
    if (this.shellOutputStreams.size > 0) {
      await this.detachRunningShellCommand();
      return;
    }

    const session = this.session;
    if (session === undefined) {
      this.showError(NO_ACTIVE_SESSION_MESSAGE);
      return;
    }

    let tasks: readonly BackgroundTaskInfo[];
    try {
      // activeOnly defaults to true; foreground running tasks are non-terminal
      // and therefore included. We filter to `detached === false` ourselves.
      tasks = await session.listBackgroundTasks();
    } catch (error) {
      this.showError(`Failed to list tasks: ${formatErrorMessage(error)}`);
      return;
    }

    const targets = pickForegroundTasks(tasks);
    if (targets.length === 0) {
      this.showDetachHint("No foreground task running.");
      return;
    }

    let detached = 0;
    let alreadyFinished = 0;
    for (const target of targets) {
      try {
        const info = await session.detachBackgroundTask(target.taskId);
        if (info === undefined) alreadyFinished++;
        else detached++;
      } catch (error) {
        this.showError(
          `Failed to detach ${target.taskId}: ${formatErrorMessage(error)}`,
        );
      }
    }

    let hint: string;
    if (detached === 0 && alreadyFinished > 0) {
      hint =
        alreadyFinished === 1
          ? "Task already finished."
          : "Tasks already finished.";
    } else if (detached === targets.length) {
      hint =
        detached === 1
          ? "Moved 1 task to background."
          : `Moved ${detached} tasks to background.`;
    } else {
      hint = `Moved ${detached} of ${targets.length} tasks to background.`;
    }
    if (detached > 0) hint = `${hint} /tasks to view.`;
    this.showDetachHint(hint);
  }

  /** Show a one-shot footer hint that auto-clears after DETACH_HINT_DISPLAY_MS. */
  private showDetachHint(hint: string): void {
    if (this.detachHintClearTimer !== undefined) {
      clearTimeout(this.detachHintClearTimer);
      this.detachHintClearTimer = undefined;
    }
    this.state.footer.setTransientHint(hint);
    this.detachHintClearTimer = setTimeout(() => {
      this.detachHintClearTimer = undefined;
      // Don't clobber a newer transient hint (e.g. the exit-confirmation
      // prompt) that took over while this timer was pending.
      if (this.state.footer.getTransientHint() !== hint) return;
      this.state.footer.setTransientHint(null);
      this.state.ui.requestRender();
    }, DETACH_HINT_DISPLAY_MS);
    this.state.ui.requestRender();
  }

  updateEditorBorderHighlight(text?: string): void {
    const trimmed = (text ?? this.state.editor.getText()).trimStart();
    const isBash = this.state.appState.inputMode === "bash";
    const highlighted =
      this.state.appState.planMode || isBash || trimmed.startsWith("/");
    this.state.editor.borderHighlighted = highlighted;
    // Shell mode gets its own hue; plan-mode and slash context stay primary.
    const borderToken = isBash
      ? "shellMode"
      : highlighted
        ? "primary"
        : "border";
    this.state.editor.borderColor = (s: string) =>
      currentTheme.fg(borderToken, s);
    this.state.ui.requestRender();
  }

  async applyTheme(
    themeName: ThemeName,
    resolved?: ResolvedTheme,
  ): Promise<void> {
    const palette = await getColorPalette(
      themeName === "auto" ? (resolved ?? "dark") : themeName,
    );
    currentTheme.setPalette(palette);
    this.setAppState({ theme: themeName });
    this.updateEditorBorderHighlight();
    // Force every historical message to re-render so Markdown/Text caches
    // (which hold old ANSI colour codes) are cleared.
    this.state.transcriptContainer.invalidate();
    this.state.ui.requestRender(true);
  }

  refreshTerminalThemeTracking(): void {
    this.stopTerminalThemeTracking();
    if (
      !isBuiltInTheme(this.state.appState.theme) ||
      this.state.appState.theme !== "auto"
    )
      return;

    this.terminalThemeTrackingDispose = installTerminalThemeTracking(
      this.state,
      (resolved) => {
        void this.applyResolvedAutoTheme(resolved);
      },
    );
  }

  private stopTerminalThemeTracking(): void {
    this.terminalThemeTrackingDispose?.();
    this.terminalThemeTrackingDispose = undefined;
  }

  private async applyResolvedAutoTheme(resolved: ResolvedTheme): Promise<void> {
    if (this.state.appState.theme !== "auto") return;
    const palette = getBuiltInPalette(resolved);
    if (currentTheme.palette === palette) return;
    currentTheme.setPalette(palette);
    this.updateEditorBorderHighlight();
    // Repaint already-rendered transcript entries (status/markdown caches hold
    // old ANSI codes), matching applyTheme()'s behaviour.
    this.state.transcriptContainer.invalidate();
    this.state.ui.requestRender(true);
  }

  private shouldShowTerminalProgress(
    effectiveMode: EffectiveActivityPaneMode,
  ): boolean {
    if (this.state.appState.isCompacting) return true;
    return (
      effectiveMode === "waiting" ||
      effectiveMode === "thinking" ||
      effectiveMode === "composing" ||
      effectiveMode === "tool"
    );
  }

  private shouldPlaceActivitySpinnerInAgentSwarm(
    effectiveMode: EffectiveActivityPaneMode,
  ): boolean {
    return (
      this.sessionEventHandler.hasActiveAgentSwarmToolCall() &&
      (effectiveMode === "waiting" || effectiveMode === "tool")
    );
  }

  private syncAgentSwarmActivitySpinner(spinner: MoonLoader | undefined): void {
    this.sessionEventHandler.syncAgentSwarmActivitySpinner(spinner);
  }

  private syncTerminalProgress(active: boolean): void {
    if (!this.state.terminalState.supportsProgress) return;
    if (this.state.terminalState.progressActive === active) return;
    this.state.terminal.setProgress(active);
    this.state.terminalState.progressActive = active;
  }

  private ensureActivitySpinner(
    style: SpinnerStyle,
    label = "",
    colorFn?: (s: string) => string,
  ): MoonLoader {
    if (this.state.activitySpinner?.style !== style) {
      this.stopActivitySpinner();
    }

    if (this.state.activitySpinner === null) {
      const instance = new MoonLoader(this.state.ui, style, colorFn, label);
      this.state.activitySpinner = { instance, style };
      return instance;
    }

    this.state.activitySpinner.instance.setLabel(label);
    if (colorFn !== undefined) {
      this.state.activitySpinner.instance.setColorFn(colorFn);
    }
    return this.state.activitySpinner.instance;
  }

  private stopActivitySpinner(): void {
    if (this.state.activitySpinner !== null) {
      this.state.activitySpinner.instance.stop();
      this.state.activitySpinner = null;
    }
  }

  // =========================================================================
  // Dialogs / Selectors
  // =========================================================================

  mountEditorReplacement(panel: Component & Focusable): void {
    this.state.editorContainer.clear();
    this.state.editorContainer.addChild(panel);
    if (!this.inkOwnsTerminal()) {
      this.state.ui.setFocus(panel);
      this.state.ui.requestRender();
    }
    this.updateInkRenderer();
  }

  restoreEditor(): void {
    if (this.inkOwnsTerminal()) {
      const children = this.state.editorContainer.children;
      if (children.length === 1 && children[0] === this.state.editor) {
        this.updateInkRenderer();
        return;
      }
      // A legacy fallback panel was mounted for Ink input dispatch.
      this.state.editorContainer.clear();
      this.state.editorContainer.addChild(this.state.editor);
      this.updateInkRenderer();
      return;
    }
    this.state.editorContainer.clear();
    this.state.editorContainer.addChild(this.state.editor);
    this.state.ui.setFocus(this.state.editor);
    // Differential render only: closing a tall panel leaves the editor a few
    // rows above the bottom (blank tail) until the next append, but avoids a
    // destructive full redraw on every dialog close.
    this.state.ui.requestRender();
    this.updateInkRenderer();
  }

  restoreInputText(text: string): void {
    this.restoreEditor();
    this.promptEditorState = reducePromptEditor(this.promptEditorState, {
      type: "set-text",
      text,
    });
    if (!this.inkOwnsTerminal()) {
      this.state.editor.setText(text);
      this.state.ui.requestRender();
    }
    this.updateEditorBorderHighlight(text);
    this.updateInkRenderer();
  }

  /**
   * agent-core-v2 startup gate: before any session is created, ask whether to
   * trust this folder when the workspace is not trusted yet (project-level MCP
   * servers stay disabled while untrusted). Best-effort throughout — a failed
   * check or trust write never blocks startup. Choosing "don't trust" (or Esc)
   * exits the program before any session is created; the prompt reappears on
   * the next launch: the engine's untrusted state is indistinguishable from
   * never-trusted. Returns true when the prompt started the event loop (the
   * caller must not start it again).
   */
  private async maybeRunWorkspaceTrustPrompt(): Promise<boolean> {
    if (!this.engineV2) return false;
    const workDir = this.state.appState.workDir;
    let info: WorkspaceTrustInfo;
    try {
      info = await this.harness.getWorkspaceTrustInfo(workDir);
    } catch {
      return false;
    }
    if (info.trusted) return false;
    this.startEventLoop();
    const choice = await new Promise<TrustPromptChoice>((resolve) => {
      this.inkOverlay.dialogSelectedIndex = 0;
      this.trustPromptChoiceResolver = resolve;
      this.state.activeDialog = "trust-prompt";
      this.trustPromptView = {
        workDir,
        gatedMcpServers: [...info.gatedMcpServers],
      };
      if (this.terminalRenderer === "ink") {
        this.updateInkRenderer();
        return;
      }
      this.mountEditorReplacement(
        new TrustPromptComponent({
          workDir,
          gatedMcpServers: info.gatedMcpServers,
          onSelect: (c) => {
            resolve(c);
          },
        }),
      );
    });
    this.trustPromptChoiceResolver = undefined;
    this.state.activeDialog = null;
    this.trustPromptView = null;
    if (choice !== "trust") {
      // Declining trust exits the program (Claude Code's "No, exit" semantics):
      // stop() runs the standard shutdown path and ends in process.exit. The
      // editor is NOT restored first — its frame would linger as an orphaned
      // input box above the exit message; the prompt stays as the last frame.
      await this.stop();
      return true;
    }
    this.restoreEditor();
    try {
      await this.harness.trustWorkspace(workDir);
    } catch {
      // A failed write leaves the workspace untrusted (re-asked next launch).
    }
    return true;
  }

  showHelpPanel(): void {
    this.state.activeDialog = "help";
    this.inkOverlay.dialogScrollTop = 0;
    if (this.terminalRenderer === "ink") {
      // Ink owns the `/help` dialog in the production renderer. Keep the
      // kimi-tui panel only for the explicit rollback renderer below.
      this.updateInkRenderer();
      return;
    }
    this.mountEditorReplacement(
      new HelpPanelComponent({
        commands: this.getSlashCommands(),
        onClose: () => {
          this.hideHelpPanel();
        },
      }),
    );
  }

  private hideHelpPanel(): void {
    this.state.activeDialog = null;
    this.inkOverlay.dialogScrollTop = 0;
    this.restoreEditor();
  }

  private sessionPickerOptions: {
    readonly applyStartupModes: boolean;
    readonly closeOnCancel: boolean;
    readonly forwardEditorExit: boolean;
  } = {
    applyStartupModes: false,
    closeOnCancel: false,
    forwardEditorExit: false,
  };
  private sessionPickerScopeRequestToken = 0;

  async showSessionPicker(): Promise<void> {
    await this.openSessionPicker({
      applyStartupModes: false,
      closeOnCancel: false,
      forwardEditorExit: false,
    });
  }

  private async bootstrapFromPicker(): Promise<void> {
    await this.openSessionPicker({
      applyStartupModes: true,
      closeOnCancel: true,
      forwardEditorExit: true,
    });
  }

  private async openSessionPicker(options: {
    readonly applyStartupModes: boolean;
    readonly closeOnCancel: boolean;
    readonly forwardEditorExit: boolean;
  }): Promise<void> {
    this.sessionPickerOptions = options;
    await this.fetchSessions("cwd");
    this.mountSessionPicker({
      applyStartupModes: options.applyStartupModes,
      onCancel: () => {
        this.hideSessionPicker();
        if (options.closeOnCancel) void this.stop();
      },
      onCtrlC: options.forwardEditorExit
        ? () => {
            this.state.editor.onCtrlC?.();
          }
        : undefined,
      onCtrlD: options.forwardEditorExit
        ? () => {
            this.state.editor.onCtrlD?.();
          }
        : undefined,
    });
  }

  private async toggleSessionPickerScope(
    selectedSessionId: string,
  ): Promise<void> {
    const requestToken = ++this.sessionPickerScopeRequestToken;
    const nextScope = this.state.sessionsScope === "cwd" ? "all" : "cwd";
    await this.fetchSessions(nextScope);
    if (requestToken !== this.sessionPickerScopeRequestToken) return;
    if (this.state.activeDialog !== "session-picker") return;
    this.mountSessionPicker({
      initialSelectedSessionId: selectedSessionId,
      applyStartupModes: this.sessionPickerOptions.applyStartupModes,
      onCancel: () => {
        this.hideSessionPicker();
        if (this.sessionPickerOptions.closeOnCancel) void this.stop();
      },
      onCtrlC: this.sessionPickerOptions.forwardEditorExit
        ? () => {
            this.state.editor.onCtrlC?.();
          }
        : undefined,
      onCtrlD: this.sessionPickerOptions.forwardEditorExit
        ? () => {
            this.state.editor.onCtrlD?.();
          }
        : undefined,
    });
  }

  hideSessionPicker(): void {
    this.sessionPickerScopeRequestToken += 1;
    this.editorKeyboard.clearPendingExit();
    this.inkSessionPickerSelect = undefined;
    this.inkSessionPickerCancel = undefined;
    this.inkSessionPickerToggleScope = undefined;
    this.state.activeDialog = null;
    this.restoreEditor();
  }

  openUndoSelector(): void {
    void slashCommands.handleUndoCommand(this, "");
  }

  private mountSessionPicker(options: {
    readonly onCancel: () => void;
    readonly onCtrlC?: () => void;
    readonly onCtrlD?: () => void;
    readonly initialSelectedSessionId?: string;
    // CLI mode flags (--auto/--yolo/--plan) target the session picked at
    // startup (bare --session); later /sessions switches keep the picked
    // session's own persisted modes.
    readonly applyStartupModes?: boolean;
  }): void {
    this.state.activeDialog = "session-picker";
    const initialSessionId =
      options.initialSelectedSessionId ?? this.state.appState.sessionId;
    const initialIndex = this.state.sessions.findIndex(
      (session) => session.id === initialSessionId,
    );
    this.inkOverlay.dialogSelectedIndex = initialIndex >= 0 ? Math.min(initialIndex, 7) : 0;
    this.inkSessionPickerSelect = (session) => {
      void this.handleSessionPickerSelect(
        session,
        options.applyStartupModes === true,
      ).catch((error) => {
        this.showError(
          `Failed to apply startup flags: ${formatErrorMessage(error)}`,
        );
      });
    };
    this.inkSessionPickerCancel = options.onCancel;
    this.inkSessionPickerToggleScope = (selectedSessionId) => {
      void this.toggleSessionPickerScope(selectedSessionId);
    };
    if (this.terminalRenderer === "ink") {
      this.updateInkRenderer();
      return;
    }
    this.mountEditorReplacement(
      new SessionPickerComponent({
        sessions: this.state.sessions,
        loading: this.state.loadingSessions,
        currentSessionId: this.state.appState.sessionId,
        scope: this.state.sessionsScope,
        initialSelectedSessionId: options.initialSelectedSessionId,
        pageSize: 50,
        onSelect: this.inkSessionPickerSelect!,
        onCancel: options.onCancel,
        onCtrlC: options.onCtrlC,
        onCtrlD: options.onCtrlD,
        onToggleScope: this.inkSessionPickerToggleScope!,
      }),
    );
  }

  private async handleSessionPickerSelect(
    session: SessionRow,
    applyStartupModes: boolean,
  ): Promise<void> {
    if (resolve(session.work_dir) !== resolve(this.state.appState.workDir)) {
      await this.showResumeOtherWorkDirHint(session);
      if (applyStartupModes) await this.stop(0);
      return;
    }

    const switched = await this.resumeSession(session.id);
    if (!switched) return;
    if (applyStartupModes) {
      await this.applyStartupModesToResumedSession(this.requireSession());
      this.applyStartupPermissionAndPlanToAppState();
    }
    this.hideSessionPicker();
  }

  private showApprovalPanel(payload: ApprovalPanelData): void {
    this.resetInkApprovalDialogState();
    this.patchLivePane({ pendingApproval: { data: payload } });
    notifyTerminalOnce(this.state, `approval:${payload.id}`, {
      title: "Kimi Code approval required",
      body: payload.tool_name,
    });
    if (this.terminalRenderer === "ink") {
      this.updateInkRenderer();
      return;
    }
    const panel = new ApprovalPanelComponent(
      { data: payload },
      (response: ApprovalPanelResponse) => {
        this.approvalController.respond(adaptPanelResponse(response));
      },
      () => {
        this.toggleToolOutputExpansion();
      },
      (block) => {
        this.openApprovalPreview(panel, block);
      },
    );
    this.activeApprovalPanel = panel;
    this.mountEditorReplacement(panel);
  }

  private hideApprovalPanel(): void {
    // If the full-screen preview is open, fold it back first so the saved-
    // children stack stays consistent with what mountEditorReplacement set up.
    if (this.approvalPreview !== undefined || this.inkOverlay.approvalPreviewBlock !== null) {
      this.closeApprovalPreview();
    }
    this.activeApprovalPanel = undefined;
    this.resetInkApprovalDialogState();
    this.patchLivePane({ pendingApproval: null });
    this.restoreEditor();
  }

  // Mounts the full-screen approval preview viewer on top of the current
  // approval panel. Uses the same nested-takeover pattern as
  // openTaskOutputViewer: we snapshot the root container's children, swap
  // in the viewer, and restore on close. The approval panel instance is
  // kept around in `activeApprovalPanel` so its selection state survives.
  private openApprovalPreview(
    panel: ApprovalPanelComponent,
    block: ApprovalPreviewBlock,
  ): void {
    if (this.approvalPreview !== undefined || this.inkOverlay.approvalPreviewBlock !== null) {
      return;
    }
    if (this.terminalRenderer === "ink") {
      this.openInkApprovalPreview(block);
      return;
    }
    const savedChildren = [...this.state.ui.children];
    const viewer = new ApprovalPreviewViewer(
      {
        block,
        onClose: () => {
          this.closeApprovalPreview();
        },
      },
      this.state.terminal,
    );
    this.state.ui.clear();
    this.state.ui.addChild(viewer);
    this.state.ui.setFocus(viewer);
    this.state.ui.requestRender(true);
    this.approvalPreview = { component: viewer, savedChildren, panel };
  }

  private closeApprovalPreview(): void {
    if (this.inkOverlay.approvalPreviewBlock !== null) {
      this.inkOverlay.approvalPreviewBlock = null;
      this.inkOverlay.approvalPreviewScrollTop = 0;
      this.updateInkRenderer();
      return;
    }
    const preview = this.approvalPreview;
    if (preview === undefined) return;
    this.approvalPreview = undefined;
    this.state.ui.clear();
    for (const child of preview.savedChildren) {
      this.state.ui.addChild(child);
    }
    this.state.ui.setFocus(preview.panel);
    this.state.ui.requestRender(true);
  }

  private showQuestionDialog(payload: QuestionPanelData): void {
    this.resetInkQuestionDialogState();
    this.patchLivePane({ pendingQuestion: { data: payload } });
    notifyTerminalOnce(this.state, `question:${payload.id}`, {
      title: "Kimi Code needs your answer",
      body: payload.questions[0]?.question,
    });
    if (this.terminalRenderer === "ink" && this.isInkSimpleQuestion(payload)) {
      this.updateInkRenderer();
      return;
    }
    const dialog = new QuestionDialogComponent(
      { data: payload },
      (response) => {
        this.questionController.respond(response);
      },
      6,
      () => {
        this.toggleToolOutputExpansion();
      },
    );
    this.mountEditorReplacement(dialog);
  }

  private hideQuestionDialog(): void {
    this.resetInkQuestionDialogState();
    this.patchLivePane({ pendingQuestion: null });
    this.restoreEditor();
  }
}

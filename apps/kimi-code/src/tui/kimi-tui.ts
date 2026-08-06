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
import { log } from "@moonshot-ai/kimi-code-sdk";
import {
  type Component,
  type Focusable,
} from "@moonshot-ai/kimi-tui";
import { resolve } from "pathe";
import type { CLIOptions } from "#/cli/options";
import {
  appendInputHistory,
  loadInputHistory,
} from "#/utils/history/input-history";
import { getInputHistoryFile } from "#/utils/paths";
import { detectFdPath, ensureFdPath } from "#/utils/process/fd-detect";
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
import { GutterContainer } from "./components/chrome/gutter-container.ts";
import { WelcomeComponent } from "./components/chrome/welcome.ts";
import {
  ApprovalPanelComponent,
  type ApprovalPanelResponse,
} from "./components/dialogs/approval-panel.ts";
import {
  type ApprovalPreviewBlock,
  ApprovalPreviewViewer,
} from "./components/dialogs/approval-preview.ts";
import { HelpPanelComponent } from "./components/dialogs/help-panel.ts";
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
import { ShellRunComponent } from "./components/messages/shell-run.ts";
import type { TuiConfig } from "./config.ts";
import {
  LLM_NOT_SET_MESSAGE,
  MAIN_AGENT_ID,
  PRODUCT_NAME,
  SESSIONLESS_STARTUP_NOTICE,
} from "./constant/kimi-tui.ts";
import { CHROME_GUTTER } from "./constant/rendering.ts";
import { MAX_TERMINAL_TITLE_LENGTH } from "./constant/terminal.ts";
import { AuthFlowController } from "./controllers/auth-flow.ts";
import { BtwPanelController } from "./controllers/btw-panel.ts";
import { ClipboardImageHintController } from "./controllers/clipboard-image-hint.ts";
import { EditorKeyboardController } from "./controllers/editor-keyboard.ts";
import { InkDialogsController } from "./controllers/ink-dialogs.ts";
import { PresentationStateController } from "./controllers/presentation-state.ts";
import { SessionEventHandler } from "./controllers/session-event-handler.ts";
import { SessionOrchestrationController } from "./controllers/session-orchestration.ts";
import { TranscriptCoordinator } from "./controllers/transcript-coordinator.ts";
import { SessionReplayRenderer } from "./controllers/session-replay.ts";
import { StreamingUIController } from "./controllers/streaming-ui.ts";
import { TasksBrowserController } from "./controllers/tasks-browser.ts";
import { installRainbowDance } from "./easter-eggs/dance.ts";
import {
  type InkTerminalRenderer,
  type InkTerminalRendererOptions,
  mountInkTerminalRenderer,
} from "./renderer/ink/terminal-renderer.ts";
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
  type TerminalHelpCommandView,
  type TerminalSessionView,
  type TerminalTrustPromptView,
  type TerminalViewState,
} from "./renderer/terminal-view-state.ts";
import { adaptPanelResponse } from "./reverse-rpc/approval/adapter.ts";
import { ApprovalController } from "./reverse-rpc/approval/controller.ts";
import { registerReverseRPCHandlers } from "./reverse-rpc/index.ts";
import { QuestionController } from "./reverse-rpc/question/controller.ts";
import type {
  ApprovalPanelData,
  QuestionPanelData,
} from "./reverse-rpc/types.ts";
import type { ColorToken, ResolvedTheme, ThemeName } from "./theme/index.ts";
import {
  currentTheme,
  getColorPalette,
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
import { isExpandable } from "./utils/component-capabilities.ts";
import { isDeadTerminalError } from "./utils/dead-terminal.ts";
import { formatErrorMessage } from "./utils/event-payload.ts";
import { ImageAttachmentStore } from "./utils/image-attachment-store.ts";
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
import { detectTmuxKeyboardWarning } from "./utils/tmux-keyboard.ts";
import {
  markTranscriptComponent,
} from "./utils/transcript-component-metadata.ts";
import { nextTranscriptId } from "./utils/transcript-id.ts";
import {
  TRANSCRIPT_EXPAND_TURNS,
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

export class KimiTUI {
  readonly harness: KimiHarness;
  readonly options: KimiTUIOptions;
  session: Session | undefined;
  state: TUIState;
  readonly approvalController = new ApprovalController();
  readonly questionController = new QuestionController();
  readonly reverseRpcDisposers: Array<() => void> = [];
  private skillCommands: readonly KimiSlashCommand[] = [];
  readonly skillCommandMap = new Map<string, string>();
  private pluginCommands: readonly KimiSlashCommand[] = [];
  readonly pluginCommandMap = new Map<string, string>();
  readonly imageStore = new ImageAttachmentStore();
  private fdPath: string | null = detectFdPath();
  private fdDownloadStarted = false;
  sessionEventUnsubscribe: (() => void) | undefined;
  cancelInFlight: (() => void) | undefined;
  deferUserMessages = false;
  aborted = false;
  private terminalFocusTrackingDispose: (() => void) | undefined;
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
  readonly inkDialogsController: InkDialogsController;
  readonly transcriptCoordinator: TranscriptCoordinator;
  readonly sessionOrchestration: SessionOrchestrationController;
  readonly presentationStateController: PresentationStateController;
  readonly terminalRenderer: "kimi-tui" | "ink";
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
  readonly shellOutputStreams = new Map<
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
    this.inkDialogsController = new InkDialogsController(this);
    this.transcriptCoordinator = new TranscriptCoordinator(this);
    this.sessionOrchestration = new SessionOrchestrationController(this);
    this.presentationStateController = new PresentationStateController(this);
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
      if (this.inkDialogsController.handleApprovalPreviewInput(data)) return;
      this.updateInkRenderer();
      return;
    }
    const hasLegacyDialog =
      this.state.activeDialog !== null ||
      this.state.livePane.pendingApproval !== null ||
      this.state.livePane.pendingQuestion !== null;
    if (hasLegacyDialog) {
      if (this.inkDialogsController.handleDialogInput(data)) return;
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

  resolveTrustPrompt(choice: TrustPromptChoice): void {
    this.trustPromptChoiceResolver?.(choice);
  }

  cancelSessionPicker(): void {
    this.inkSessionPickerCancel?.();
  }

  selectSessionPickerRow(session: SessionRow): void {
    this.inkSessionPickerSelect?.(session);
  }

  toggleSessionPickerScope(sessionId: string): void {
    this.inkSessionPickerToggleScope?.(sessionId);
  }

  /** @internal Test hook — delegates to {@link InkDialogsController.handleDialogInput}. */
  handleInkSimpleDialogInput(data: string): boolean {
    return this.inkDialogsController.handleDialogInput(data);
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
    this.presentationStateController.dispose();
    this.streamingUI.disposeActiveCompactionBlock();
    this.streamingUI.resetToolUi();
    this.transcriptCoordinator.disposeTranscriptChildren();
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
    this.presentationStateController.dispose();
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

  // =========================================================================
  // Session Runtime
  // =========================================================================

  requireSession(): Session {
    return this.sessionOrchestration.requireSession();
  }

  async hydrateLazyConfigDefaults(): Promise<void> {
    return this.sessionOrchestration.hydrateLazyConfigDefaults();
  }

  ensureSession(): Promise<Session | undefined> {
    return this.sessionOrchestration.ensureSession();
  }

  waitForLazyCreation(): Promise<void> {
    return this.sessionOrchestration.waitForLazyCreation();
  }

  async setSession(session: Session): Promise<void> {
    return this.sessionOrchestration.setSession(session);
  }

  async syncRuntimeState(session?: Session): Promise<void> {
    return this.sessionOrchestration.syncRuntimeState(session);
  }

  private async applyStartupModesToResumedSession(
    session: Session,
  ): Promise<void> {
    return this.sessionOrchestration.applyStartupModesToResumedSession(session);
  }

  private applyStartupPermissionAndPlanToAppState(): void {
    this.sessionOrchestration.applyStartupPermissionAndPlanToAppState();
  }

  async closeSession(reason: string): Promise<void> {
    return this.sessionOrchestration.closeSession(reason);
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

  async switchToSession(
    session: Session,
    statusMessage: string,
  ): Promise<void> {
    return this.sessionOrchestration.switchToSession(session, statusMessage);
  }

  async reloadCurrentSessionView(
    session: Session,
    statusMessage: string,
  ): Promise<void> {
    return this.sessionOrchestration.reloadCurrentSessionView(
      session,
      statusMessage,
    );
  }

  async createNewSession(): Promise<void> {
    return this.sessionOrchestration.createNewSession();
  }

  private async showConfigWarningsIfAny(): Promise<void> {
    return this.sessionOrchestration.showConfigWarningsIfAny();
  }

  // =========================================================================
  // Transcript Rendering
  // =========================================================================

  appendTranscriptEntry(entry: TranscriptEntry): void {
    this.transcriptCoordinator.appendTranscriptEntry(entry);
  }

  appendApprovalTranscriptEntry(
    request: ApprovalRequest,
    response: ApprovalResponse,
  ): void {
    this.transcriptCoordinator.appendApprovalTranscriptEntry(request, response);
  }

  private renderWelcome(): void {
    this.transcriptCoordinator.renderWelcome();
  }

  clearTranscriptAndRedraw(): void {
    this.transcriptCoordinator.clearTranscriptAndRedraw();
  }

  mergeCurrentTurnSteps(): boolean {
    return this.transcriptCoordinator.mergeCurrentTurnSteps();
  }

  mergeCompletedTurnAssistants(): boolean {
    return this.transcriptCoordinator.mergeCompletedTurnAssistants();
  }

  mergeAllTurnSteps(): void {
    this.transcriptCoordinator.mergeAllTurnSteps();
  }

  showStatus(message: string, color?: ColorToken): void {
    this.transcriptCoordinator.showStatus(message, color);
  }

  showNotice(title: string, detail?: string): void {
    this.transcriptCoordinator.showNotice(title, detail);
  }

  showError(message: string): void {
    this.transcriptCoordinator.showError(message);
  }

  showLoginProgressSpinner(label: string): LoginProgressSpinnerHandle {
    return this.transcriptCoordinator.showLoginProgressSpinner(label);
  }

  showProgressSpinner(label: string): LoginProgressSpinnerHandle {
    return this.transcriptCoordinator.showProgressSpinner(label);
  }

  showLoginAuthorizationPrompt(
    auth: DeviceAuthorization,
  ): LoginProgressSpinnerHandle {
    return this.transcriptCoordinator.showLoginAuthorizationPrompt(auth);
  }

  // =========================================================================
  // Panes / Presentation State
  // =========================================================================

  updateActivityPane(): void {
    this.presentationStateController.updateActivityPane();
  }

  updateQueueDisplay(): void {
    this.presentationStateController.updateQueueDisplay();
  }

  async detachCurrentForegroundTask(): Promise<void> {
    return this.presentationStateController.detachCurrentForegroundTask();
  }

  refreshTerminalThemeTracking(): void {
    this.presentationStateController.refreshTerminalThemeTracking();
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
      ...this.inkDialogsController.projectDialogFields(),
      sessions,
      loadingSessions: this.state.loadingSessions,
      sessionsScope: this.state.sessionsScope,
      helpCommands,
      trustPrompt: this.trustPromptView,
      toolOutputExpanded: this.state.toolOutputExpanded,
      externalEditorRunning: this.state.externalEditorRunning,
      queuedMessageDispatchPending: this.state.queuedMessageDispatchPending,
      swarmModeEntry: this.state.swarmModeEntry,
      deferUserMessages: this.deferUserMessages,
      activityTip: this.presentationStateController.getActivityTip(),
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

  /** Refresh whichever renderer currently owns the terminal output. */
  requestTerminalRender(): void {
    if (this.inkOwnsTerminal()) {
      this.updateInkRenderer();
      return;
    }
    this.state.ui.requestRender();
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
      if (this.transcriptCoordinator.isTurnBoundaryComponent(children[i]!))
        boundaries.push(i);
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

  // =========================================================================
  // Dialogs / Selectors
  // =========================================================================

  mountEditorReplacement(panel: Component & Focusable): void {
    if (this.inkOwnsTerminal() && this.inkDialogsController.tryOpenFromPanel(panel)) {
      return;
    }
    this.state.editorContainer.clear();
    this.state.editorContainer.addChild(panel);
    if (!this.inkOwnsTerminal()) {
      this.state.ui.setFocus(panel);
      this.state.ui.requestRender();
    }
    this.updateInkRenderer();
  }

  restoreEditor(): void {
    this.inkDialogsController.closeAll();
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

  hideHelpPanel(): void {
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

  private async applySessionPickerScopeChange(
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
      void this.applySessionPickerScopeChange(selectedSessionId);
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
      await this.sessionOrchestration.showResumeOtherWorkDirHint(session);
      if (applyStartupModes) await this.stop(0);
      return;
    }

    const switched = await this.sessionOrchestration.resumeSession(session.id);
    if (!switched) return;
    if (applyStartupModes) {
      await this.applyStartupModesToResumedSession(this.requireSession());
      this.applyStartupPermissionAndPlanToAppState();
    }
    this.hideSessionPicker();
  }

  private showApprovalPanel(payload: ApprovalPanelData): void {
    this.inkDialogsController.resetApprovalState();
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
    this.inkDialogsController.resetApprovalState();
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
      this.inkDialogsController.openApprovalPreview(block);
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
      this.inkDialogsController.closeApprovalPreview();
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
    this.inkDialogsController.resetQuestionState();
    this.patchLivePane({ pendingQuestion: { data: payload } });
    notifyTerminalOnce(this.state, `question:${payload.id}`, {
      title: "Kimi Code needs your answer",
      body: payload.questions[0]?.question,
    });
    if (this.terminalRenderer === "ink") {
      this.inkDialogsController.initQuestionState(payload.questions.length);
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
    this.inkDialogsController.resetQuestionState();
    this.patchLivePane({ pendingQuestion: null });
    this.restoreEditor();
  }
}

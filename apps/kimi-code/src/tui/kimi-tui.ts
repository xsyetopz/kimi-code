import type { DeviceAuthorization } from "@moonshot-ai/kimi-code-oauth";
import type {
  ApprovalRequest,
  ApprovalResponse,
  BackgroundTaskInfo,
  KimiHarness,
  PermissionMode,
  PromptPart,
  Session,
} from "@moonshot-ai/kimi-code-sdk";
import { log } from "@moonshot-ai/kimi-code-sdk";
import { type Component, type Focusable } from "@moonshot-ai/kimi-tui";
import type { CLIOptions } from "#/cli/options";
import { detectFdPath } from "#/utils/process/fd-detect";
import * as slashCommands from "./commands/dispatch.ts";
import type { KimiSlashCommand } from "./commands/index.ts";
import type { SessionRow } from "./components/dialogs/session-picker.ts";
import type { TrustPromptChoice } from "./components/dialogs/trust-prompt.ts";
import { ShellRunComponent } from "./components/messages/shell-run.ts";
import type { TuiConfig } from "./config.ts";
import {
  LLM_NOT_SET_MESSAGE,
  PRODUCT_NAME,
} from "./constant/kimi-tui.ts";
import { CHROME_GUTTER } from "./constant/rendering.ts";
import { MAX_TERMINAL_TITLE_LENGTH } from "./constant/terminal.ts";
import { AuthFlowController } from "./controllers/auth-flow.ts";
import { BtwPanelController } from "./controllers/btw-panel.ts";
import { EditorKeyboardController } from "./controllers/editor-keyboard.ts";
import { InkDialogsController } from "./controllers/ink-dialogs.ts";
import { MessageQueueController } from "./controllers/message-queue.ts";
import { PresentationStateController } from "./controllers/presentation-state.ts";
import { PromptInputController } from "./controllers/prompt-input.ts";
import { SessionEventHandler } from "./controllers/session-event-handler.ts";
import { SessionOrchestrationController } from "./controllers/session-orchestration.ts";
import { SlashSetupController } from "./controllers/slash-setup.ts";
import { StartupPanelsController } from "./controllers/startup-panels.ts";
import { TranscriptCoordinator } from "./controllers/transcript-coordinator.ts";
import { SessionReplayRenderer } from "./controllers/session-replay.ts";
import { StreamingUIController } from "./controllers/streaming-ui.ts";
import { TasksBrowserController } from "./controllers/tasks-browser.ts";
import { TuiAccessorsController } from "./controllers/tui-accessors.ts";
import { TuiLifecycleController } from "./controllers/tui-lifecycle.ts";
import { installRainbowDance } from "./easter-eggs/dance.ts";
import {
  type InkTerminalRenderer,
  type InkTerminalRendererOptions,
  mountInkTerminalRenderer,
} from "./renderer/ink/terminal-renderer.ts";
import {
  type PromptEditorState,
  promptEditorLineColumn,
} from "./renderer/prompt-editor-state.ts";
import { TerminalOwnership } from "./renderer/terminal-owner.ts";
import {
  type TerminalHelpCommandView,
  type TerminalSessionView,
  type TerminalViewState,
  createTerminalViewState,
} from "./renderer/terminal-view-state.ts";
import { registerReverseRPCHandlers } from "./reverse-rpc/index.ts";
import { ApprovalController } from "./reverse-rpc/approval/controller.ts";
import { QuestionController } from "./reverse-rpc/question/controller.ts";
import type { ColorToken, ResolvedTheme, ThemeName } from "./theme/index.ts";
import {
  currentTheme,
  getColorPalette,
} from "./theme/index.ts";
import type { AgentGroupViewState } from "./projections/tool-call/agent-group.ts";
import type { ReadGroupViewState } from "./projections/tool-call/read-group.ts";
import { createTUIState, type TUIState } from "./tui-state.ts";
import {
  type AppState,
  type CompactionTranscriptData,
  type KimiTUIOptions,
  type LivePaneState,
  type LoginProgressSpinnerHandle,
  type QueuedMessage,
  type ShellRunViewState,
  type SteerInputItem,
  type ToolCallBlockData,
  type TranscriptEntry,
} from "./types.ts";
import { isExpandable } from "./utils/component-capabilities.ts";
import { formatErrorMessage } from "./utils/event-payload.ts";
import { ImageAttachmentStore } from "./utils/image-attachment-store.ts";
import { extractMediaAttachments } from "./utils/image-placeholder.ts";
import { sessionRowsForPicker } from "./utils/session-picker-rows.ts";
import { formatBashOutputForDisplay } from "./utils/shell-output.ts";
import { TRANSCRIPT_EXPAND_TURNS } from "./utils/transcript-window.ts";

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
}

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

export class KimiTUI {
  readonly harness: KimiHarness;
  readonly options: KimiTUIOptions;
  session: Session | undefined;
  state: TUIState;
  readonly approvalController = new ApprovalController();
  readonly questionController = new QuestionController();
  readonly reverseRpcDisposers: Array<() => void> = [];
  readonly skillCommandMap = new Map<string, string>();
  readonly pluginCommandMap = new Map<string, string>();
  readonly imageStore = new ImageAttachmentStore();
  fdPath: string | null = detectFdPath();
  sessionEventUnsubscribe: (() => void) | undefined;
  cancelInFlight: (() => void) | undefined;
  deferUserMessages = false;
  aborted = false;
  private uninstallRainbowDanceFn: () => void;
  /** Whether the harness runs on the agent-core-v2 engine (lazy session creation). */
  readonly engineV2: boolean;
  startupNotice: string | undefined;
  /** Optional Ink bridge used by the staged renderer migration. */
  private inkRenderer: InkTerminalRenderer | undefined;
  readonly inkDialogsController: InkDialogsController;
  readonly transcriptCoordinator: TranscriptCoordinator;
  readonly sessionOrchestration: SessionOrchestrationController;
  readonly presentationStateController: PresentationStateController;
  readonly tuiAccessorsController: TuiAccessorsController;
  readonly slashSetupController: SlashSetupController;
  readonly startupPanelsController: StartupPanelsController;
  readonly messageQueueController: MessageQueueController;
  readonly promptInputController: PromptInputController;
  readonly tuiLifecycleController: TuiLifecycleController;
  private readonly terminalOwnership = new TerminalOwnership();
  private inkOwnsTerminal(): boolean {
    return true;
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
  get terminalRendererOwner(): "none" | "ink" {
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
    // Embedded callers inherit the same React/Ink owner as the production CLI.
    this.engineV2 = startupInput.engineV2 ?? false;
    this.startupNotice = startupInput.startupNotice;
    this.state = createTUIState(tuiOptions);
    this.inkDialogsController = new InkDialogsController(this);
    this.transcriptCoordinator = new TranscriptCoordinator(this);
    this.sessionOrchestration = new SessionOrchestrationController(this);
    this.presentationStateController = new PresentationStateController(this);
    this.uninstallRainbowDanceFn = installRainbowDance(() => {
      this.state.ui.requestRender();
    });

    this.streamingUI = new StreamingUIController(this);
    this.authFlow = new AuthFlowController(this);
    this.btwPanelController = new BtwPanelController(this);
    this.sessionEventHandler = new SessionEventHandler(this);
    this.sessionReplay = new SessionReplayRenderer(this);
    this.tasksBrowserController = new TasksBrowserController(this);
    this.editorKeyboard = new EditorKeyboardController(this, this.imageStore);
    this.editorKeyboard.install();
    this.tuiAccessorsController = new TuiAccessorsController(this);
    this.slashSetupController = new SlashSetupController(this);
    this.startupPanelsController = new StartupPanelsController(this);
    this.messageQueueController = new MessageQueueController(this);
    this.promptInputController = new PromptInputController(this);
    this.tuiLifecycleController = new TuiLifecycleController(this);

    this.reverseRpcDisposers.push(
      ...registerReverseRPCHandlers(
        this.approvalController,
        this.questionController,
        {
          showApprovalPanel: (payload) => {
            this.startupPanelsController.showApprovalPanel(payload);
          },
          hideApprovalPanel: () => {
            this.startupPanelsController.hideApprovalPanel();
          },
          showQuestionDialog: (payload) => {
            this.startupPanelsController.showQuestionDialog(payload);
          },
          hideQuestionDialog: () => {
            this.startupPanelsController.hideQuestionDialog();
          },
        },
      ),
    );
    this.tuiLifecycleController.buildLayout();
  }

  // =========================================================================
  // Autocomplete & Skill Commands
  // =========================================================================

  private getSlashCommands(): readonly KimiSlashCommand[] {
    return this.slashSetupController.getSlashCommands();
  }

  private setupAutocomplete(): void {
    this.slashSetupController.setupAutocomplete();
  }

  refreshSlashCommandAutocomplete(): void {
    this.slashSetupController.refreshSlashCommandAutocomplete();
  }

  refreshSkillCommands(
    session?: Parameters<SlashSetupController["refreshSkillCommands"]>[0],
  ): Promise<void> {
    return this.slashSetupController.refreshSkillCommands(session);
  }

  refreshPluginCommands(session?: Session): Promise<void> {
    return this.slashSetupController.refreshPluginCommands(session);
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  async start(): Promise<void> {
    return this.tuiLifecycleController.start();
  }

  async stop(exitCode?: number): Promise<void> {
    return this.tuiLifecycleController.stop(exitCode);
  }

  suspendTerminal(): void {
    this.tuiLifecycleController.suspendTerminal();
  }

  resumeTerminal(): void {
    this.tuiLifecycleController.resumeTerminal();
  }

  startEventLoop(): void {
    this.tuiLifecycleController.startEventLoop();
  }

  /** @internal Test hook — session/bootstrap init without starting the event loop. */
  init(): Promise<boolean> {
    return this.tuiLifecycleController.init();
  }

  private renderWelcome(): void {
    this.transcriptCoordinator.renderWelcome();
  }

  private loadPersistedInputHistory(): Promise<void> {
    return this.promptInputController.loadPersistedInputHistory();
  }

  private maybeRunWorkspaceTrustPrompt(): Promise<boolean> {
    return this.startupPanelsController.maybeRunWorkspaceTrustPrompt();
  }

  private bootstrapFromPicker(): Promise<void> {
    return this.startupPanelsController.bootstrapFromPicker();
  }

  private applyStartupModesToResumedSession(session: Session): Promise<void> {
    return this.sessionOrchestration.applyStartupModesToResumedSession(session);
  }

  showSessionWarnings(session: Session): Promise<void> {
    return this.tuiLifecycleController.showSessionWarnings(session);
  }

  /** @internal Legacy test hook — forwards to {@link StartupPanelsController}. */
  set trustPromptChoiceResolver(
    resolver: ((choice: TrustPromptChoice) => void) | undefined,
  ) {
    this.startupPanelsController.setTrustPromptChoiceResolver(resolver);
  }

  /** @internal Legacy test hook — forwards to {@link StartupPanelsController}. */
  set inkSessionPickerSelect(
    select: ((session: SessionRow) => void) | undefined,
  ) {
    this.startupPanelsController.setInkSessionPickerSelect(select);
  }

  /** @internal Legacy test hook — forwards to {@link StartupPanelsController}. */
  mountSessionPicker(options: {
    readonly onCancel: () => void;
    readonly onCtrlC?: () => void;
    readonly onCtrlD?: () => void;
    readonly initialSelectedSessionId?: string;
    readonly applyStartupModes?: boolean;
  }): void {
    this.startupPanelsController.mountSessionPicker(options);
  }

  /** Route normal prompt input through the renderer-neutral editor model. */
  handleInkInput(data: string): void {
    this.promptInputController.handleInkInput(data);
  }

  resolveTrustPrompt(choice: TrustPromptChoice): void {
    this.startupPanelsController.resolveTrustPrompt(choice);
  }

  cancelSessionPicker(): void {
    this.startupPanelsController.cancelSessionPicker();
  }

  selectSessionPickerRow(session: SessionRow): void {
    this.startupPanelsController.selectSessionPickerRow(session);
  }

  toggleSessionPickerScope(sessionId: string): void {
    this.startupPanelsController.toggleSessionPickerScope(sessionId);
  }

  /** @internal Test hook — delegates to {@link InkDialogsController.handleDialogInput}. */
  handleInkSimpleDialogInput(data: string): boolean {
    return this.inkDialogsController.handleDialogInput(data);
  }

  /** Refresh Ink after an asynchronous clipboard/image editor callback. */
  updatePromptEditorView(): void {
    this.promptInputController.updatePromptEditorView();
  }

  refreshPromptCompletions(): void {
    this.promptInputController.refreshPromptCompletions();
  }

  supportsCurrentModelCapability(capability: string): boolean {
    return this.promptInputController.supportsCurrentModelCapability(capability);
  }

  uninstallRainbowDance(): void {
    this.uninstallRainbowDanceFn();
  }

  // =========================================================================
  // Input Dispatch
  // =========================================================================

  handlePlanToggle(next: boolean): void {
    this.promptInputController.handlePlanToggle(next);
  }

  handleInputModeChange(mode: "prompt" | "bash"): void {
    this.promptInputController.handleInputModeChange(mode);
  }

  /** {@link EditorKeyboardController} ink prompt bridge methods. */
  inkOwnsPromptEditor(): boolean {
    return this.promptInputController.inkOwnsPromptEditor();
  }

  getPromptEditorText(): string {
    return this.promptInputController.getPromptEditorText();
  }

  setPromptEditorText(text: string): void {
    this.promptInputController.setPromptEditorText(text);
  }

  getPromptInputMode(): "prompt" | "bash" {
    return this.promptInputController.getPromptInputMode();
  }

  setPromptInputMode(mode: "prompt" | "bash"): void {
    this.promptInputController.setPromptInputMode(mode);
  }

  insertPromptEditorText(text: string): void {
    this.promptInputController.insertPromptEditorText(text);
  }

  requestPromptEditorRender(): void {
    this.promptInputController.requestPromptEditorRender();
  }

  handleUserInput(text: string): void {
    this.promptInputController.handleUserInput(text);
  }

  runShellCommandFromInput(command: string): Promise<void> {
    return this.promptInputController.runShellCommandFromInput(command);
  }

  finishShellOutput(
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
      this.messageQueueController.drainOneQueuedMessage();
    }
  }

  enqueueMessage(
    text: string,
    options?: {
      readonly parts?: readonly PromptPart[];
      readonly imageAttachmentIds?: readonly number[];
      readonly hasMedia?: boolean;
    },
    mode?: "prompt" | "bash",
  ): void {
    this.messageQueueController.enqueueMessage(text, options, mode);
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
      this.messageQueueController.sendMessage(session, text, {
        hasMedia: true,
        parts: extraction.parts,
        imageAttachmentIds: extraction.imageAttachmentIds,
      });
    } else {
      this.messageQueueController.sendMessage(session, text);
    }
    this.updateQueueDisplay();
    this.state.ui.requestRender();
  }

  validateMediaCapabilities(extraction: {
    hasMedia: boolean;
    imageAttachmentIds: readonly number[];
    videoAttachmentIds: readonly number[];
  }): boolean {
    return this.promptInputController.validateMediaCapabilities(extraction);
  }

  persistInputHistory(text: string): Promise<void> {
    return this.promptInputController.persistInputHistory(text);
  }

  recallLastQueued(): QueuedMessage | undefined {
    return this.messageQueueController.recallLastQueued();
  }

  // =========================================================================
  // Session Requests / Queues
  // =========================================================================

  beginSessionRequest(): void {
    this.messageQueueController.beginSessionRequest();
  }

  failSessionRequest(message: string): void {
    this.messageQueueController.failSessionRequest(message);
  }

  sendQueuedMessage(session: Session, item: QueuedMessage): void {
    this.messageQueueController.sendQueuedMessage(session, item);
  }

  requestQueuedGoalPromotion(): void {
    this.messageQueueController.requestQueuedGoalPromotion();
  }

  sendSkillActivation(
    session: Session,
    skillName: string,
    skillArgs: string,
  ): void {
    this.messageQueueController.sendSkillActivation(
      session,
      skillName,
      skillArgs,
    );
  }

  activatePluginCommand(
    session: Session,
    pluginId: string,
    commandName: string,
    args: string,
  ): void {
    this.messageQueueController.activatePluginCommand(
      session,
      pluginId,
      commandName,
      args,
    );
  }

  sendMessage(
    session: Session,
    input: string,
    options?: {
      readonly parts?: readonly PromptPart[];
      readonly imageAttachmentIds?: readonly number[];
      readonly hasMedia?: boolean;
    },
  ): void {
    this.messageQueueController.sendMessage(session, input, options);
  }

  steerMessage(session: Session, input: readonly SteerInputItem[]): void {
    this.messageQueueController.steerMessage(session, input);
  }

  // =========================================================================
  // State & Accessors
  // =========================================================================

  setStartupReady(): void {
    this.tuiAccessorsController.setStartupReady();
  }

  clearQueuedMessages(): void {
    this.messageQueueController.clearQueuedMessages();
  }

  shiftQueuedMessage(): QueuedMessage | undefined {
    return this.messageQueueController.shiftQueuedMessage();
  }

  pushTranscriptEntry(entry: TranscriptEntry): void {
    this.tuiAccessorsController.pushTranscriptEntry(entry);
  }

  setExternalEditorRunning(running: boolean): void {
    this.tuiAccessorsController.setExternalEditorRunning(running);
  }

  setTasksBrowser(value: TUIState["tasksBrowser"]): void {
    this.tuiAccessorsController.setTasksBrowser(value);
  }

  appendStartupNotice(extra: string): void {
    this.tuiAccessorsController.appendStartupNotice(extra);
  }

  get backgroundTasks(): ReadonlyMap<string, BackgroundTaskInfo> {
    return this.tuiAccessorsController.backgroundTasks;
  }

  getCurrentSessionId(): string {
    return this.tuiAccessorsController.getCurrentSessionId();
  }

  hasSessionContent(): boolean {
    return this.tuiAccessorsController.hasSessionContent();
  }

  setExitOpenUrl(url: string): void {
    this.tuiAccessorsController.setExitOpenUrl(url);
  }

  setExitForegroundTask(task: (exitCode: number) => Promise<void>): void {
    this.tuiAccessorsController.setExitForegroundTask(task);
  }

  getStartupMcpMs(): Promise<number> {
    return this.tuiAccessorsController.getStartupMcpMs();
  }

  setAppState(patch: Partial<AppState>): void {
    this.tuiAccessorsController.setAppState(patch);
  }

  patchLivePane(patch: Partial<LivePaneState>): void {
    this.tuiAccessorsController.patchLivePane(patch);
  }

  resetLivePane(): void {
    this.tuiAccessorsController.resetLivePane();
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

  syncToolCallTranscriptEntry(
    toolCallId: string,
    data: ToolCallBlockData,
  ): void {
    this.transcriptCoordinator.syncToolCallTranscriptEntry(toolCallId, data);
  }

  syncShellRunTranscriptEntry(
    entryId: string,
    data: ShellRunViewState,
  ): void {
    this.transcriptCoordinator.syncShellRunTranscriptEntry(entryId, data);
  }

  syncCompactionTranscriptEntry(
    entryId: string,
    data: CompactionTranscriptData,
  ): void {
    this.transcriptCoordinator.syncCompactionTranscriptEntry(entryId, data);
  }

  syncAgentGroupTranscriptEntry(
    entryId: string,
    data: AgentGroupViewState,
    memberToolCallIds: readonly string[],
  ): void {
    this.transcriptCoordinator.syncAgentGroupTranscriptEntry(
      entryId,
      data,
      memberToolCallIds,
    );
  }

  syncReadGroupTranscriptEntry(
    entryId: string,
    data: ReadGroupViewState,
    memberToolCallIds: readonly string[],
  ): void {
    this.transcriptCoordinator.syncReadGroupTranscriptEntry(
      entryId,
      data,
      memberToolCallIds,
    );
  }

  removeToolCallTranscriptEntry(toolCallId: string): void {
    this.transcriptCoordinator.removeToolCallTranscriptEntry(toolCallId);
  }

  appendApprovalTranscriptEntry(
    request: ApprovalRequest,
    response: ApprovalResponse,
  ): void {
    this.transcriptCoordinator.appendApprovalTranscriptEntry(request, response);
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
      trustPrompt: this.startupPanelsController.getTrustPromptView(),
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
   * Ink is the sole terminal owner. The legacy kimi-tui differential renderer
   * loop stays stopped so only one renderer attaches stdin/stdout at a time.
   */
  mountInkRenderer(options?: InkTerminalRendererOptions): InkTerminalRenderer {
    if (this.inkRenderer !== undefined) return this.inkRenderer;
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
    this.updateInkRenderer();
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
    this.startupPanelsController.mountEditorReplacement(panel);
  }

  restoreEditor(): void {
    this.startupPanelsController.restoreEditor();
  }

  restoreInputText(text: string): void {
    this.startupPanelsController.restoreInputText(text);
  }

  showHelpPanel(): void {
    this.startupPanelsController.showHelpPanel();
  }

  hideHelpPanel(): void {
    this.startupPanelsController.hideHelpPanel();
  }

  showApprovalPanel(
    payload: Parameters<StartupPanelsController["showApprovalPanel"]>[0],
  ): void {
    this.startupPanelsController.showApprovalPanel(payload);
  }

  hideApprovalPanel(): void {
    this.startupPanelsController.hideApprovalPanel();
  }

  showQuestionDialog(
    payload: Parameters<StartupPanelsController["showQuestionDialog"]>[0],
  ): void {
    this.startupPanelsController.showQuestionDialog(payload);
  }

  hideQuestionDialog(): void {
    this.startupPanelsController.hideQuestionDialog();
  }

  showSessionPicker(): Promise<void> {
    return this.startupPanelsController.showSessionPicker();
  }

  hideSessionPicker(): void {
    this.startupPanelsController.hideSessionPicker();
  }

  openUndoSelector(): void {
    void slashCommands.handleUndoCommand(this, "");
  }
}

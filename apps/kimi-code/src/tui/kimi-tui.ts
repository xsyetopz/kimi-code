import type {
  BackgroundTaskInfo,
  KimiHarness,
  PromptPart,
  Session,
} from "@moonshot-ai/kimi-code-sdk";
import { detectFdPath } from "#/utils/process/fd-detect";
import type { KimiSlashCommand } from "./commands/index.ts";
import type { SessionRow } from "./components/dialogs/session-picker.ts";
import type { TrustPromptChoice } from "./components/dialogs/trust-prompt.ts";
import { ShellRunComponent } from "./components/messages/shell-run.ts";
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
import {
  createInitialAppState,
  type KimiTUIStartupInput,
} from "./kimi-tui-startup.ts";
import { KimiTuiTerminalsController } from "./kimi-tui-terminals.ts";
import type { InkTerminalRenderer } from "./renderer/ink/terminal-renderer.ts";
import type { InkTerminalRendererOptions } from "./renderer/ink/terminal-renderer.ts";
import type { TerminalOwnership } from "./renderer/terminal-owner.ts";
import type { PromptEditorState } from "./renderer/prompt-editor-state.ts";
import type { TerminalViewState } from "./renderer/terminal-view-state.ts";
import { registerReverseRPCHandlers } from "./reverse-rpc/index.ts";
import { ApprovalController } from "./reverse-rpc/approval/controller.ts";
import { QuestionController } from "./reverse-rpc/question/controller.ts";
import type { ResolvedTheme, ThemeName } from "./theme/index.ts";
import { createTUIState, type TUIState } from "./tui-state.ts";
import {
  type AppState,
  type KimiTUIOptions,
  type LivePaneState,
  type QueuedMessage,
  type SteerInputItem,
  type TranscriptEntry,
} from "./types.ts";
import { ImageAttachmentStore } from "./utils/image-attachment-store.ts";

export type { TUIState } from "./tui-state.ts";
export { createTUIState } from "./tui-state.ts";
export type {
  KimiTUIOptions,
  LoginProgressSpinnerHandle,
  TUIStartupOptions,
  TUIStartupState,
} from "./types.ts";
export type { KimiTUIStartupInput } from "./kimi-tui-startup.ts";
export type { KimiTUIDialogDelegates } from "./kimi-tui-dialog-delegates.ts";
export type { KimiTUITranscriptDelegates } from "./kimi-tui-transcript-delegates.ts";

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
  /** Whether the harness runs on the agent-core-v2 engine (lazy session creation). */
  readonly engineV2: boolean;
  startupNotice: string | undefined;
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
  readonly terminalsController: KimiTuiTerminalsController;

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

  track(event: string, properties?: Parameters<KimiHarness["track"]>[1]): void {
    this.harness.track(event, properties);
  }

  /** Current terminal owner, exposed for lifecycle diagnostics and tests. */
  get terminalRendererOwner(): "none" | "ink" {
    return this.terminalsController.terminalRendererOwner;
  }

  /** Shared terminal ownership guard used by lifecycle and renderer code. */
  get terminalOwnership(): TerminalOwnership {
    return this.terminalsController.terminalOwnership;
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
    this.terminalsController = new KimiTuiTerminalsController(this);

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

  getSlashCommands(): readonly KimiSlashCommand[] {
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
  set trustPromptChoiceResolver(resolver:
    | ((choice: TrustPromptChoice) => void)
    | undefined,) {
    this.startupPanelsController.setTrustPromptChoiceResolver(resolver);
  }

  /** @internal Legacy test hook — forwards to {@link StartupPanelsController}. */
  set inkSessionPickerSelect(select:
    | ((session: SessionRow) => void)
    | undefined,) {
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
    return this.promptInputController.supportsCurrentModelCapability(
      capability,
    );
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
    this.promptInputController.finishShellOutput(
      commandId,
      stdout,
      stderr,
      isError,
      backgrounded,
    );
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
    this.promptInputController.handleShellOutput(event);
  }

  handleShellStarted(event: { commandId: string; taskId: string }): void {
    this.promptInputController.handleShellStarted(event);
  }

  cancelRunningShellCommand(): void {
    this.promptInputController.cancelRunningShellCommand();
  }

  async sendNormalUserInput(text: string): Promise<void> {
    return this.promptInputController.sendNormalUserInput(text);
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

  sendInlineSkillActivation(
    session: Session,
    invocations: readonly { skillName: string; args: string }[],
    userText: string,
  ): void {
    this.messageQueueController.sendInlineSkillActivation(
      session,
      invocations,
      userText,
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
    return this.sessionOrchestration.fetchSessions(scope);
  }

  updateTerminalTitle(): void {
    return this.sessionOrchestration.updateTerminalTitle();
  }

  resetSessionRuntime(): void {
    return this.sessionOrchestration.resetSessionRuntime();
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

  getTerminalViewState(): TerminalViewState {
    return this.terminalsController.getTerminalViewState();
  }

  mountInkRenderer(options?: InkTerminalRendererOptions): InkTerminalRenderer {
    return this.terminalsController.mountInkRenderer(options);
  }

  updateInkRenderer(): void {
    this.terminalsController.updateInkRenderer();
  }

  requestTerminalRender(): void {
    this.terminalsController.requestTerminalRender();
  }

  unmountInkRenderer(): void {
    this.terminalsController.unmountInkRenderer();
  }

  toggleToolOutputExpansion(): void {
    this.presentationStateController.toggleToolOutputExpansion();
  }

  toggleTodoPanelExpansion(): void {
    this.presentationStateController.toggleTodoPanelExpansion();
  }

  updateEditorBorderHighlight(text?: string): void {
    this.presentationStateController.updateEditorBorderHighlight(text);
  }

  async applyTheme(
    themeName: ThemeName,
    resolved?: ResolvedTheme,
  ): Promise<void> {
    return this.presentationStateController.applyTheme(themeName, resolved);
  }
}

import { installKimiTUIDialogDelegates } from "./kimi-tui-dialog-delegates.ts";
import { installKimiTUITranscriptDelegates } from "./kimi-tui-transcript-delegates.ts";

installKimiTUITranscriptDelegates(KimiTUI);
installKimiTUIDialogDelegates(KimiTUI);

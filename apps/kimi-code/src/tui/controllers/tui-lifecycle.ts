import process from "node:process";

import type {
  CreateSessionOptions,
  KimiHarness,
  Session,
} from "@moonshot-ai/kimi-code-sdk";
import { resolve } from "pathe";

import { ensureFdPath } from "#/utils/process/fd-detect";
import { startupTrace } from "#/utils/startup-trace";
import { restoreTerminalModes } from "#/utils/terminal-restore";

import { BannerProvider } from "../banner/banner-provider";
import {
  readBannerDisplayState,
  writeBannerDisplayState,
} from "../banner/state";
import type { SkillListSession } from "../commands";
import { setExperimentalFeatures } from "../commands";
import { BannerComponent } from "../components/chrome/banner";
import { GutterContainer } from "../components/chrome/gutter-container";
import { WelcomeComponent } from "../components/chrome/welcome";
import { SESSIONLESS_STARTUP_NOTICE } from "../constant/kimi-tui";
import { CHROME_GUTTER } from "../constant/rendering";
import type { AuthFlowController } from "./auth-flow";
import { ClipboardImageHintController } from "./clipboard-image-hint";
import type { BtwPanelController } from "./btw-panel";
import type { EditorKeyboardController } from "./editor-keyboard";
import type { PresentationStateController } from "./presentation-state";
import type { SessionEventHandler } from "./session-event-handler";
import type { SessionReplayRenderer } from "./session-replay";
import type { StreamingUIController } from "./streaming-ui";
import type { TasksBrowserController } from "./tasks-browser";
import type { TranscriptCoordinator } from "./transcript-coordinator";
import type { InkTerminalRendererOptions } from "../renderer/ink/terminal-renderer";
import type { TerminalOwnership } from "../renderer/terminal-owner";
import type { ColorToken } from "../theme";
import { currentTheme } from "../theme";
import type { TUIState } from "../tui-state";
import type { KimiTUIOptions } from "../types";
import { isDeadTerminalError } from "../utils/dead-terminal";
import { installInputLatencyProbe } from "../utils/input-latency";
import { REPLAY_TURN_LIMIT } from "../utils/message-replay";
import {
  combineStartupNotice,
  isOAuthLoginRequiredError,
} from "../utils/startup";
import { installTerminalFocusTracking } from "../utils/terminal-focus";
import { detectTmuxKeyboardWarning } from "../utils/tmux-keyboard";

type MutableCreateSessionOptions = {
  -readonly [P in keyof CreateSessionOptions]: CreateSessionOptions[P];
};

export interface TuiLifecycleHost {
  state: TUIState;
  session: Session | undefined;
  aborted: boolean;
  fdPath: string | null;
  startupNotice: string | undefined;
  readonly harness: KimiHarness;
  readonly options: KimiTUIOptions;
  readonly engineV2: boolean;
  readonly terminalOwnership: TerminalOwnership;
  readonly reverseRpcDisposers: Array<() => void>;
  readonly presentationStateController: PresentationStateController;
  readonly streamingUI: StreamingUIController;
  readonly authFlow: AuthFlowController;
  readonly sessionReplay: SessionReplayRenderer;
  readonly sessionEventHandler: SessionEventHandler;
  readonly tasksBrowserController: TasksBrowserController;
  readonly btwPanelController: BtwPanelController;
  readonly editorKeyboard: EditorKeyboardController;
  readonly transcriptCoordinator: TranscriptCoordinator;
  readonly onExit?: (exitCode?: number) => Promise<void>;

  maybeRunWorkspaceTrustPrompt(): Promise<boolean>;
  setupAutocomplete(): void;
  loadPersistedInputHistory(): Promise<void>;
  renderWelcome(): void;
  handleInkInput(data: string): void;
  refreshTerminalThemeTracking(): void;
  mountInkRenderer(options?: InkTerminalRendererOptions): unknown;
  unmountInkRenderer(): void;
  supportsCurrentModelCapability(capability: string): boolean;
  showStatus(message: string, color?: ColorToken): void;
  showConfigWarningsIfAny(): Promise<void>;
  bootstrapFromPicker(): Promise<void>;
  requireSession(): Session;
  applyStartupPermissionAndPlanToAppState(): void;
  fetchSessions(scope?: "cwd" | "all"): Promise<void>;
  updateTerminalTitle(): void;
  refreshSkillCommands(session?: SkillListSession): Promise<void>;
  refreshPluginCommands(session?: Session): Promise<void>;
  hydrateLazyConfigDefaults(): Promise<void>;
  appendStartupNotice(extra: string): void;
  applyStartupModesToResumedSession(session: Session): Promise<void>;
  setSession(session: Session): Promise<void>;
  syncRuntimeState(session?: Session): Promise<void>;
  closeSession(reason: string): Promise<void>;
  updateInkRenderer(): void;
}

export class TuiLifecycleController {
  private fdDownloadStarted = false;
  private terminalFocusTrackingDispose: (() => void) | undefined;
  private clipboardImageHintController:
    | ClipboardImageHintController
    | undefined;
  private signalCleanupHandlers: Array<() => void> = [];
  private isShuttingDown = false;
  private backgroundRefreshPromise: Promise<void> | undefined;

  constructor(private readonly host: TuiLifecycleHost) {}

  buildLayout(): void {
    const { ui } = this.host.state;
    ui.clear();
    ui.addChild(this.host.state.transcriptContainer);
    ui.addChild(this.host.state.activityContainer);
    ui.addChild(this.host.state.todoPanelContainer);
    ui.addChild(this.host.state.queueContainer);
    ui.addChild(this.host.state.btwPanelContainer);
    ui.addChild(this.host.state.editorContainer);
    // Footer is mounted later (mountFooter), not here.
  }

  async start(): Promise<void> {
    startupTrace("tui:start");
    // Signal handlers must be installed before raw mode to avoid EIO loops.
    this.registerSignalHandlers();
    // Outer try rolls back signal listeners on startup failure.
    try {
      startupTrace("trustPrompt:begin");
      const trustPromptStartedLoop =
        await this.host.maybeRunWorkspaceTrustPrompt();
      startupTrace("trustPrompt:end");
      startupTrace("initMainTui:begin");
      const shouldReplayHistory = await this.initMainTuiInternal();
      startupTrace("initMainTui:end");
      // Debug-only input→render latency overlay (KIMI_TUI_INPUT_LATENCY=1).
      if (process.env["KIMI_TUI_INPUT_LATENCY"])
        installInputLatencyProbe(this.host.state.ui);
      // When the trust prompt already started the event loop, starting it
      // again would mount a second renderer and duplicate stdin listeners.
      if (!trustPromptStartedLoop) this.startEventLoop();
      startupTrace("eventLoop:started");
      try {
        this.startBackgroundFdAutocomplete();
        startupTrace("finishStartup:begin");
        await this.finishStartupInternal(shouldReplayHistory);
        startupTrace("finishStartup:end");
      } catch (error) {
        this.disposeTerminalTracking();
        this.host.state.ui.stop();
        throw error;
      }
    } catch (error) {
      this.unregisterSignalHandlers();
      throw error;
    }
  }

  async stop(exitCode?: number): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    this.unregisterSignalHandlers();
    this.host.aborted = true;
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
    this.host.streamingUI.discardPending();
    // Stop background polling, streaming intervals, and per-component timers
    // before tearing the UI down, so they can't keep firing requestRender after
    // stop() returns (or leak when stop() runs without process.exit).
    this.host.tasksBrowserController.close();
    this.host.btwPanelController.clear();
    this.host.presentationStateController.dispose();
    this.host.streamingUI.disposeActiveCompactionBlock();
    this.host.streamingUI.resetToolUi();
    this.host.transcriptCoordinator.disposeTranscriptChildren();
    this.host.editorKeyboard.dispose();
    this.host.state.footer.dispose();
    for (const dispose of this.host.reverseRpcDisposers) {
      dispose();
    }
    this.host.reverseRpcDisposers.length = 0;
    this.disposeTerminalTracking();
    // Restore the terminal even if closing the session / harness throws — a
    // SIGTERM during a network or MCP shutdown must not leave the user stuck in
    // raw mode with a hidden cursor.
    try {
      await this.host.closeSession("shutting down");
      await this.host.harness.close();
    } finally {
      this.host.unmountInkRenderer();
      this.host.sessionEventHandler.stopAllMcpServerStatusSpinners();
      try {
        await this.host.state.terminal.drainInput();
      } catch {
        // best effort — the terminal may already be dead (SIGHUP / EIO).
      }
      try {
        this.host.state.ui.stop();
      } catch {
        // best effort terminal restore.
      }
    }
    if (this.host.onExit) {
      await this.host.onExit(exitCode);
    }
  }

  suspendTerminal(): void {
    this.disposeTerminalTracking();
    this.host.unmountInkRenderer();
    try {
      this.host.state.ui.stop();
    } finally {
      this.host.terminalOwnership.release("ink");
    }
  }

  resumeTerminal(): void {
    this.startEventLoop();
  }

  /** @internal Test and startup hook — runs session/bootstrap init without the event loop. */
  init(): Promise<boolean> {
    return this.initSession();
  }

  /** @internal Test hook — post-init startup UI without the event loop. */
  finishStartup(shouldReplayHistory: boolean): Promise<void> {
    return this.finishStartupInternal(shouldReplayHistory);
  }

  /** @internal Test hook — session init plus footer/welcome mount without the event loop. */
  initMainTui(): Promise<boolean> {
    return this.initMainTuiInternal();
  }

  private async initMainTuiInternal(): Promise<boolean> {
    const shouldReplayHistory = await this.initSession();

    // Mount only after init() succeeds; see mountFooter().
    this.mountFooter();
    this.host.renderWelcome();
    void this.loadBanner();
    this.host.setupAutocomplete();
    void this.host.loadPersistedInputHistory();
    this.host.state.editorContainer.clear();
    this.host.state.editorContainer.addChild(this.host.state.editor);
    this.host.state.ui.setFocus(this.host.state.editor);
    return shouldReplayHistory;
  }

  startEventLoop(): void {
    // Dispose any previous focus/clipboard/theme tracking so re-entering the
    // event loop (e.g. a future TUI reconnect) can't stack duplicate listeners.
    this.disposeTerminalTracking();
    this.startInkEventLoop();
  }

  /** Start the Ink terminal owner without starting the legacy render loop. */
  private startInkEventLoop(): void {
    if (this.host.terminalOwnership.current === "ink") return;

    // TUI.requestRender() remains used by existing controllers, but its
    // output is suppressed while stopped. Ink is the sole stdout owner.
    this.host.state.ui.stop();
    // Legacy `ui.stop()` may pause stdin even when `start()` never ran; Ink
    // reads via the 'readable' event and needs a flowing stdin stream.
    if (process.stdin.isPaused()) {
      process.stdin.resume();
    }
    this.host.mountInkRenderer({
      onInput: (data) => this.host.handleInkInput(data),
    });
    this.startClipboardImageHintController();
    this.terminalFocusTrackingDispose = installTerminalFocusTracking(
      this.host.state,
    );
    this.host.refreshTerminalThemeTracking();
  }

  private async loadBanner(): Promise<void> {
    const provider = new BannerProvider(this.host.state.appState.version);
    const displayState = await readBannerDisplayState();
    const now = new Date();
    const banner = await provider.load(fetch, {
      state: displayState,
      now,
    });
    this.host.state.appState.banner = banner;
    if (banner === null) return;

    this.renderBanner();
    this.host.state.ui.requestRender();

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
      this.host.state.appState.banner === null ||
      this.host.state.appState.banner === undefined
    ) {
      return;
    }
    if (
      this.host.state.transcriptContainer.children.some(
        (child) => child instanceof BannerComponent,
      )
    ) {
      return;
    }
    const welcomeIndex = this.host.state.transcriptContainer.children.findIndex(
      (child) => child instanceof WelcomeComponent,
    );
    const banner = new BannerComponent(this.host.state.appState.banner);
    if (welcomeIndex >= 0) {
      this.host.state.transcriptContainer.children.splice(
        welcomeIndex + 1,
        0,
        banner,
      );
    } else {
      this.host.state.transcriptContainer.children.unshift(banner);
    }
    this.host.state.transcriptContainer.invalidate();
  }

  private startClipboardImageHintController(): void {
    this.clipboardImageHintController = new ClipboardImageHintController({
      ui: this.host.state.ui,
      footer: this.host.state.footer,
      getModelSupportsImage: () =>
        this.host.supportsCurrentModelCapability("image_in"),
      requestRender: () => {
        this.host.state.ui.requestRender();
      },
    });
    this.clipboardImageHintController.start();
  }

  private startBackgroundFdAutocomplete(): void {
    if (this.host.fdPath !== null || this.fdDownloadStarted) return;
    this.fdDownloadStarted = true;

    void ensureFdPath()
      .then((fdPath) => {
        if (fdPath === null) return;
        this.host.fdPath = fdPath;
        this.host.setupAutocomplete();
      })
      .catch(() => {
        // Best-effort background bootstrap: autocomplete keeps using the filesystem fallback.
      });
  }

  private async refreshProviderModelsInBackground(): Promise<void> {
    try {
      const result = await this.host.authFlow.refreshProviderModels();
      for (const c of result.changed) {
        if (c.added <= 0) continue;
        this.host.showStatus(
          `${c.providerName} · +${String(c.added)} model${c.added > 1 ? "s" : ""}.`,
        );
      }
      for (const f of result.failed) {
        this.host.showStatus(
          `Skipped refreshing ${f.provider}: ${f.reason}`,
          "warning",
        );
      }
    } catch {
      // Best-effort: startup must not crash on background refresh failures.
    }
  }

  private async finishStartupInternal(shouldReplayHistory: boolean): Promise<void> {
    if (this.host.startupNotice !== undefined) {
      this.host.showStatus(this.host.startupNotice);
      this.host.startupNotice = undefined;
    }
    void this.showTmuxKeyboardWarningIfNeeded();
    // Config diagnostics (deprecated keys/env vars, invalid sections) in
    // warning yellow at boot; `run-prompt`/`run-v2-print` print them to
    // stderr for non-interactive runs.
    void this.host.showConfigWarningsIfAny();
    if (this.host.state.startupState === "picker") {
      void this.host.bootstrapFromPicker();
      return;
    }
    if (shouldReplayHistory) {
      await this.host.sessionReplay.hydrateFromReplay(
        this.host.requireSession(),
      );
      this.host.applyStartupPermissionAndPlanToAppState();
    }
    const resumeState = this.host.session?.getResumeState();
    if (resumeState?.warning !== undefined) {
      this.host.showStatus(`Warning: ${resumeState.warning}`, "warning");
    }
    if (this.host.session !== undefined) {
      this.host.sessionEventHandler.startSubscription();
      void this.showSessionWarningsInternal(this.host.session);
    }
    void this.host.fetchSessions();
    if (this.host.session !== undefined) {
      this.host.updateTerminalTitle();
    }
    void this.host.refreshSkillCommands(this.host.session);
    void this.host.refreshPluginCommands(this.host.session);
  }

  showSessionWarnings(session: Session): Promise<void> {
    return this.showSessionWarningsInternal(session);
  }

  private async showSessionWarningsInternal(session: Session): Promise<void> {
    try {
      const warnings = await session.getSessionWarnings();
      if (this.host.session !== session) return;
      for (const warning of warnings) {
        const severity = warning.severity === "error" ? "error" : "warning";
        this.host.showStatus(`Warning: ${warning.message}`, severity);
      }
    } catch {
      // Best-effort: startup must not block on warning retrieval.
    }
  }

  private async showTmuxKeyboardWarningIfNeeded(): Promise<void> {
    const warning = await detectTmuxKeyboardWarning();
    if (warning === undefined || this.host.aborted) return;
    this.host.showStatus(warning, "warning");
  }

  private async initSession(): Promise<boolean> {
    setExperimentalFeatures(await this.host.harness.getExperimentalFeatures());
    await this.host.authFlow.refreshAvailableModels();
    this.backgroundRefreshPromise = this.refreshProviderModelsInBackground();

    const { startup } = this.host.options;
    const { workDir } = this.host.state.appState;
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
    if (this.host.state.appState.additionalDirs.length > 0) {
      createSessionOptions.additionalDirs = [
        ...this.host.state.appState.additionalDirs,
      ];
    }

    try {
      if (isResumeStartup) {
        if (startup.sessionFlag === "") {
          this.host.state.startupState = "picker";
          this.host.updateInkRenderer();
          return false;
        }

        if (startup.sessionFlag !== undefined) {
          const sessions = await this.host.harness.listSessions({
            sessionId: startup.sessionFlag,
            workDir,
          });
          const target = sessions[0];
          if (target === undefined) {
            throw new Error(`Session "${startup.sessionFlag}" not found.`);
          }
          if (resolve(target.workDir) !== resolve(workDir)) {
            this.host.state.ui.stop();
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
          session = await this.host.harness.resumeSession({
            id: startup.sessionFlag,
            additionalDirs: createSessionOptions.additionalDirs,
            replayTurnLimit: REPLAY_TURN_LIMIT,
          });
          shouldReplayHistory = true;
        } else {
          const sessions = await this.host.harness.listSessions({ workDir });
          const target = sessions[0];
          if (target !== undefined) {
            session = await this.host.harness.resumeSession({
              id: target.id,
              additionalDirs: createSessionOptions.additionalDirs,
              replayTurnLimit: REPLAY_TURN_LIMIT,
            });
            shouldReplayHistory = true;
          } else {
            session =
              await this.host.harness.createSession(createSessionOptions);
            this.host.startupNotice = combineStartupNotice(
              this.host.startupNotice,
              `No sessions to continue under "${workDir}"; starting a fresh session.`,
            );
          }
        }
      } else if (this.host.engineV2) {
        // Lazy session creation (v2 engine): start session-less and create the
        // session on the first message. Startup flags are carried in appState
        // and applied when that session is created; until then the footer
        // shows the config defaults the engine would apply at createSession
        // time (model, permission, plan mode, thinking effort, context cap).
        await this.host.hydrateLazyConfigDefaults();
        this.host.appendStartupNotice(SESSIONLESS_STARTUP_NOTICE);
      } else {
        session = await this.host.harness.createSession(createSessionOptions);
      }
      if (session !== undefined && shouldReplayHistory) {
        await this.host.applyStartupModesToResumedSession(session);
        if (startup.model !== undefined) {
          await session.setModel(startup.model);
        }
      }
    } catch (error) {
      if (!isOAuthLoginRequiredError(error)) throw error;
      this.host.authFlow.enterLoginRequiredStartupState();
      return false;
    }

    if (!this.host.engineV2 && session === undefined) {
      throw new Error("Startup session was not initialized.");
    }
    if (session !== undefined) {
      await this.host.setSession(session);
      await this.host.syncRuntimeState(session);
    }
    this.host.applyStartupPermissionAndPlanToAppState();
    this.host.state.startupState = "ready";
    this.host.updateInkRenderer();
    return shouldReplayHistory;
  }

  // SIGHUP / dead-terminal EIO → emergencyTerminalExit (no cleanup, avoids
  // EIO write-loop that can pin a CPU core). SIGTERM → normal stop().
  private registerSignalHandlers(): void {
    this.unregisterSignalHandlers();

    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
    if (process.platform !== "win32") {
      signals.push("SIGHUP");
    }

    for (const signal of signals) {
      const handler = (): void => {
        if (signal === "SIGHUP") {
          this.emergencyTerminalExit();
          return;
        }
        const exitCode = signal === "SIGINT" ? 130 : 143;
        // Registering a signal listener disables Node's default exit, so we
        // must reinstate it after stop() or on failure.
        this.stop(exitCode).then(
          () => {
            process.exit(exitCode);
          },
          () => {
            this.emergencyTerminalExit(exitCode);
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
    this.host.presentationStateController.dispose();
    this.clipboardImageHintController?.stop();
    this.clipboardImageHintController = undefined;
    this.terminalFocusTrackingDispose?.();
    this.terminalFocusTrackingDispose = undefined;
  }

  // Footer is the only chrome with content before a session is ready, so
  // mounting it at construction lets a stray pre-start render leak it to the
  // terminal — e.g. above the error when resuming a missing session. Mount it
  // only once init() succeeds. FooterComponent isn't a Container, so wrap it to
  // pick up the same outer gutter as the panels above.
  private mountFooter(): void {
    const footerWrap = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
    footerWrap.addChild(this.host.state.footer);
    this.host.state.ui.addChild(footerWrap);
  }
}

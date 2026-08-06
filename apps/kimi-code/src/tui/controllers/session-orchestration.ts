import type {
  ApprovalRequest,
  ApprovalResponse,
  CreateSessionOptions,
  KimiHarness,
  Session,
} from "@moonshot-ai/kimi-code-sdk";
import { effectiveModelAlias } from "@moonshot-ai/kimi-code-sdk";

import { copyTextToClipboard } from "#/utils/clipboard/clipboard-text";
import { quoteShellArg } from "#/utils/shell-quote";

import type { SkillListSession } from "../commands";
import { defaultThinkingEffortFor } from "../components/dialogs/model-selector";
import type { SessionRow } from "../components/dialogs/session-picker";
import {
  LLM_NOT_SET_MESSAGE,
  NO_ACTIVE_SESSION_MESSAGE,
} from "../constant/kimi-tui";
import { createApprovalRequestHandler } from "../reverse-rpc/approval/handler";
import type { ApprovalController } from "../reverse-rpc/approval/controller";
import { createQuestionAskHandler } from "../reverse-rpc/question/handler";
import type { QuestionController } from "../reverse-rpc/question/controller";
import type { ColorToken } from "../theme";
import type { AppState, KimiTUIOptions } from "../types";
import type { TUIState } from "../tui-state";
import { formatErrorMessage } from "../utils/event-payload";
import { REPLAY_TURN_LIMIT } from "../utils/message-replay";
import { thinkingEffortFromConfig } from "../utils/thinking-config";

import type { SessionEventHandler } from "./session-event-handler";
import type { SessionReplayRenderer } from "./session-replay";

type MutableCreateSessionOptions = {
  -readonly [P in keyof CreateSessionOptions]: CreateSessionOptions[P];
};

function sameStringArrays(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export interface SessionOrchestrationHost {
  state: TUIState;
  session: Session | undefined;
  sessionEventUnsubscribe: (() => void) | undefined;
  readonly reverseRpcDisposers: Array<() => void>;
  readonly harness: KimiHarness;
  readonly options: KimiTUIOptions;
  readonly engineV2: boolean;
  readonly approvalController: ApprovalController;
  readonly questionController: QuestionController;
  readonly sessionEventHandler: SessionEventHandler;
  readonly sessionReplay: SessionReplayRenderer;

  setAppState(patch: Partial<AppState>): void;
  showError(message: string): void;
  showStatus(message: string, color?: ColorToken): void;
  resetSessionRuntime(): void;
  refreshSkillCommands(session?: SkillListSession): Promise<void>;
  refreshPluginCommands(session?: Session): Promise<void>;
  showSessionWarnings(session: Session): Promise<void>;
  clearTranscriptAndRedraw(): void;
  updateTerminalTitle(): void;
  hideSessionPicker(): void;
  appendApprovalTranscriptEntry(
    request: ApprovalRequest,
    response: ApprovalResponse,
  ): void;
}

export class SessionOrchestrationController {
  /** In-flight lazy session creation (v2 engine), shared by concurrent first-use triggers. */
  private ensureSessionPromise: Promise<Session | undefined> | null = null;

  constructor(private readonly host: SessionOrchestrationHost) {}

  requireSession(): Session {
    if (this.host.session === undefined) {
      throw new Error(NO_ACTIVE_SESSION_MESSAGE);
    }
    return this.host.session;
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
    const { startup } = this.host.options;
    const config = await this.host.harness.getConfig({ reload: true });
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
    this.host.setAppState(patch);
  }

  async createSessionFromCurrentState(
    bindStartupAgent = false,
  ): Promise<Session> {
    const model = this.host.state.appState.model.trim();
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
      this.host.session !== undefined || !this.host.engineV2
        ? this.host.state.appState.planMode
        : this.host.options.startup.plan &&
          this.host.state.appState.configDefaultPlanMode !== true;
    const options: MutableCreateSessionOptions = {
      workDir: this.host.state.appState.workDir,
      model,
      // With an active session, carry the live effort. Session-less (lazy
      // creation / `/new` before the first session), carry the session-only
      // thinking override chosen via Alt+S if any — never the initial 'off'
      // default, which would force thinking off where the engine's config or
      // model default would apply.
      thinking:
        this.host.session === undefined
          ? this.host.state.appState.lazySessionThinking
          : this.host.state.appState.thinkingEffort,
      permission: this.host.state.appState.permissionMode,
      planMode: explicitPlanMode ? true : undefined,
    };
    if (this.host.state.appState.additionalDirs.length > 0) {
      options.additionalDirs = [...this.host.state.appState.additionalDirs];
    }
    if (bindStartupAgent) {
      // The --agent/--agent-file startup binding is consumed by the first
      // lazy-created session; `/new` sessions fall back to the default profile.
      if (this.host.state.appState.agentProfile !== undefined) {
        options.agentProfile = this.host.state.appState.agentProfile;
      }
      if (this.host.state.appState.agentFiles !== undefined) {
        options.agentFiles = [...this.host.state.appState.agentFiles];
      }
    }
    return this.host.harness.createSession(options);
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
    if (this.host.session !== undefined) return this.host.session;
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
      this.host.showError(`Failed to start a session: ${msg}`);
      return;
    }
    this.host.resetSessionRuntime();
    await this.setSession(session);
    this.host.setAppState({ sessionId: session.id });
    try {
      await this.activateRuntime();
      await this.syncRuntimeState(session);
    } catch (error) {
      this.host.sessionEventHandler.startSubscription();
      const msg = formatErrorMessage(error);
      this.host.showError(`Post-create setup failed: ${msg}`);
      return;
    }
    try {
      await this.host.refreshSkillCommands(session);
      await this.host.refreshPluginCommands(session);
    } catch {
      /* keep the new session usable even if dynamic skills fail */
    }
    this.host.sessionEventHandler.startSubscription();
    void this.host.showSessionWarnings(session);
    // The session-only thinking override was consumed by this session; the
    // runtime status now owns the displayed effort.
    if (this.host.state.appState.lazySessionThinking !== undefined) {
      this.host.setAppState({ lazySessionThinking: undefined });
    }
    return session;
  }

  async setSession(session: Session): Promise<void> {
    const previous = this.unloadCurrentSession("switching session");
    await previous?.close();
    this.host.session = session;
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
    this.host.setAppState({
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
  async applyStartupModesToResumedSession(session: Session): Promise<void> {
    const { startup } = this.host.options;
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
  applyStartupPermissionAndPlanToAppState(): void {
    const { startup } = this.host.options;
    if (startup.auto) {
      this.host.setAppState({ permissionMode: "auto" });
    } else if (startup.yolo) {
      this.host.setAppState({ permissionMode: "yolo" });
    }
    if (startup.plan) {
      this.host.setAppState({ planMode: true });
    }
  }

  // Plan mode is set by createSession — do not re-enter it here.
  async activateRuntime(): Promise<void> {
    const session = this.requireSession();
    await session.setPermission(this.host.state.appState.permissionMode);
    await this.syncRuntimeState(session);
  }

  async closeSession(reason: string): Promise<void> {
    const previous = this.unloadCurrentSession(reason);
    await previous?.close();
  }

  unloadCurrentSession(reason: string): Session | undefined {
    const previous = this.host.session;
    this.host.sessionEventUnsubscribe?.();
    this.host.sessionEventUnsubscribe = undefined;
    this.clearReverseRpcPanels();
    previous?.setApprovalHandler(undefined);
    previous?.setQuestionHandler(undefined);
    this.host.approvalController.cancelAll(reason);
    this.host.questionController.cancelAll(reason);
    this.host.session = undefined;
    this.host.state.swarmModeEntry = undefined;
    this.host.setAppState({ goal: null });
    return previous;
  }

  clearReverseRpcPanels(): void {
    for (const dispose of this.host.reverseRpcDisposers) {
      dispose();
    }
    this.host.reverseRpcDisposers.length = 0;
  }

  registerSessionHandlers(session: Session): void {
    session.setApprovalHandler(
      createApprovalRequestHandler(
        this.host.approvalController,
        (request, response) => {
          this.host.appendApprovalTranscriptEntry(request, response);
        },
      ),
    );
    session.setQuestionHandler(
      createQuestionAskHandler(this.host.questionController),
    );
  }

  syncAdditionalDirs(session: Session): void {
    const additionalDirs = session.summary?.additionalDirs ?? [];
    if (sameStringArrays(this.host.state.appState.additionalDirs, additionalDirs))
      return;
    this.host.setAppState({ additionalDirs: [...additionalDirs] });
  }

  async showResumeOtherWorkDirHint(session: SessionRow): Promise<void> {
    this.host.hideSessionPicker();
    const command = `cd ${quoteShellArg(session.work_dir)} && kimi --resume ${quoteShellArg(session.id)}`;
    const message = `Current session is in a different working directory.\n  To resume, run: ${command}`;
    try {
      await copyTextToClipboard(command);
      this.host.showStatus(`${message}\n  Command copied to clipboard`, "warning");
    } catch {
      this.host.showStatus(
        `${message}\n  Failed to copy command to clipboard`,
        "warning",
      );
    }
  }

  async resumeSession(targetSessionId: string): Promise<boolean> {
    // A first-use lazy creation may still be in flight: wait it out so the
    // checks below see settled state — the pending prompt would otherwise
    // replace the resumed session when creation completes.
    await this.waitForLazyCreation();
    if (targetSessionId === this.host.state.appState.sessionId) {
      this.host.showStatus("Already on this session.");
      return true;
    }
    if (this.host.state.appState.streamingPhase !== "idle") {
      this.host.showError(
        "Cannot switch sessions while streaming — press Esc or Ctrl-C first.",
      );
      return false;
    }
    if (this.host.state.appState.isReplaying) {
      this.host.showError("Cannot switch sessions while history is replaying.");
      return false;
    }

    let session: Session;
    try {
      session = await this.host.harness.resumeSession({
        id: targetSessionId,
        replayTurnLimit: REPLAY_TURN_LIMIT,
      });
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.host.showError(`Failed to resume session ${targetSessionId}: ${msg}`);
      return false;
    }

    await this.switchToSession(session, `Resumed session (${session.id}).`);
    return true;
  }

  async switchToSession(
    session: Session,
    statusMessage: string,
  ): Promise<void> {
    this.host.resetSessionRuntime();
    await this.setSession(session);
    await this.syncRuntimeState(session);
    this.host.updateTerminalTitle();
    try {
      await this.host.refreshSkillCommands(this.host.session);
      await this.host.refreshPluginCommands(this.host.session);
    } catch {
      /* keep the switched session usable even if dynamic skills fail */
    }
    this.host.clearTranscriptAndRedraw();
    try {
      await this.host.sessionReplay.hydrateFromReplay(session);
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.host.showError(`Failed to replay session history: ${msg}`);
    } finally {
      this.host.sessionEventHandler.startSubscription();
    }
    const resumeState = session.getResumeState();
    if (resumeState?.warning !== undefined) {
      this.host.showStatus(`Warning: ${resumeState.warning}`, "warning");
    }
    this.host.showStatus(statusMessage);
    void this.host.showSessionWarnings(session);
  }

  async reloadCurrentSessionView(
    session: Session,
    statusMessage: string,
  ): Promise<void> {
    this.host.sessionEventUnsubscribe?.();
    this.host.sessionEventUnsubscribe = undefined;
    this.clearReverseRpcPanels();
    session.setApprovalHandler(undefined);
    session.setQuestionHandler(undefined);
    this.host.approvalController.cancelAll("reloading session");
    this.host.questionController.cancelAll("reloading session");

    this.host.resetSessionRuntime();
    this.host.session = session;
    this.registerSessionHandlers(session);
    await this.syncRuntimeState(session);
    this.host.updateTerminalTitle();
    try {
      await this.host.refreshSkillCommands(session);
      await this.host.refreshPluginCommands(session);
    } catch {
      /* keep the reloaded session usable even if dynamic skills fail */
    }
    this.host.sessionEventHandler.startSubscription();
    const resumeState = session.getResumeState();
    if (resumeState?.warning !== undefined) {
      this.host.showStatus(`Warning: ${resumeState.warning}`, "warning");
    }
    this.host.showStatus(statusMessage);
    void this.host.showSessionWarnings(session);
  }

  async createNewSession(): Promise<void> {
    if (this.host.state.appState.isReplaying) {
      this.host.showError("Cannot start a new session while history is replaying.");
      return;
    }

    let session: Session;
    try {
      session = await this.createSessionFromCurrentState();
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.host.showError(`Failed to start a new session: ${msg}`);
      return;
    }

    this.host.resetSessionRuntime();
    await this.setSession(session);
    this.host.setAppState({ sessionId: session.id });
    try {
      await this.activateRuntime();
      await this.syncRuntimeState(session);
    } catch (error) {
      this.host.sessionEventHandler.startSubscription();
      const msg = formatErrorMessage(error);
      this.host.showError(`Post-create setup failed: ${msg}`);
      return;
    }
    try {
      await this.host.refreshSkillCommands(this.host.session);
      await this.host.refreshPluginCommands(this.host.session);
    } catch {
      /* keep the new session usable even if dynamic skills fail */
    }
    this.host.sessionEventHandler.startSubscription();
    this.host.clearTranscriptAndRedraw();
    this.host.showStatus(`Started a new session (${session.id}).`);
    void this.host.showSessionWarnings(session);
    void this.showConfigWarningsIfAny();
  }

  /** Surface config.toml load warnings (degraded or kept-previous config) in the status bar. */
  async showConfigWarningsIfAny(): Promise<void> {
    try {
      const { warnings } = await this.host.harness.getConfigDiagnostics();
      for (const warning of warnings) {
        this.host.showStatus(warning, "warning");
      }
    } catch {
      /* diagnostics are best-effort */
    }
  }
}

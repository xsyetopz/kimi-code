import type { KimiHarness, Session } from "@moonshot-ai/kimi-code-sdk";
import {
  type Component,
  type Focusable,
} from "@moonshot-ai/kimi-tui";
import { resolve } from "pathe";

import type { KimiSlashCommand } from "#/tui/commands";
import type { InkDialogsController } from "#/tui/controllers/ink-dialogs";
import type { SessionOrchestrationController } from "#/tui/controllers/session-orchestration";
import {
  reducePromptEditor,
} from "#/tui/renderer/prompt-editor-state";
import type { TerminalTrustPromptView } from "#/tui/renderer/terminal-view-state";
import type { ApprovalController } from "#/tui/reverse-rpc/approval/controller";
import type { QuestionController } from "#/tui/reverse-rpc/question/controller";
import type {
  ApprovalPanelData,
  QuestionPanelData,
} from "#/tui/reverse-rpc/types";
import type { LivePaneState } from "#/tui/types";
import { formatErrorMessage } from "#/tui/utils/event-payload";
import { notifyTerminalOnce } from "#/tui/utils/terminal-notification";
import type { TUIState } from "../tui-state";

import type { SessionRow } from "#/tui/components/dialogs/session-picker";
import type { TrustPromptChoice } from "#/tui/components/dialogs/trust-prompt";

import type { EditorKeyboardController } from "./editor-keyboard";

export interface StartupPanelsHost {
  readonly state: TUIState;
  readonly harness: KimiHarness;
  readonly engineV2: boolean;
  readonly inkDialogsController: InkDialogsController;
  readonly approvalController: ApprovalController;
  readonly questionController: QuestionController;
  readonly sessionOrchestration: SessionOrchestrationController;
  readonly editorKeyboard: EditorKeyboardController;

  updateInkRenderer(): void;
  patchLivePane(patch: Partial<LivePaneState>): void;
  getSlashCommands(): readonly KimiSlashCommand[];
  fetchSessions(scope?: "cwd" | "all"): Promise<void>;
  applyStartupModesToResumedSession(session: Session): Promise<void>;
  applyStartupPermissionAndPlanToAppState(): void;
  requireSession(): Session;
  stop(exitCode?: number): Promise<void>;
  startEventLoop(): void;
  showError(message: string): void;
  updateEditorBorderHighlight(text?: string): void;
  toggleToolOutputExpansion(): void;
}

export class StartupPanelsController {
  private trustPromptView: TerminalTrustPromptView | null = null;
  private trustPromptChoiceResolver:
    | ((choice: TrustPromptChoice) => void)
    | undefined;
  private inkSessionPickerSelect: ((session: SessionRow) => void) | undefined;
  private inkSessionPickerCancel: (() => void) | undefined;
  private inkSessionPickerToggleScope:
    | ((sessionId: string) => void)
    | undefined;
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

  constructor(private readonly host: StartupPanelsHost) {}

  private get inkOverlay() {
    return this.host.state.inkOverlay;
  }

  /** Trust prompt payload for the terminal view snapshot (Ink / kimi-tui). */
  getTrustPromptView(): TerminalTrustPromptView | null {
    return this.trustPromptView;
  }

  mountEditorReplacement(panel: Component & Focusable): void {
    if (this.host.inkDialogsController.tryOpenFromPanel(panel)) {
      return;
    }
    this.host.state.editorContainer.clear();
    this.host.state.editorContainer.addChild(panel);
    this.host.updateInkRenderer();
  }

  restoreEditor(): void {
    this.host.inkDialogsController.closeAll();
    const children = this.host.state.editorContainer.children;
    if (children.length === 1 && children[0] === this.host.state.editor) {
      this.host.updateInkRenderer();
      return;
    }
    this.host.state.editorContainer.clear();
    this.host.state.editorContainer.addChild(this.host.state.editor);
    this.host.updateInkRenderer();
  }

  restoreInputText(text: string): void {
    this.restoreEditor();
    this.host.state.promptEditorState = reducePromptEditor(
      this.host.state.promptEditorState,
      {
        type: "set-text",
        text,
      },
    );
    this.host.updateEditorBorderHighlight(text);
    this.host.updateInkRenderer();
  }

  resolveTrustPrompt(choice: TrustPromptChoice): void {
    this.trustPromptChoiceResolver?.(choice);
  }

  setTrustPromptChoiceResolver(
    resolver: ((choice: TrustPromptChoice) => void) | undefined,
  ): void {
    this.trustPromptChoiceResolver = resolver;
  }

  setInkSessionPickerSelect(
    select: ((session: SessionRow) => void) | undefined,
  ): void {
    this.inkSessionPickerSelect = select;
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
  async maybeRunWorkspaceTrustPrompt(): Promise<boolean> {
    if (!this.host.engineV2) return false;
    const workDir = this.host.state.appState.workDir;
    let info;
    try {
      info = await this.host.harness.getWorkspaceTrustInfo(workDir);
    } catch {
      return false;
    }
    if (info.trusted) return false;
    this.host.startEventLoop();
    const choice = await new Promise<TrustPromptChoice>((resolveChoice) => {
      this.inkOverlay.dialogSelectedIndex = 0;
      this.trustPromptChoiceResolver = resolveChoice;
      this.host.state.activeDialog = "trust-prompt";
      this.trustPromptView = {
        workDir,
        gatedMcpServers: [...info.gatedMcpServers],
      };
      this.host.updateInkRenderer();
    });
    this.trustPromptChoiceResolver = undefined;
    this.host.state.activeDialog = null;
    this.trustPromptView = null;
    if (choice !== "trust") {
      // Declining trust exits the program (Claude Code's "No, exit" semantics):
      // stop() runs the standard shutdown path and ends in process.exit. The
      // editor is NOT restored first — its frame would linger as an orphaned
      // input box above the exit message; the prompt stays as the last frame.
      await this.host.stop();
      return true;
    }
    this.restoreEditor();
    try {
      await this.host.harness.trustWorkspace(workDir);
    } catch {
      // A failed write leaves the workspace untrusted (re-asked next launch).
    }
    return true;
  }

  showHelpPanel(): void {
    this.host.state.activeDialog = "help";
    this.inkOverlay.dialogScrollTop = 0;
    this.host.updateInkRenderer();
  }

  hideHelpPanel(): void {
    this.host.state.activeDialog = null;
    this.inkOverlay.dialogScrollTop = 0;
    this.restoreEditor();
  }

  async showSessionPicker(): Promise<void> {
    await this.openSessionPicker({
      applyStartupModes: false,
      closeOnCancel: false,
      forwardEditorExit: false,
    });
  }

  async bootstrapFromPicker(): Promise<void> {
    await this.openSessionPicker({
      applyStartupModes: true,
      closeOnCancel: true,
      forwardEditorExit: true,
    });
  }

  hideSessionPicker(): void {
    this.sessionPickerScopeRequestToken += 1;
    this.host.editorKeyboard.clearPendingExit();
    this.inkSessionPickerSelect = undefined;
    this.inkSessionPickerCancel = undefined;
    this.inkSessionPickerToggleScope = undefined;
    this.host.state.activeDialog = null;
    this.restoreEditor();
  }

  showApprovalPanel(payload: ApprovalPanelData): void {
    this.host.inkDialogsController.resetApprovalState();
    this.host.patchLivePane({ pendingApproval: { data: payload } });
    notifyTerminalOnce(this.host.state, `approval:${payload.id}`, {
      title: "Kimi Code approval required",
      body: payload.tool_name,
    });
    this.host.updateInkRenderer();
  }

  hideApprovalPanel(): void {
    if (this.inkOverlay.approvalPreviewBlock !== null) {
      this.host.inkDialogsController.closeApprovalPreview();
    }
    this.host.inkDialogsController.resetApprovalState();
    this.host.patchLivePane({ pendingApproval: null });
    this.restoreEditor();
  }

  showQuestionDialog(payload: QuestionPanelData): void {
    this.host.inkDialogsController.resetQuestionState();
    this.host.patchLivePane({ pendingQuestion: { data: payload } });
    notifyTerminalOnce(this.host.state, `question:${payload.id}`, {
      title: "Kimi Code needs your answer",
      body: payload.questions[0]?.question,
    });
    this.host.inkDialogsController.initQuestionState(payload.questions.length);
    this.host.updateInkRenderer();
  }

  hideQuestionDialog(): void {
    this.host.inkDialogsController.resetQuestionState();
    this.host.patchLivePane({ pendingQuestion: null });
    this.restoreEditor();
  }

  private async openSessionPicker(options: {
    readonly applyStartupModes: boolean;
    readonly closeOnCancel: boolean;
    readonly forwardEditorExit: boolean;
  }): Promise<void> {
    this.sessionPickerOptions = options;
    await this.host.fetchSessions("cwd");
    this.mountSessionPicker({
      applyStartupModes: options.applyStartupModes,
      onCancel: () => {
        this.hideSessionPicker();
        if (options.closeOnCancel) void this.host.stop(0);
      },
      onCtrlC: options.forwardEditorExit
        ? () => {
            this.host.state.editor.onCtrlC?.();
          }
        : undefined,
      onCtrlD: options.forwardEditorExit
        ? () => {
            this.host.state.editor.onCtrlD?.();
          }
        : undefined,
    });
  }

  private async applySessionPickerScopeChange(
    selectedSessionId: string,
  ): Promise<void> {
    const requestToken = ++this.sessionPickerScopeRequestToken;
    const nextScope = this.host.state.sessionsScope === "cwd" ? "all" : "cwd";
    await this.host.fetchSessions(nextScope);
    if (requestToken !== this.sessionPickerScopeRequestToken) return;
    if (this.host.state.activeDialog !== "session-picker") return;
    this.mountSessionPicker({
      initialSelectedSessionId: selectedSessionId,
      applyStartupModes: this.sessionPickerOptions.applyStartupModes,
      onCancel: () => {
        this.hideSessionPicker();
        if (this.sessionPickerOptions.closeOnCancel) void this.host.stop(0);
      },
      onCtrlC: this.sessionPickerOptions.forwardEditorExit
        ? () => {
            this.host.state.editor.onCtrlC?.();
          }
        : undefined,
      onCtrlD: this.sessionPickerOptions.forwardEditorExit
        ? () => {
            this.host.state.editor.onCtrlD?.();
          }
        : undefined,
    });
  }

  mountSessionPicker(options: {
    readonly onCancel: () => void;
    readonly onCtrlC?: () => void;
    readonly onCtrlD?: () => void;
    readonly initialSelectedSessionId?: string;
    // CLI mode flags (--auto/--yolo/--plan) target the session picked at
    // startup (bare --session); later /sessions switches keep the picked
    // session's own persisted modes.
    readonly applyStartupModes?: boolean;
  }): void {
    this.host.state.activeDialog = "session-picker";
    const initialSessionId =
      options.initialSelectedSessionId ?? this.host.state.appState.sessionId;
    const initialIndex = this.host.state.sessions.findIndex(
      (session) => session.id === initialSessionId,
    );
    this.inkOverlay.dialogSelectedIndex =
      initialIndex >= 0 ? Math.min(initialIndex, 7) : 0;
    this.inkSessionPickerSelect = (session) => {
      void this.handleSessionPickerSelect(
        session,
        options.applyStartupModes === true,
      ).catch((error) => {
        this.host.showError(
          `Failed to apply startup flags: ${formatErrorMessage(error)}`,
        );
      });
    };
    this.inkSessionPickerCancel = options.onCancel;
    this.inkSessionPickerToggleScope = (selectedSessionId) => {
      void this.applySessionPickerScopeChange(selectedSessionId);
    };
    this.host.updateInkRenderer();
  }

  private async handleSessionPickerSelect(
    session: SessionRow,
    applyStartupModes: boolean,
  ): Promise<void> {
    if (resolve(session.work_dir) !== resolve(this.host.state.appState.workDir)) {
      await this.host.sessionOrchestration.showResumeOtherWorkDirHint(session);
      if (applyStartupModes) await this.host.stop(0);
      return;
    }

    const switched = await this.host.sessionOrchestration.resumeSession(
      session.id,
    );
    if (!switched) return;
    if (applyStartupModes) {
      await this.host.applyStartupModesToResumedSession(this.host.requireSession());
      this.host.applyStartupPermissionAndPlanToAppState();
    }
    this.hideSessionPicker();
  }
}

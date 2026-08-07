import type { KimiSlashCommand } from "./commands";
import type { InkDialogsController } from "./controllers/ink-dialogs";
import type { PresentationStateController } from "./controllers/presentation-state";
import type { StartupPanelsController } from "./controllers/startup-panels";
import {
  type InkTerminalRenderer,
  type InkTerminalRendererOptions,
  mountInkTerminalRenderer,
} from "./renderer/ink/terminal-renderer";
import {
  type PromptEditorState,
  promptEditorLineColumn,
} from "./renderer/prompt-editor-state";
import { TerminalOwnership } from "./renderer/terminal-owner";
import {
  type TerminalHelpCommandView,
  type TerminalSessionView,
  type TerminalViewState,
  createTerminalViewState,
} from "./renderer/terminal-view-state";
import type { TUIState } from "./tui-state";

export interface KimiTuiTerminalsHost {
  readonly state: TUIState;
  readonly deferUserMessages: boolean;
  readonly inkDialogsController: InkDialogsController;
  readonly presentationStateController: PresentationStateController;
  readonly startupPanelsController: StartupPanelsController;

  getSlashCommands(): readonly KimiSlashCommand[];
  get promptEditorState(): PromptEditorState;
}

export class KimiTuiTerminalsController {
  private inkRenderer: InkTerminalRenderer | undefined;
  readonly terminalOwnership = new TerminalOwnership();

  constructor(private readonly host: KimiTuiTerminalsHost) {}

  /** Current terminal owner, exposed for lifecycle diagnostics and tests. */
  get terminalRendererOwner(): "none" | "ink" {
    return this.terminalOwnership.current;
  }

  /** Snapshot terminal data for renderer implementations without UI objects. */
  getTerminalViewState(): TerminalViewState {
    const helpCommands: readonly TerminalHelpCommandView[] = this.host
      .getSlashCommands()
      .map((command) => ({
        name: command.name,
        aliases: [...command.aliases],
        description: command.description,
      }));
    const sessions: readonly TerminalSessionView[] =
      this.host.state.sessions.map((session) => ({
        id: session.id,
        title: session.title,
        lastPrompt: session.last_prompt ?? null,
        workDir: session.work_dir,
        updatedAt: session.updated_at,
      }));
    return createTerminalViewState({
      appState: this.host.state.appState,
      startupState: this.host.state.startupState,
      transcriptEntries: this.host.state.transcriptEntries,
      livePane: this.host.state.livePane,
      queuedMessages: this.host.state.queuedMessages,
      editor: {
        text: this.host.promptEditorState.text,
        cursorLine: promptEditorLineColumn(this.host.promptEditorState).line,
        cursorColumn: promptEditorLineColumn(this.host.promptEditorState)
          .column,
        inputMode: this.host.promptEditorState.inputMode,
        autocomplete: this.host.promptEditorState.completion?.items ?? [],
      },
      activeDialog: this.host.state.activeDialog,
      ...this.host.inkDialogsController.projectDialogFields(),
      sessions,
      loadingSessions: this.host.state.loadingSessions,
      sessionsScope: this.host.state.sessionsScope,
      helpCommands,
      trustPrompt: this.host.startupPanelsController.getTrustPromptView(),
      toolOutputExpanded: this.host.state.toolOutputExpanded,
      externalEditorRunning: this.host.state.externalEditorRunning,
      queuedMessageDispatchPending:
        this.host.state.queuedMessageDispatchPending,
      swarmModeEntry: this.host.state.swarmModeEntry,
      deferUserMessages: this.host.deferUserMessages,
      activityTip: this.host.presentationStateController.getActivityTip(),
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
}

import type { PromptPart, Session } from "@moonshot-ai/kimi-code-sdk";

import {
  appendInputHistory,
  loadInputHistory,
} from "#/utils/history/input-history";
import { getInputHistoryFile } from "#/utils/paths";

import * as slashCommands from "../commands/dispatch";
import type { SlashCommandHost } from "../commands/dispatch";
import type { KimiSlashCommand } from "../commands";
import { LLM_NOT_SET_MESSAGE } from "../constant/kimi-tui";
import { ShellRunComponent } from "../components/messages/shell-run";
import {
  routePromptEditorInput,
  type PromptSemanticAction,
} from "../renderer/prompt-editor-input";
import {
  type PromptEditorAction,
  type PromptEditorState,
  reducePromptEditor,
} from "../renderer/prompt-editor-state";
import type { InkOverlayState } from "../renderer/ink/overlay-state";
import { currentTheme } from "../theme";
import type { AppState, ShellRunViewState, TranscriptEntry } from "../types";
import { formatErrorMessage } from "../utils/event-payload";
import type { ImageAttachmentStore } from "../utils/image-attachment-store";
import { extractMediaAttachments } from "../utils/image-placeholder";
import { formatBashOutputForDisplay } from "../utils/shell-output";
import { markTranscriptComponent } from "../utils/transcript-component-metadata";
import { nextTranscriptId } from "../utils/transcript-id";

import type { BtwPanelController } from "./btw-panel";
import type { EditorKeyboardController } from "./editor-keyboard";
import type { InkDialogsController } from "./ink-dialogs";
import type { MessageQueueController } from "./message-queue";
import type { ShellOutputStreamEntry } from "./presentation-state";

interface EnqueueMessageOptions {
  readonly parts?: readonly PromptPart[];
  readonly imageAttachmentIds?: readonly number[];
  readonly hasMedia?: boolean;
}

export interface PromptInputHost extends SlashCommandHost {
  readonly inkOverlay: InkOverlayState;
  readonly inkDialogsController: InkDialogsController;
  readonly editorKeyboard: EditorKeyboardController;
  readonly btwPanelController: BtwPanelController;
  readonly messageQueueController: MessageQueueController;
  readonly shellOutputStreams: Map<string, ShellOutputStreamEntry>;
  readonly engineV2: boolean;
  readonly imageStore: ImageAttachmentStore;

  updateInkRenderer(): void;
  updateEditorBorderHighlight(text?: string): void;
  getSlashCommands(): readonly KimiSlashCommand[];
  enqueueMessage(
    text: string,
    options?: EnqueueMessageOptions,
    mode?: "prompt" | "bash",
  ): void;
  updateQueueDisplay(): void;
  ensureSession(): Promise<Session | undefined>;
  showError(message: string): void;
  setAppState(patch: Partial<AppState>): void;
  syncShellRunTranscriptEntry(
    entryId: string,
    data: ShellRunViewState,
  ): void;
  persistInputHistory(text: string): Promise<void>;
}

export class PromptInputController {
  private lastHistoryContent: string | undefined;

  constructor(private readonly host: PromptInputHost) {}

  private get promptEditorState(): PromptEditorState {
    return this.host.state.promptEditorState;
  }

  private set promptEditorState(state: PromptEditorState) {
    this.host.state.promptEditorState = state;
  }

  /** Route normal prompt input through the renderer-neutral editor model. */
  handleInkInput(data: string): void {
    if (this.host.inkOverlay.approvalPreviewBlock !== null) {
      if (this.host.inkDialogsController.handleApprovalPreviewInput(data))
        return;
      this.host.updateInkRenderer();
      return;
    }
    const hasLegacyDialog =
      this.host.state.activeDialog !== null ||
      this.host.state.livePane.pendingApproval !== null ||
      this.host.state.livePane.pendingQuestion !== null;
    if (hasLegacyDialog) {
      if (this.host.inkDialogsController.handleDialogInput(data)) return;
      this.host.state.ui.dispatchInput(data);
      this.host.updateInkRenderer();
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
      this.host.updateInkRenderer();
    } else if (route.type === "semantic") {
      this.handlePromptSemantic(route.action);
    }
  }

  /** Refresh Ink after an asynchronous clipboard/image editor callback. */
  updatePromptEditorView(): void {
    this.host.updateInkRenderer();
  }

  handlePromptSemantic(action: PromptSemanticAction): void {
    const consumed = this.host.editorKeyboard.dispatchPromptSemantic(action);
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
    this.host.updateInkRenderer();
  }

  applyPromptEditorAction(action: PromptEditorAction): void {
    this.promptEditorState = reducePromptEditor(this.promptEditorState, action);
    this.syncLegacyPromptEditor();
    this.refreshPromptCompletions();
    this.host.updateEditorBorderHighlight(this.promptEditorState.text);
    this.host.updateInkRenderer();
  }

  syncLegacyPromptEditor(): void {
    if (this.host.state.appState.inputMode !== this.promptEditorState.inputMode) {
      this.host.setAppState({ inputMode: this.promptEditorState.inputMode });
    }
  }

  refreshPromptCompletions(): void {
    const { text, inputMode } = this.promptEditorState;
    if (inputMode !== "prompt" || !/^\/\S*$/u.test(text)) {
      this.promptEditorState = reducePromptEditor(this.promptEditorState, {
        type: "completion-cancel",
      });
      return;
    }
    const prefix = text.slice(1).toLowerCase();
    const items = this.host
      .getSlashCommands()
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

  handlePlanToggle(next: boolean): void {
    void slashCommands.handlePlanCommand(this.host, next ? "on" : "off");
  }

  handleInputModeChange(mode: "prompt" | "bash"): void {
    this.host.setAppState({ inputMode: mode });
    this.promptEditorState = reducePromptEditor(this.promptEditorState, {
      type: "set-mode",
      inputMode: mode,
    });
    this.host.updateEditorBorderHighlight();
  }

  /** {@link EditorKeyboardController} ink prompt bridge methods. */
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
    this.host.updateInkRenderer();
  }

  handleUserInput(text: string): void {
    const wasBashMode = this.host.state.appState.inputMode === "bash";
    if (wasBashMode) {
      // A submit always exits bash mode (the `!` is consumed by this command).
      this.host.state.editor.inputMode = "prompt";
      this.handleInputModeChange("prompt");
    }
    if (text.trim().length === 0) return;
    if (this.host.state.appState.isReplaying) {
      this.host.showError("Cannot send input while session history is replaying.");
      return;
    }
    // Shell commands are stored with a leading `!` so ↑ recall can tell them
    // apart from prompts and restore bash mode (see CustomEditor's mode-aware
    // history navigation). The `!` is stripped again when the entry is recalled.
    const historyText = wasBashMode ? `!${text}` : text;
    void this.host.persistInputHistory(historyText);
    if (wasBashMode) {
      // Only one foreground action at a time: queue the shell command while
      // another shell command is running or an agent turn is in progress.
      if (this.host.state.appState.streamingPhase !== "idle") {
        this.host.enqueueMessage(text, undefined, "bash");
        this.host.updateQueueDisplay();
        this.host.state.ui.requestRender();
        return;
      }
      void this.runShellCommandFromInput(text);
      return;
    }
    slashCommands.dispatchInput(this.host, text);
  }

  async runShellCommandFromInput(command: string): Promise<void> {
    let session = this.host.session;
    if (session === undefined) {
      if (!this.host.engineV2) {
        this.host.showError("No active session for shell command.");
        return;
      }
      session = await this.host.ensureSession();
      if (session === undefined) return;
      // A concurrent first message may have started a prompt while this lazy
      // creation was in flight (both inputs share the same creation promise);
      // honor the busy gate here, like handleUserInput does before the await,
      // instead of running the shell command concurrently with an agent turn.
      if (this.host.state.appState.streamingPhase !== "idle") {
        this.host.enqueueMessage(command, undefined, "bash");
        this.host.updateQueueDisplay();
        this.host.state.ui.requestRender();
        return;
      }
    }
    // Echo the command locally (bash-input) with a `$` prompt. The agent also
    // records it for resume; this is the live view.
    this.host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: "user",
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
      renderMode: "plain",
      content: "",
    };
    const mirrorShellRunToInk = (): void => {
      this.host.syncShellRunTranscriptEntry(
        commandId,
        outputComponent.captureShellRunState(),
      );
    };
    const outputComponent = new ShellRunComponent(
      () => this.host.state.ui.requestRender(),
      mirrorShellRunToInk,
    );
    this.host.shellOutputStreams.set(commandId, {
      entry: outputEntry,
      component: outputComponent,
    });
    mirrorShellRunToInk();
    this.host.state.transcriptEntries.push(outputEntry);
    markTranscriptComponent(outputComponent, outputEntry);
    this.host.state.transcriptContainer.addChild(outputComponent);
    // Treat command execution as a streaming phase so input queues, the activity
    // pane shows the moon spinner, and ctrl+b is enabled while it runs.
    this.host.setAppState({ streamingPhase: "shell" });
    this.host.state.ui.requestRender();

    this.host.track("shell_command");

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
        this.host.showError(`Shell command failed: ${message}`);
      },
    );
  }

  finishShellOutput(
    commandId: string,
    stdout: string,
    stderr: string,
    isError?: boolean,
    backgrounded?: boolean,
  ): void {
    const stream = this.host.shellOutputStreams.get(commandId);
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
    this.host.shellOutputStreams.delete(commandId);
    // When the last shell command finishes, leave the shell streaming phase,
    // release one queued message (if any), and refresh the activity pane.
    if (this.host.shellOutputStreams.size === 0) {
      this.host.setAppState({ streamingPhase: "idle" });
      this.host.messageQueueController.drainOneQueuedMessage();
    }
  }

  handleShellOutput(event: {
    commandId: string;
    update: { kind: string; text?: string };
  }): void {
    const stream = this.host.shellOutputStreams.get(event.commandId);
    if (stream === undefined) return;
    const text = event.update.text ?? "";
    if (text.length === 0) return;
    stream.component.append(text);
  }

  handleShellStarted(event: { commandId: string; taskId: string }): void {
    const stream = this.host.shellOutputStreams.get(event.commandId);
    if (stream === undefined) return;
    this.host.shellOutputStreams.set(event.commandId, {
      ...stream,
      taskId: event.taskId,
    });
  }

  cancelRunningShellCommand(): void {
    const session = this.host.session;
    if (session === undefined) return;
    for (const commandId of this.host.shellOutputStreams.keys()) {
      void session.cancelShellCommand(commandId).catch((error: unknown) => {
        this.host.showError(
          `Failed to cancel shell command: ${formatErrorMessage(error)}`,
        );
      });
    }
  }

  async sendNormalUserInput(text: string): Promise<void> {
    if (this.host.btwPanelController.sendUserInput(text)) return;
    if (this.host.state.appState.model.trim().length === 0) {
      this.host.showError(LLM_NOT_SET_MESSAGE);
      return;
    }
    let extraction: ReturnType<typeof extractMediaAttachments>;
    try {
      // Pasted videos are copied into the cache and expand to a `file://`
      // `video_url` part; the engine resolves (uploads or degrades) them
      // inside the turn, so submission stays fully synchronous.
      extraction = extractMediaAttachments(text, this.host.imageStore);
    } catch (error) {
      // A video cache copy failed (unwritable cache dir, vanished source…);
      // nothing was dispatched.
      this.host.showError(
        `Failed to prepare media attachment: ${formatErrorMessage(error)}`,
      );
      return;
    }
    if (!this.validateMediaCapabilities(extraction)) return;
    let session = this.host.session;
    if (session === undefined) {
      if (!this.host.engineV2) {
        this.host.showError(LLM_NOT_SET_MESSAGE);
        return;
      }
      session = await this.host.ensureSession();
      if (session === undefined) return;
    }
    if (extraction.hasMedia) {
      this.host.messageQueueController.sendMessage(session, text, {
        hasMedia: true,
        parts: extraction.parts,
        imageAttachmentIds: extraction.imageAttachmentIds,
      });
    } else {
      this.host.messageQueueController.sendMessage(session, text);
    }
    this.host.updateQueueDisplay();
    this.host.state.ui.requestRender();
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
      this.host.showError("Current model does not support image input.");
      return false;
    }
    if (
      extraction.videoAttachmentIds.length > 0 &&
      !this.supportsCurrentModelCapability("video_in")
    ) {
      this.host.showError("Current model does not support video input.");
      return false;
    }
    return true;
  }

  supportsCurrentModelCapability(capability: string): boolean {
    const capabilities =
      this.host.state.appState.availableModels[this.host.state.appState.model]
        ?.capabilities;
    if (capabilities === undefined) return true;
    return capabilities.includes(capability);
  }

  async loadPersistedInputHistory(): Promise<void> {
    try {
      const file = getInputHistoryFile(this.host.state.appState.workDir);
      const entries = await loadInputHistory(file);
      for (const entry of entries) {
        this.promptEditorState = reducePromptEditor(this.promptEditorState, {
          type: "history-add",
          text: entry.content,
        });
      }
      this.lastHistoryContent = entries.at(-1)?.content;
    } catch {
      // best-effort
    }
  }

  async persistInputHistory(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    if (trimmed === this.lastHistoryContent) return;
    this.promptEditorState = reducePromptEditor(this.promptEditorState, {
      type: "history-add",
      text: trimmed,
    });
    try {
      const file = getInputHistoryFile(this.host.state.appState.workDir);
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
}

import type { KimiHarness, Session } from "@moonshot-ai/kimi-code-sdk";
import {
  compressImageForModel,
  persistOriginalImage,
  sessionMediaOriginalsDir,
} from "@moonshot-ai/kimi-code-sdk";

import {
  ClipboardMediaError,
  readClipboardMedia,
} from "#/utils/clipboard/clipboard-image";
import { parseImageMeta } from "#/utils/image/image-mime";
import {
  editInExternalEditor,
  resolveEditorCommand,
} from "#/utils/process/external-editor";

import {
  CTRL_C_HINT,
  CTRL_D_HINT,
  DOUBLE_ESC_WINDOW_MS,
  EXIT_CONFIRM_WINDOW_MS,
  LLM_NOT_SET_MESSAGE,
  NO_ACTIVE_SESSION_MESSAGE,
} from "../constant/kimi-tui";
import { formatErrorMessage } from "../utils/event-payload";
import type { ImageAttachmentStore } from "../utils/image-attachment-store";
import { extractMediaAttachments } from "../utils/image-placeholder";
import type { PendingExit, QueuedMessage, SteerInputItem } from "../types";
import type { TUIState } from "../tui-state";
import type { BtwPanelController } from "./btw-panel";
import type { PromptSemanticAction } from "../renderer/prompt-editor-input";

export interface EditorKeyboardHost {
  state: TUIState;
  session: Session | undefined;
  readonly engineV2: boolean;
  cancelInFlight: (() => void) | undefined;
  /**
   * The host's harness (KimiTUI always has one). Its `imageLimits` drives
   * paste-time image compression; hosts without one fall back to the
   * env/built-in default.
   */
  harness?: KimiHarness | undefined;

  handleUserInput(text: string): void;
  readonly btwPanelController: BtwPanelController;
  steerMessage(session: Session, input: readonly SteerInputItem[]): void;
  validateMediaCapabilities(extraction: {
    hasMedia: boolean;
    imageAttachmentIds: readonly number[];
    videoAttachmentIds: readonly number[];
  }): boolean;
  recallLastQueued(): QueuedMessage | undefined;
  showError(msg: string): void;
  track(event: string, props?: Record<string, unknown>): void;
  updateEditorBorderHighlight(text?: string): void;
  updateQueueDisplay(): void;
  toggleToolOutputExpansion(): void;
  toggleTodoPanelExpansion(): void;
  detachCurrentForegroundTask(): void;
  cancelRunningShellCommand(): void;
  hideSessionPicker(): void;
  openUndoSelector(): void;
  stop(exitCode?: number): Promise<void>;
  ensureSession(): Promise<Session | undefined>;
  handlePlanToggle(next: boolean): void;
  handleInputModeChange(mode: "prompt" | "bash"): void;
  clearQueuedMessages(): void;
  setExternalEditorRunning(running: boolean): void;
  /** Optional renderer-aware terminal handoff for external editors. */
  suspendTerminal?: () => void;
  resumeTerminal?: () => void;
  updatePromptEditorView?: () => void;
  /** When true, prompt shortcuts read/write the renderer-neutral model. */
  inkOwnsPromptEditor?: () => boolean;
  getPromptEditorText?: () => string;
  setPromptEditorText?: (text: string) => void;
  getPromptInputMode?: () => "prompt" | "bash";
  setPromptInputMode?: (mode: "prompt" | "bash") => void;
  insertPromptEditorText?: (text: string) => void;
  requestPromptEditorRender?: () => void;
}

export class EditorKeyboardController {
  private pendingExit: PendingExit | null = null;
  private pendingUndoEsc: {
    readonly timer: ReturnType<typeof setTimeout>;
  } | null = null;

  constructor(
    private readonly host: EditorKeyboardHost,
    private readonly imageStore: ImageAttachmentStore,
  ) {}

  install(): void {
    const { host } = this;
    const editor = host.state.editor;

    editor.onSubmit = (text: string) => {
      host.handleUserInput(text);
    };

    editor.onChange = (text: string) => {
      if (this.pendingExit) this.clearPendingExit();
      host.updateEditorBorderHighlight(text);
    };

    // bash mode recalls only shell (`!`-prefixed) history entries; prompt mode
    // recalls everything. The filter is locked to the mode captured when the
    // user first enters history browsing (see onHistoryDraftSave), so landing on
    // a shell entry mid-browse doesn't switch the filter to shell-only.
    let browseMode: "prompt" | "bash" | null = null;
    editor.setHistoryFilter((entry: string) => {
      const mode = browseMode ?? editor.inputMode;
      return mode === "bash" ? entry.startsWith("!") : true;
    });

    // Recalling a `!`-prefixed entry strips the marker and returns to bash
    // mode; recalling a plain entry returns to prompt mode. The filter above
    // guarantees bash mode only ever lands on `!` entries, so this never
    // misfires on commands typed in bash mode.
    editor.onRecall = (entry: string) => {
      if (entry.startsWith("!")) {
        editor.setInputMode("bash");
        return entry.slice(1);
      }
      editor.setInputMode("prompt");
      return undefined;
    };

    // Save/restore the input mode alongside kimi-tui's history draft. Without
    // this, recalling a shell entry and then pressing Down back to an empty
    // draft would leave the editor stuck in bash mode, so the next typed
    // message would be submitted as a shell command. Also locks the history
    // filter (browseMode) for the duration of the browse session.
    editor.onHistoryDraftSave = () => {
      browseMode = editor.inputMode;
      return editor.inputMode;
    };
    editor.onHistoryDraftRestore = (state: unknown) => {
      editor.setInputMode(state as "prompt" | "bash");
      browseMode = null;
    };

    editor.onNonEscapeInput = () => {
      this.clearPendingUndoEsc();
    };

    editor.onInputModeChange = (mode) => {
      host.handleInputModeChange(mode);
    };

    editor.onCtrlC = () => {
      this.handleCtrlC();
    };

    editor.onCtrlD = () => {
      this.handleCtrlD();
    };

    editor.onEscape = () => {
      this.handleEscape();
    };

    editor.onShiftTab = () => {
      this.handleShiftTab();
    };

    editor.onOpenExternalEditor = () => {
      this.handleOpenExternalEditor();
    };

    editor.onToggleToolExpand = () => {
      this.handleToggleToolExpand();
    };

    editor.onToggleTodoExpand = (): boolean => this.handleToggleTodoExpand();

    editor.onCtrlS = () => {
      this.handleCtrlS();
    };

    editor.onCtrlB = (): boolean => this.handleCtrlB();

    editor.onUndo = () => {
      this.handleUndo();
    };

    editor.onTextPaste = () => {
      this.handleTextPaste();
    };

    editor.onUpArrowEmpty = () => this.handleUpArrowEmpty();

    editor.onDownArrowEmpty = () => this.handleDownArrowEmpty();

    editor.onPasteImage = async () => this.handleClipboardImagePaste();
  }

  clearPendingExit(): void {
    if (!this.pendingExit) return;
    clearTimeout(this.pendingExit.timer);
    this.host.state.footer.setTransientHint(null);
    this.pendingExit = null;
  }

  /**
   * Dispatch a semantic shortcut from a renderer-owned prompt editor.
   * Returns whether the shortcut consumed the input (Ctrl-B/Ctrl-T can fall
   * through to ordinary editing when their feature is inactive).
   */
  dispatchPromptSemantic(action: PromptSemanticAction): boolean {
    switch (action) {
      case "ctrl-c":
        this.handleCtrlC();
        return true;
      case "ctrl-d":
        this.handleCtrlD();
        return true;
      case "ctrl-g":
        this.handleOpenExternalEditor();
        return true;
      case "ctrl-o":
        this.handleToggleToolExpand();
        return true;
      case "ctrl-s":
        this.handleCtrlS();
        return true;
      case "ctrl-b":
        return this.handleCtrlB();
      case "ctrl-t":
        return this.handleToggleTodoExpand();
      case "paste-image":
        void this.handleClipboardImagePaste()
          .then((handled) => {
            if (!handled) this.handleTextPaste();
          })
          .finally(() => this.host.updatePromptEditorView?.());
        return true;
      case "undo":
        this.handleUndo();
        return true;
      case "shift-tab":
        this.handleShiftTab();
        return true;
      case "escape":
        this.handleEscape();
        return true;
      case "up-empty":
        return this.handleUpArrowEmpty();
      case "down-empty":
        return this.handleDownArrowEmpty();
    }
  }

  private handleCtrlC(): void {
    const { host } = this;
    if (host.cancelInFlight !== undefined) {
      const cancel = host.cancelInFlight;
      host.cancelInFlight = undefined;
      this.clearPendingExit();
      cancel();
      return;
    }

    if (host.btwPanelController.cancelRunning()) {
      this.clearPendingExit();
      return;
    }
    if (host.btwPanelController.closeOrCancel()) {
      this.clearPendingExit();
      return;
    }

    if (host.state.appState.isCompacting) {
      this.clearPendingExit();
      if (this.clearEditorTextIfPresent()) return;
      this.cancelCurrentCompaction();
      return;
    }

    if (host.state.appState.streamingPhase !== "idle") {
      this.clearPendingExit();
      if (this.clearEditorTextIfPresent()) return;
      this.cancelCurrentStream();
      return;
    }

    if (this.pendingExit?.kind === "ctrl-c") {
      this.clearPendingExit();
      void host.stop();
      return;
    }

    if (this.readPromptText().length > 0) {
      this.writePromptText("");
    }
    this.armPendingExit("ctrl-c", CTRL_C_HINT);
  }

  private handleCtrlD(): void {
    if (this.pendingExit?.kind === "ctrl-d") {
      this.clearPendingExit();
      void this.host.stop();
      return;
    }
    this.armPendingExit("ctrl-d", CTRL_D_HINT);
  }

  private handleEscape(): void {
    const { host } = this;
    if (this.pendingExit) this.clearPendingExit();
    if (host.state.activeDialog === "session-picker") {
      host.hideSessionPicker();
      this.clearPendingUndoEsc();
      return;
    }
    if (host.btwPanelController.closeOrCancel()) {
      this.clearPendingUndoEsc();
      return;
    }
    if (host.state.appState.isCompacting) {
      this.cancelCurrentCompaction();
      this.clearPendingUndoEsc();
      return;
    }
    if (host.state.appState.streamingPhase !== "idle") {
      this.cancelCurrentStream();
      this.clearPendingUndoEsc();
      return;
    }
    if (this.pendingUndoEsc !== null) {
      this.clearPendingUndoEsc();
      host.openUndoSelector();
      return;
    }
    this.armPendingUndoEsc();
  }

  private handleShiftTab(): void {
    const { host } = this;
    const togglePlan = (): void => {
      const next = !host.state.appState.planMode;
      host.track("shortcut_plan_toggle", { enabled: next });
      host.track("shortcut_mode_switch", {
        to_mode: next ? "plan" : "agent",
      });
      host.handlePlanToggle(next);
    };
    if (host.session === undefined) {
      if (!host.engineV2) {
        host.showError(NO_ACTIVE_SESSION_MESSAGE);
        return;
      }
      void host.ensureSession().then((session) => {
        if (session !== undefined) togglePlan();
      });
      return;
    }
    togglePlan();
  }

  private handleOpenExternalEditor(): void {
    this.host.track("shortcut_editor");
    void this.openExternalEditor();
  }

  private handleToggleToolExpand(): void {
    this.host.track("shortcut_expand");
    this.host.toggleToolOutputExpansion();
  }

  private handleToggleTodoExpand(): boolean {
    if (!this.host.state.todoPanel.hasOverflow()) return false;
    this.clearPendingExit();
    this.host.track("shortcut_todo_expand");
    this.host.toggleTodoPanelExpansion();
    return true;
  }

  private handleCtrlS(): void {
    const { host } = this;
    if (
      host.state.appState.streamingPhase === "idle" ||
      host.state.appState.streamingPhase === "shell" ||
      host.state.appState.isCompacting
    ) {
      return;
    }
    const text = this.readPromptText().trim();
    const editorIsBash = this.readPromptInputMode() === "bash";

    const queued = host.state.queuedMessages;
    const steerable = queued.filter((m) => m.mode !== "bash");

    const items: SteerInputItem[] = [];
    for (const m of steerable) {
      const trimmed = m.text.trim();
      if (trimmed.length > 0) {
        items.push({
          text: trimmed,
          parts: m.parts,
          imageAttachmentIds: m.imageAttachmentIds,
        });
      }
    }
    let editorExtraction:
      | ReturnType<typeof extractMediaAttachments>
      | undefined;
    if (!editorIsBash && text.length > 0) {
      try {
        editorExtraction = extractMediaAttachments(text, this.imageStore);
      } catch (error) {
        host.showError(
          `Failed to prepare media attachment: ${formatErrorMessage(error)}`,
        );
        return;
      }
      items.push({
        text,
        parts: editorExtraction.hasMedia ? editorExtraction.parts : undefined,
        imageAttachmentIds:
          editorExtraction.imageAttachmentIds.length > 0
            ? editorExtraction.imageAttachmentIds
            : undefined,
      });
    }

    if (items.length > 0) {
      if (
        editorExtraction !== undefined &&
        !host.validateMediaCapabilities(editorExtraction)
      ) {
        return;
      }
      host.state.queuedMessages = queued.filter((m) => m.mode === "bash");
      if (!editorIsBash) this.writePromptText("");
      const session = host.session;
      if (
        host.state.appState.model.trim().length === 0 ||
        session === undefined
      ) {
        host.showError(LLM_NOT_SET_MESSAGE);
      } else {
        host.steerMessage(session, items);
      }
    }
    host.updateQueueDisplay();
    this.requestPromptRender();
  }

  private handleCtrlB(): boolean {
    if (
      this.host.state.appState.streamingPhase === "idle" ||
      this.host.state.appState.isCompacting
    ) {
      return false;
    }
    this.host.track("shortcut_background_task");
    this.host.detachCurrentForegroundTask();
    return true;
  }

  private handleUndo(): void {
    this.host.track("undo");
  }

  private handleTextPaste(): void {
    this.host.track("shortcut_paste", { kind: "text" });
  }

  private handleUpArrowEmpty(): boolean {
    const { host } = this;
    if (host.btwPanelController.scroll("up")) return true;
    if (
      host.state.appState.streamingPhase === "idle" &&
      !host.state.appState.isCompacting
    ) {
      return false;
    }
    const recalled = host.recallLastQueued();
    if (recalled !== undefined) {
      this.writePromptText(recalled.text);
      const mode = recalled.mode ?? "prompt";
      if (this.readPromptInputMode() !== mode) {
        this.writePromptInputMode(mode);
      }
      host.updateQueueDisplay();
      this.requestPromptRender();
      return true;
    }
    return false;
  }

  private handleDownArrowEmpty(): boolean {
    return this.host.btwPanelController.scroll("down");
  }

  private usesInkPromptModel(): boolean {
    return this.host.inkOwnsPromptEditor?.() === true;
  }

  private readPromptText(): string {
    if (this.usesInkPromptModel()) {
      return this.host.getPromptEditorText?.() ?? "";
    }
    return this.host.state.editor.getText();
  }

  private writePromptText(text: string): void {
    if (this.usesInkPromptModel()) {
      this.host.setPromptEditorText?.(text);
      return;
    }
    this.host.state.editor.setText(text);
  }

  private readPromptInputMode(): "prompt" | "bash" {
    if (this.usesInkPromptModel()) {
      return this.host.getPromptInputMode?.() ?? "prompt";
    }
    return this.host.state.editor.inputMode;
  }

  private writePromptInputMode(mode: "prompt" | "bash"): void {
    if (this.usesInkPromptModel()) {
      this.host.setPromptInputMode?.(mode);
      return;
    }
    const editor = this.host.state.editor;
    editor.inputMode = mode;
    editor.onInputModeChange?.(mode);
  }

  private insertPromptText(text: string): void {
    if (this.usesInkPromptModel()) {
      this.host.insertPromptEditorText?.(text);
      return;
    }
    this.host.state.editor.insertTextAtCursor?.(text);
  }

  private requestPromptRender(force = false): void {
    if (this.usesInkPromptModel()) {
      this.host.requestPromptEditorRender?.();
      return;
    }
    this.host.state.ui.requestRender(force);
  }

  dispose(): void {
    this.clearPendingExit();
    this.clearPendingUndoEsc();
  }

  private armPendingUndoEsc(): void {
    this.clearPendingUndoEsc();
    const timer = setTimeout(() => {
      if (this.pendingUndoEsc?.timer === timer) {
        this.pendingUndoEsc = null;
      }
    }, DOUBLE_ESC_WINDOW_MS);
    this.pendingUndoEsc = { timer };
  }

  private clearPendingUndoEsc(): void {
    if (!this.pendingUndoEsc) return;
    clearTimeout(this.pendingUndoEsc.timer);
    this.pendingUndoEsc = null;
  }

  private armPendingExit(kind: "ctrl-c" | "ctrl-d", hint: string): void {
    this.clearPendingExit();
    this.host.state.footer.setTransientHint(hint);

    const timer = setTimeout(() => {
      if (this.pendingExit?.timer === timer) {
        this.clearPendingExit();
        this.requestPromptRender();
      }
    }, EXIT_CONFIRM_WINDOW_MS);

    this.pendingExit = { kind, timer };
    this.requestPromptRender();
  }

  private clearEditorTextIfPresent(): boolean {
    if (this.readPromptText().length === 0) return false;
    this.writePromptText("");
    return true;
  }

  private cancelCurrentStream(): void {
    // Cancel any running `!` shell command (treated as a streaming phase) in
    // addition to the agent turn, so Esc / Ctrl+C interrupts it too.
    this.host.cancelRunningShellCommand();
    void this.host.session?.cancel();
  }

  private cancelCurrentCompaction(): void {
    const session = this.host.session;
    if (session === undefined) return;
    void session.cancelCompaction().catch((error: unknown) => {
      const message = formatErrorMessage(error);
      this.host.showError(`Failed to cancel compaction: ${message}`);
    });
  }

  private async handleClipboardImagePaste(): Promise<boolean> {
    let media;
    try {
      media = await readClipboardMedia();
    } catch (error) {
      if (error instanceof ClipboardMediaError) {
        this.host.showError(error.message);
        return true;
      }
      return false;
    }
    if (media === null) return false;

    if (media.kind === "video") {
      const attachment = this.imageStore.addVideo(
        media.mimeType,
        media.sourcePath,
        media.filename,
      );
      this.insertPromptText(`${attachment.placeholder} `);
      this.requestPromptRender();
      this.host.track("shortcut_paste", { kind: "video" });
      return true;
    }

    const meta = parseImageMeta(media.bytes);
    if (meta === null) return false;
    // Compress at ingestion — a pure data step while building the attachment, so
    // the stored bytes, the inline thumbnail, the `[image #N (W×H)]` placeholder,
    // and the submitted image all agree, and the agent core only ever sees an
    // already-compressed image. Best effort: originals pass through on failure.
    // When compression changed the bytes, the original is persisted (into the
    // session's media-originals dir when known, else the temp-dir fallback)
    // and recorded on the attachment, so submit-time expansion can announce
    // the compression and point the model at the full-fidelity copy.
    // The edge cap comes from the host harness's [image] config (resolved per
    // paste so a config reload applies immediately); hosts without a harness
    // use the env/built-in default.
    const maxEdge = this.host.harness?.imageLimits?.maxEdgePx();
    const compressed = await compressImageForModel(
      media.bytes,
      meta.mime,
      maxEdge === undefined ? {} : { maxEdge },
    );
    const sessionDir = this.host.session?.summary?.sessionDir;
    // Dimensions come from the compression result, not parseImageMeta: the
    // compressor reports display space (EXIF orientation applied) — the space
    // the sent image, the caption, and ReadMediaFile region readback share —
    // while parseImageMeta reads the raw pre-rotation header.
    const attachment = compressed.changed
      ? this.imageStore.addImage(
          compressed.data,
          compressed.mimeType,
          compressed.width,
          compressed.height,
          {
            path: await persistOriginalImage(
              media.bytes,
              meta.mime,
              sessionDir === undefined
                ? {}
                : { dir: sessionMediaOriginalsDir(sessionDir) },
            ),
            width: compressed.originalWidth,
            height: compressed.originalHeight,
            byteLength: media.bytes.length,
            mime: meta.mime,
          },
        )
      : this.imageStore.addImage(
          media.bytes,
          meta.mime,
          compressed.width || meta.width,
          compressed.height || meta.height,
        );
    this.insertPromptText(`${attachment.placeholder} `);
    this.requestPromptRender();
    this.host.track("shortcut_paste", { kind: "image" });
    return true;
  }

  private async openExternalEditor(): Promise<void> {
    const { state } = this.host;
    if (state.externalEditorRunning) return;
    const cmd = resolveEditorCommand(state.appState.editorCommand);
    if (cmd === undefined) {
      this.host.showError(
        "No editor configured. Set $VISUAL / $EDITOR, or run /editor <command>.",
      );
      return;
    }
    this.host.setExternalEditorRunning(true);
    const seed =
      this.host.state.editor.getExpandedText?.() ?? this.readPromptText();
    if (this.host.suspendTerminal !== undefined) this.host.suspendTerminal();
    else state.ui.stop();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    try {
      const result = await editInExternalEditor(seed, cmd);
      if (result !== undefined) {
        this.writePromptText(result.replaceAll("\r\n", "\n").replace(/\n$/, ""));
      }
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.host.showError(`External editor failed: ${msg}`);
    } finally {
      if (typeof process.stdin.pause === "function") {
        process.stdin.pause();
      }
      if (this.host.resumeTerminal !== undefined) this.host.resumeTerminal();
      else state.ui.start();
      if (!this.usesInkPromptModel()) {
        state.ui.setFocus(state.editor);
      }
      this.requestPromptRender(true);
      this.host.setExternalEditorRunning(false);
    }
  }
}

import { getKeybindings } from "../../keybindings.ts";
import { decodePrintableKey, matchesKey } from "../../keys.ts";
import type { Editor } from "./component.ts";

export function handleInput(this: Editor, data: string): void {
  const kb = getKeybindings();

  // Handle character jump mode (awaiting next character to jump to)
  if (this.jumpMode !== null) {
    // Cancel if the hotkey is pressed again
    if (
      kb.matches(data, "tui.editor.jumpForward") ||
      kb.matches(data, "tui.editor.jumpBackward")
    ) {
      this.jumpMode = null;
      return;
    }

    const printable =
      decodePrintableKey(data) ?? (data.charCodeAt(0) >= 32 ? data : undefined);
    if (printable !== undefined) {
      // Printable character - perform the jump
      const direction = this.jumpMode;
      this.jumpMode = null;
      this.jumpToChar(printable, direction);
      return;
    }

    // Control character - cancel and fall through to normal handling
    this.jumpMode = null;
  }

  // Handle bracketed paste mode
  if (data.includes("\x1b[200~")) {
    this.isInPaste = true;
    this.pasteBuffer = "";
    this.pasteBurst.reset();
    data = data.replace("\x1b[200~", "");
  }

  if (this.isInPaste) {
    this.pasteBuffer += data;
    const endIndex = this.pasteBuffer.indexOf("\x1b[201~");
    if (endIndex !== -1) {
      const pasteContent = this.pasteBuffer.substring(0, endIndex);
      if (pasteContent.length > 0) {
        this.handlePaste(pasteContent);
      }
      this.isInPaste = false;
      const remaining = this.pasteBuffer.substring(endIndex + 6);
      this.pasteBuffer = "";
      this.pasteBurst.reset();
      if (remaining.length > 0) {
        this.handleInput(remaining);
      }
      return;
    }
    return;
  }

  const isEnterKey = data !== "\n" && kb.matches(data, "tui.input.submit");
  const charCode = data.charCodeAt(0);
  const printableForBurst =
    decodePrintableKey(data) ??
    (data.length === 1 && charCode >= 32 && charCode !== 0x7f
      ? data
      : undefined);
  if (
    !(this.disablePasteBurst || isEnterKey) &&
    printableForBurst === undefined
  ) {
    this.pasteBurst.reset();
  }

  // Ctrl+C - let parent handle (exit/clear)
  if (kb.matches(data, "tui.input.copy")) {
    return;
  }

  // Undo
  if (kb.matches(data, "tui.editor.undo")) {
    this.undo();
    return;
  }

  // Handle autocomplete mode
  if (this.autocompleteState && this.autocompleteList) {
    if (kb.matches(data, "tui.select.cancel")) {
      this.cancelAutocomplete();
      return;
    }

    if (
      kb.matches(data, "tui.select.up") ||
      kb.matches(data, "tui.select.down")
    ) {
      this.autocompleteList.handleInput(data);
      return;
    }

    if (kb.matches(data, "tui.input.tab")) {
      const selected = this.autocompleteList.getSelectedItem();
      if (selected && this.autocompleteProvider) {
        this.pushUndoSnapshot();
        this.lastAction = null;
        const result = this.autocompleteProvider.applyCompletion(
          this.state.lines,
          this.state.cursorLine,
          this.state.cursorCol,
          selected,
          this.autocompletePrefix,
        );
        this.state.lines = result.lines;
        this.state.cursorLine = result.cursorLine;
        this.setCursorCol(result.cursorCol);
        this.cancelAutocomplete();
        if (this.onChange) this.onChange(this.getText());
      }
      return;
    }

    if (kb.matches(data, "tui.select.confirm")) {
      const selected = this.autocompleteList.getSelectedItem();
      if (selected && this.autocompleteProvider) {
        this.pushUndoSnapshot();
        this.lastAction = null;
        const result = this.autocompleteProvider.applyCompletion(
          this.state.lines,
          this.state.cursorLine,
          this.state.cursorCol,
          selected,
          this.autocompletePrefix,
        );
        this.state.lines = result.lines;
        this.state.cursorLine = result.cursorLine;
        this.setCursorCol(result.cursorCol);

        if (this.autocompletePrefix.startsWith("/")) {
          this.cancelAutocomplete();
          // Fall through to submit
        } else {
          this.cancelAutocomplete();
          if (this.onChange) this.onChange(this.getText());
          return;
        }
      }
    }
  }

  // Tab - trigger completion
  if (kb.matches(data, "tui.input.tab") && !this.autocompleteState) {
    this.handleTabCompletion();
    return;
  }

  // Deletion actions
  if (kb.matches(data, "tui.editor.deleteToLineEnd")) {
    this.deleteToEndOfLine();
    return;
  }
  if (kb.matches(data, "tui.editor.deleteToLineStart")) {
    this.deleteToStartOfLine();
    return;
  }
  if (kb.matches(data, "tui.editor.deleteWordBackward")) {
    this.deleteWordBackwards();
    return;
  }
  if (kb.matches(data, "tui.editor.deleteWordForward")) {
    this.deleteWordForward();
    return;
  }
  if (
    kb.matches(data, "tui.editor.deleteCharBackward") ||
    matchesKey(data, "shift+backspace")
  ) {
    this.handleBackspace();
    return;
  }
  if (
    kb.matches(data, "tui.editor.deleteCharForward") ||
    matchesKey(data, "shift+delete")
  ) {
    this.handleForwardDelete();
    return;
  }

  // Kill ring actions
  if (kb.matches(data, "tui.editor.yank")) {
    this.yank();
    return;
  }
  if (kb.matches(data, "tui.editor.yankPop")) {
    this.yankPop();
    return;
  }

  // Cursor movement actions
  if (kb.matches(data, "tui.editor.cursorLineStart")) {
    this.moveToLineStart();
    return;
  }
  if (kb.matches(data, "tui.editor.cursorLineEnd")) {
    this.moveToLineEnd();
    return;
  }
  if (kb.matches(data, "tui.editor.cursorWordLeft")) {
    this.moveWordBackwards();
    return;
  }
  if (kb.matches(data, "tui.editor.cursorWordRight")) {
    this.moveWordForwards();
    return;
  }

  // New line
  if (
    kb.matches(data, "tui.input.newLine") ||
    (data.charCodeAt(0) === 10 && data.length > 1) ||
    data === "\x1b\r" ||
    data === "\x1b[13;2~" ||
    (data.length > 1 && data.includes("\x1b") && data.includes("\r")) ||
    (data === "\n" && data.length === 1)
  ) {
    if (this.shouldSubmitOnBackslashEnter(data, kb)) {
      this.handleBackspace();
      this.submitValue();
      return;
    }
    this.addNewLine();
    return;
  }

  // Submit (Enter)
  if (kb.matches(data, "tui.input.submit")) {
    if (this.disableSubmit) return;

    // Workaround for terminals without Shift+Enter support:
    // If char before cursor is \, delete it and insert newline instead of submitting.
    const currentLine = this.state.lines[this.state.cursorLine] || "";
    if (
      this.state.cursorCol > 0 &&
      currentLine[this.state.cursorCol - 1] === "\\"
    ) {
      this.handleBackspace();
      this.addNewLine();
      return;
    }

    if (
      !this.disablePasteBurst &&
      this.pasteBurst.shouldInsertNewlineInsteadOfSubmit(Date.now())
    ) {
      this.addNewLine();
      this.pasteBurst.extendWindow(Date.now());
      return;
    }

    this.submitValue();
    return;
  }

  // Arrow key navigation (with history support)
  if (kb.matches(data, "tui.editor.cursorUp")) {
    if (
      this.isOnFirstVisualLine() &&
      (this.isEditorEmpty() ||
        this.historyIndex > -1 ||
        this.state.cursorCol === 0)
    ) {
      this.navigateHistory(-1);
    } else if (this.isOnFirstVisualLine()) {
      // Already at top - jump to start of line
      this.moveToLineStart();
    } else {
      this.moveCursor(-1, 0);
    }
    return;
  }
  if (kb.matches(data, "tui.editor.cursorDown")) {
    if (this.historyIndex > -1 && this.isOnLastVisualLine()) {
      this.navigateHistory(1);
    } else if (this.isOnLastVisualLine()) {
      // Already at bottom - jump to end of line
      this.moveToLineEnd();
    } else {
      this.moveCursor(1, 0);
    }
    return;
  }
  if (kb.matches(data, "tui.editor.cursorRight")) {
    this.moveCursor(0, 1);
    return;
  }
  if (kb.matches(data, "tui.editor.cursorLeft")) {
    this.moveCursor(0, -1);
    return;
  }

  // Page up/down - scroll by page and move cursor
  if (kb.matches(data, "tui.editor.pageUp")) {
    this.pageScroll(-1);
    return;
  }
  if (kb.matches(data, "tui.editor.pageDown")) {
    this.pageScroll(1);
    return;
  }

  // Character jump mode triggers
  if (kb.matches(data, "tui.editor.jumpForward")) {
    this.jumpMode = "forward";
    return;
  }
  if (kb.matches(data, "tui.editor.jumpBackward")) {
    this.jumpMode = "backward";
    return;
  }

  // Shift+Space - insert regular space
  if (matchesKey(data, "shift+space")) {
    this.insertCharacter(" ");
    return;
  }

  const printable = decodePrintableKey(data);
  if (printable !== undefined) {
    if (!this.disablePasteBurst) {
      this.pasteBurst.onPlainChar(Date.now());
    }
    this.insertCharacter(printable);
    return;
  }

  // Regular characters
  if (data.charCodeAt(0) >= 32) {
    if (!this.disablePasteBurst) {
      this.pasteBurst.onPlainChar(Date.now());
    }
    this.insertCharacter(data);
  }
}

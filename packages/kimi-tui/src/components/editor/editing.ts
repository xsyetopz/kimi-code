import type { getKeybindings } from "../../keybindings.ts";
import { matchesKey } from "../../keys.ts";
import { isWhitespaceChar } from "../../utils.ts";
import type { Editor } from "./component.ts";

export function isEditorEmpty(this: Editor): boolean {
  return this.state.lines.length === 1 && this.state.lines[0] === "";
}

export function isOnFirstVisualLine(this: Editor): boolean {
  const visualLines = this.buildVisualLineMap(this.lastWidth);
  const currentVisualLine = this.findCurrentVisualLine(visualLines);
  return currentVisualLine === 0;
}

export function isOnLastVisualLine(this: Editor): boolean {
  const visualLines = this.buildVisualLineMap(this.lastWidth);
  const currentVisualLine = this.findCurrentVisualLine(visualLines);
  return currentVisualLine === visualLines.length - 1;
}

export function normalizeText(this: Editor, text: string): string {
  return text
    .replace(/\r\n/gu, "\n")
    .replace(/\r/gu, "\n")
    .replace(/\t/gu, "    ");
}

export function insertTextAtCursorInternal(this: Editor, text: string): void {
  if (!text) return;

  // Normalize line endings and tabs
  const normalized = this.normalizeText(text);
  const insertedLines = normalized.split("\n");

  const currentLine = this.state.lines[this.state.cursorLine] || "";
  const beforeCursor = currentLine.slice(0, this.state.cursorCol);
  const afterCursor = currentLine.slice(this.state.cursorCol);

  if (insertedLines.length === 1) {
    // Single line - insert at cursor position
    this.state.lines[this.state.cursorLine] =
      beforeCursor + normalized + afterCursor;
    this.setCursorCol(this.state.cursorCol + normalized.length);
  } else {
    // Multi-line insertion
    this.state.lines = [
      // All lines before current line
      ...this.state.lines.slice(0, this.state.cursorLine),

      // The first inserted line merged with text before cursor
      beforeCursor + insertedLines[0],

      // All middle inserted lines
      ...insertedLines.slice(1, -1),

      // The last inserted line with text after cursor
      insertedLines.at(-1) + afterCursor,

      // All lines after current line
      ...this.state.lines.slice(this.state.cursorLine + 1),
    ];

    this.state.cursorLine += insertedLines.length - 1;
    this.setCursorCol((insertedLines.at(-1) || "").length);
  }

  if (this.onChange) {
    this.onChange(this.getText());
  }
}

export function insertCharacter(
  this: Editor,
  char: string,
  skipUndoCoalescing?: boolean,
): void {
  this.exitHistoryBrowsing();

  // Undo coalescing (fish-style):
  // - Consecutive word chars coalesce into one undo unit
  // - Space captures state before itself (so undo removes space+following word together)
  // - Each space is separately undoable
  // Skip coalescing when called from atomic operations (e.g., handlePaste)
  if (!skipUndoCoalescing) {
    if (isWhitespaceChar(char) || this.lastAction !== "type-word") {
      this.pushUndoSnapshot();
    }
    this.lastAction = "type-word";
  }

  const line = this.state.lines[this.state.cursorLine] || "";

  const before = line.slice(0, this.state.cursorCol);
  const after = line.slice(this.state.cursorCol);

  this.state.lines[this.state.cursorLine] = before + char + after;
  this.setCursorCol(this.state.cursorCol + char.length);

  if (this.onChange) {
    this.onChange(this.getText());
  }

  // Check if we should trigger or update autocomplete
  if (!this.autocompleteState) {
    // Auto-trigger for "/" at the start of a line (slash commands)
    if (char === "/" && this.isAtStartOfMessage()) {
      this.tryTriggerAutocomplete();
    }
    // Auto-trigger for symbol-based completion like @, #, or provider triggers at token boundaries
    else if (this.autocompleteTriggerCharacters.includes(char)) {
      const currentLine = this.state.lines[this.state.cursorLine] || "";
      const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
      const charBeforeSymbol = textBeforeCursor.at(-2);
      if (
        textBeforeCursor.length === 1 ||
        charBeforeSymbol === " " ||
        charBeforeSymbol === "\t"
      ) {
        this.tryTriggerAutocomplete();
      }
    }
    // Also auto-trigger when typing letters in a slash command or symbol completion context
    else if (/[a-zA-Z0-9.\-_]/u.test(char)) {
      const currentLine = this.state.lines[this.state.cursorLine] || "";
      const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
      // Check if we're in a slash command (with or without space for arguments)
      if (this.isInSlashCommandContext(textBeforeCursor)) {
        this.tryTriggerAutocomplete();
      }
      // Check if we're in a symbol-based completion context like @, #, or provider triggers
      else if (this.autocompleteTriggerPattern.test(textBeforeCursor)) {
        this.tryTriggerAutocomplete();
      }
    }
  } else {
    this.updateAutocomplete();
  }
}

export function handlePaste(this: Editor, pastedText: string): void {
  this.cancelAutocomplete();
  this.exitHistoryBrowsing();
  this.lastAction = null;

  this.pushUndoSnapshot();

  // Some terminals (e.g. tmux popups with extended-keys-format=csi-u) re-encode
  // control bytes inside bracketed paste as CSI-u Ctrl+<letter> sequences
  // (ESC [ <codepoint> ; 5 u). Decode those back to their literal byte so the
  // per-char filter below preserves newlines instead of stripping ESC and
  // leaking the printable tail (e.g. "[106;5u") into the editor.
  const decodedText = pastedText.replace(/\x1b\[(\d+);5u/gu, (match, code) => {
    const cp = Number(code);
    if (cp >= 97 && cp <= 122) return String.fromCharCode(cp - 96);
    if (cp >= 65 && cp <= 90) return String.fromCharCode(cp - 64);
    return match;
  });

  // Clean the pasted text: normalize line endings, expand tabs
  const cleanText = this.normalizeText(decodedText);

  // Filter out non-printable characters except newlines
  let filteredText = cleanText
    .split("")
    .filter((char) => char === "\n" || char.charCodeAt(0) >= 32)
    .join("");

  // If pasting a file path (starts with /, ~, or .) and the character before
  // the cursor is a word character, prepend a space for better readability
  if (/^[/~.]/u.test(filteredText)) {
    const currentLine = this.state.lines[this.state.cursorLine] || "";
    const charBeforeCursor =
      this.state.cursorCol > 0 ? currentLine[this.state.cursorCol - 1] : "";
    if (charBeforeCursor && /\w/u.test(charBeforeCursor)) {
      filteredText = ` ${filteredText}`;
    }
  }

  // Split into lines to check for large paste
  const pastedLines = filteredText.split("\n");

  // Check if this is a large paste (> 10 lines or > 1000 characters)
  const totalChars = filteredText.length;
  if (pastedLines.length > 10 || totalChars > 1000) {
    // Store the paste and insert a marker
    this.pasteCounter++;
    const pasteId = this.pasteCounter;
    this.pastes.set(pasteId, filteredText);

    // Insert marker like "[paste #1 +123 lines]" or "[paste #1 1234 chars]"
    const marker =
      pastedLines.length > 10
        ? `[paste #${pasteId} +${pastedLines.length} lines]`
        : `[paste #${pasteId} ${totalChars} chars]`;
    this.insertTextAtCursorInternal(marker);
    return;
  }

  if (pastedLines.length === 1) {
    // Single line - insert atomically (do not trigger autocomplete during paste)
    this.insertTextAtCursorInternal(filteredText);
    return;
  }

  // Multi-line paste - use direct state manipulation
  this.insertTextAtCursorInternal(filteredText);
}

export function addNewLine(this: Editor): void {
  this.cancelAutocomplete();
  this.exitHistoryBrowsing();
  this.lastAction = null;

  this.pushUndoSnapshot();

  const currentLine = this.state.lines[this.state.cursorLine] || "";

  const before = currentLine.slice(0, this.state.cursorCol);
  const after = currentLine.slice(this.state.cursorCol);

  // Split current line
  this.state.lines[this.state.cursorLine] = before;
  this.state.lines.splice(this.state.cursorLine + 1, 0, after);

  // Move cursor to start of new line
  this.state.cursorLine++;
  this.setCursorCol(0);

  if (this.onChange) {
    this.onChange(this.getText());
  }
}

export function shouldSubmitOnBackslashEnter(
  this: Editor,
  data: string,
  kb: ReturnType<typeof getKeybindings>,
): boolean {
  if (this.disableSubmit) return false;
  if (!matchesKey(data, "enter")) return false;
  const submitKeys = kb.getKeys("tui.input.submit");
  const hasShiftEnter =
    submitKeys.includes("shift+enter") || submitKeys.includes("shift+return");
  if (!hasShiftEnter) return false;

  const currentLine = this.state.lines[this.state.cursorLine] || "";
  return (
    this.state.cursorCol > 0 && currentLine[this.state.cursorCol - 1] === "\\"
  );
}

export function submitValue(this: Editor): void {
  this.cancelAutocomplete();
  const result = this.expandPasteMarkers(this.state.lines.join("\n")).trim();

  this.state = { lines: [""], cursorLine: 0, cursorCol: 0 };
  this.pastes.clear();
  this.pasteCounter = 0;
  this.exitHistoryBrowsing();
  this.scrollOffset = 0;
  this.undoStack.clear();
  this.lastAction = null;

  if (this.onChange) this.onChange("");
  if (this.onSubmit) this.onSubmit(result);
}

export function pushUndoSnapshot(this: Editor): void {
  this.undoStack.push(this.state);
}

export function undo(this: Editor): void {
  this.exitHistoryBrowsing();
  const snapshot = this.undoStack.pop();
  if (!snapshot) return;
  Object.assign(this.state, snapshot);
  this.lastAction = null;
  this.preferredVisualCol = null;
  if (this.onChange) {
    this.onChange(this.getText());
  }
}

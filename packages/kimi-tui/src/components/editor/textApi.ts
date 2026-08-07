import type { AutocompleteProvider } from "../../autocomplete.ts";
import type { Editor } from "./component.ts";

export function getPaddingX(this: Editor, ): number {
  return this.paddingX;
}

export function setPaddingX(this: Editor, padding: number): void {
  const newPadding = Number.isFinite(padding)
    ? Math.max(0, Math.floor(padding))
    : 0;
  if (this.paddingX !== newPadding) {
    this.paddingX = newPadding;
    this.tui.requestRender();
  }
}

export function getAutocompleteMaxVisible(this: Editor, ): number {
  return this.autocompleteMaxVisible;
}

export function setAutocompleteMaxVisible(this: Editor, maxVisible: number): void {
  const newMaxVisible = Number.isFinite(maxVisible)
    ? Math.max(3, Math.min(20, Math.floor(maxVisible)))
    : 5;
  if (this.autocompleteMaxVisible !== newMaxVisible) {
    this.autocompleteMaxVisible = newMaxVisible;
    this.tui.requestRender();
  }
}

export function setDisablePasteBurst(this: Editor, disabled: boolean): void {
  this.disablePasteBurst = disabled;
  if (disabled) {
    this.pasteBurst.reset();
  }
}

export function setAutocompleteProvider(this: Editor, provider: AutocompleteProvider): void {
  this.cancelAutocomplete();
  this.autocompleteProvider = provider;
  this.setAutocompleteTriggerCharacters(provider.triggerCharacters ?? []);
}

export function setHistoryFilter(this: Editor, filter: ((entry: string) => boolean) | null): void {
  this.historyFilter = filter;
}

export function addToHistory(this: Editor, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  // Don't add consecutive duplicates
  if (this.history.length > 0 && this.history[0] === trimmed) return;
  this.history.unshift(trimmed);
  // Limit history size
  if (this.history.length > 100) {
    this.history.pop();
  }
}

export function invalidate(this: Editor, ): void {
  // No cached state to invalidate currently
}

export function getText(this: Editor, ): string {
  return this.state.lines.join("\n");
}

export function expandPasteMarkers(this: Editor, text: string): string {
  let result = text;
  for (const [pasteId, pasteContent] of this.pastes) {
    const markerRegex = new RegExp(
      `\\[paste #${pasteId}( (\\+\\d+ lines|\\d+ chars))?\\]`,
      "g",
    );
    result = result.replace(markerRegex, () => pasteContent);
  }
  return result;
}

export function getExpandedText(this: Editor, ): string {
  return this.expandPasteMarkers(this.state.lines.join("\n"));
}

export function getLines(this: Editor, ): string[] {
  return [...this.state.lines];
}

export function getCursor(this: Editor, ): { line: number; col: number } {
  return { line: this.state.cursorLine, col: this.state.cursorCol };
}

export function setText(this: Editor, text: string): void {
  this.cancelAutocomplete();
  this.lastAction = null;
  this.exitHistoryBrowsing();
  const normalized = this.normalizeText(text);
  // Push undo snapshot if content differs (makes programmatic changes undoable)
  if (this.getText() !== normalized) {
    this.pushUndoSnapshot();
  }
  this.setTextInternal(normalized);
}

export function insertTextAtCursor(this: Editor, text: string): void {
  if (!text) return;
  this.cancelAutocomplete();
  this.pushUndoSnapshot();
  this.lastAction = null;
  this.exitHistoryBrowsing();
  this.insertTextAtCursorInternal(text);
}

export function isShowingAutocomplete(this: Editor, ): boolean {
  return this.autocompleteState !== null;
}


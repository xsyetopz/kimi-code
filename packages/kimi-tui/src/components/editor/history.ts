import type { Editor } from "./component.ts";

export function navigateHistory(this: Editor, direction: 1 | -1): void {
  this.lastAction = null;
  if (this.history.length === 0) return;

  // When entering browse, capture host state up front — before the filter
  // runs — so the host's filter can read the browse-entry mode rather than a
  // mode that changes as entries are recalled. The captured value is only
  // committed to hostHistoryDraft once a matching entry is actually found.
  const entering = this.historyIndex === -1;
  const pendingHostDraft = entering ? this.onHistoryDraftSave?.() : undefined;

  // Find the next index that passes the filter. Up(-1) increases index,
  // Down(1) decreases. The draft (-1) is always reachable; stepping past
  // either end is a no-op.
  let newIndex = this.historyIndex;
  let found = false;
  while (true) {
    newIndex = newIndex - direction;
    if (newIndex === -1) {
      found = true;
      break;
    }
    if (newIndex < -1 || newIndex >= this.history.length) {
      found = false;
      break;
    }
    const candidate = this.history[newIndex];
    if (
      !this.historyFilter ||
      (candidate !== undefined && this.historyFilter(candidate))
    ) {
      found = true;
      break;
    }
  }
  if (!found) return;

  // Capture state when first entering history browsing mode
  if (entering && newIndex >= 0) {
    this.pushUndoSnapshot();
    this.historyDraft = structuredClone(this.state);
    this.hostHistoryDraft = pendingHostDraft;
  }

  this.historyIndex = newIndex;

  if (this.historyIndex === -1) {
    const draft = this.historyDraft;
    this.historyDraft = null;
    if (draft) {
      this.state = draft;
      this.preferredVisualCol = null;
      this.snappedFromCursorCol = null;
      this.scrollOffset = 0;
      if (this.hostHistoryDraft !== undefined) {
        this.onHistoryDraftRestore?.(this.hostHistoryDraft);
        this.hostHistoryDraft = undefined;
      }
      if (this.onChange) this.onChange(this.getText());
    } else {
      this.setTextInternal("");
    }
  } else {
    const rawEntry = this.history[this.historyIndex] || "";
    const entry = this.onRecall
      ? (this.onRecall(rawEntry, direction) ?? rawEntry)
      : rawEntry;
    this.setTextInternal(entry, direction === -1 ? "start" : "end");
  }
}

export function exitHistoryBrowsing(this: Editor): void {
  this.historyIndex = -1;
  this.historyDraft = null;
  this.hostHistoryDraft = undefined;
}

export function setTextInternal(
  this: Editor,
  text: string,
  cursorPlacement: "start" | "end" = "end",
): void {
  const lines = text.split("\n");
  this.state.lines = lines.length === 0 ? [""] : lines;
  this.state.cursorLine =
    cursorPlacement === "start" ? 0 : this.state.lines.length - 1;
  this.setCursorCol(
    cursorPlacement === "start"
      ? 0
      : this.state.lines[this.state.cursorLine]?.length || 0,
  );
  // Reset scroll - render() will adjust to show cursor
  this.scrollOffset = 0;

  if (this.onChange) {
    this.onChange(this.getText());
  }
}

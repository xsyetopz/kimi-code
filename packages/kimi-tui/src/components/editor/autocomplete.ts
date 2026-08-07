import { isWhitespaceChar } from "../../utils.ts";
import type { AutocompleteSuggestions } from "../../autocomplete.ts";
import { SelectList } from "../select-list.ts";
import {
  ATTACHMENT_AUTOCOMPLETE_DEBOUNCE_MS,
  buildDebouncePattern,
  buildTriggerPattern,
  DEFAULT_AUTOCOMPLETE_TRIGGER_CHARACTERS,
  SLASH_COMMAND_SELECT_LIST_LAYOUT,
} from "./types.ts";
import type { Editor } from "./component.ts";

export function isSlashMenuAllowed(this: Editor, ): boolean {
  return this.state.cursorLine === 0;
}

export function isAtStartOfMessage(this: Editor, ): boolean {
  if (!this.isSlashMenuAllowed()) return false;
  const currentLine = this.state.lines[this.state.cursorLine] || "";
  const beforeCursor = currentLine.slice(0, this.state.cursorCol);
  return beforeCursor.trim() === "" || beforeCursor.trim() === "/";
}

export function isInSlashCommandContext(this: Editor, textBeforeCursor: string): boolean {
  return (
    this.isSlashMenuAllowed() && textBeforeCursor.trimStart().startsWith("/")
  );
}

export function getBestAutocompleteMatchIndex(this: Editor, 
  items: Array<{ value: string; label: string }>,
  prefix: string,
): number {
  if (!prefix) return -1;

  let firstPrefixIndex = -1;

  for (let i = 0; i < items.length; i++) {
    const value = items[i]!.value;
    if (value === prefix) {
      return i; // Exact match always wins
    }
    if (firstPrefixIndex === -1 && value.startsWith(prefix)) {
      firstPrefixIndex = i;
    }
  }

  return firstPrefixIndex;
}

export function createAutocompleteList(this: Editor, 
  prefix: string,
  items: Array<{ value: string; label: string; description?: string }>,
): SelectList {
  const layout = prefix.startsWith("/")
    ? SLASH_COMMAND_SELECT_LIST_LAYOUT
    : undefined;
  return new SelectList(
    items,
    this.autocompleteMaxVisible,
    this.theme.selectList,
    layout,
  );
}

export function tryTriggerAutocomplete(this: Editor, explicitTab: boolean = false): void {
  this.requestAutocomplete({ force: false, explicitTab });
}

export function handleTabCompletion(this: Editor, ): void {
  if (!this.autocompleteProvider) return;

  const currentLine = this.state.lines[this.state.cursorLine] || "";
  const beforeCursor = currentLine.slice(0, this.state.cursorCol);

  if (
    this.isInSlashCommandContext(beforeCursor) &&
    !beforeCursor.trimStart().includes(" ")
  ) {
    this.handleSlashCommandCompletion();
  } else {
    this.forceFileAutocomplete(true);
  }
}

export function handleSlashCommandCompletion(this: Editor, ): void {
  this.requestAutocomplete({ force: false, explicitTab: true });
}

export function forceFileAutocomplete(this: Editor, explicitTab: boolean = false): void {
  this.requestAutocomplete({ force: true, explicitTab });
}

export function requestAutocomplete(this: Editor, options: {
  force: boolean;
  explicitTab: boolean;
}): void {
  if (!this.autocompleteProvider) return;

  if (options.force) {
    const shouldTrigger =
      !this.autocompleteProvider.shouldTriggerFileCompletion ||
      this.autocompleteProvider.shouldTriggerFileCompletion(
        this.state.lines,
        this.state.cursorLine,
        this.state.cursorCol,
      );
    if (!shouldTrigger) {
      return;
    }
  }

  this.cancelAutocompleteRequest();
  const startToken = ++this.autocompleteStartToken;

  const debounceMs = this.getAutocompleteDebounceMs(options);
  if (debounceMs > 0) {
    this.autocompleteDebounceTimer = setTimeout(() => {
      this.autocompleteDebounceTimer = undefined;
      void this.startAutocompleteRequest(startToken, options);
    }, debounceMs);
    return;
  }

  void this.startAutocompleteRequest(startToken, options);
}

export async function startAutocompleteRequest(
  this: Editor,
  startToken: number,
  options: { force: boolean; explicitTab: boolean },
): Promise<void> {
  const previousTask = this.autocompleteRequestTask;
  this.autocompleteRequestTask = (async () => {
    await previousTask;
    if (
      startToken !== this.autocompleteStartToken ||
      !this.autocompleteProvider
    ) {
      return;
    }

    const controller = new AbortController();
    this.autocompleteAbort = controller;
    const requestId = ++this.autocompleteRequestId;
    const snapshotText = this.getText();
    const snapshotLine = this.state.cursorLine;
    const snapshotCol = this.state.cursorCol;

    await this.runAutocompleteRequest(
      requestId,
      controller,
      snapshotText,
      snapshotLine,
      snapshotCol,
      options,
    );
  })();
  await this.autocompleteRequestTask;
}

export function setAutocompleteTriggerCharacters(this: Editor, triggerCharacters: string[]): void {
  const next = [...DEFAULT_AUTOCOMPLETE_TRIGGER_CHARACTERS];
  for (const character of triggerCharacters) {
    if (
      character.length !== 1 ||
      character === "/" ||
      isWhitespaceChar(character) ||
      next.includes(character)
    ) {
      continue;
    }
    next.push(character);
  }
  this.autocompleteTriggerCharacters = next;
  this.autocompleteTriggerPattern = buildTriggerPattern(next);
  this.autocompleteDebouncePattern = buildDebouncePattern(next);
}

export function getAutocompleteDebounceMs(this: Editor, options: {
  force: boolean;
  explicitTab: boolean;
}): number {
  if (options.explicitTab || options.force) {
    return 0;
  }

  const currentLine = this.state.lines[this.state.cursorLine] || "";
  const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
  return this.autocompleteDebouncePattern.test(textBeforeCursor)
    ? ATTACHMENT_AUTOCOMPLETE_DEBOUNCE_MS
    : 0;
}

export async function runAutocompleteRequest(
  this: Editor,
  requestId: number,
  controller: AbortController,
  snapshotText: string,
  snapshotLine: number,
  snapshotCol: number,
  options: { force: boolean; explicitTab: boolean },
): Promise<void> {
  if (!this.autocompleteProvider) return;

  const suggestions = await this.autocompleteProvider.getSuggestions(
    this.state.lines,
    this.state.cursorLine,
    this.state.cursorCol,
    { signal: controller.signal, force: options.force },
  );

  if (
    !this.isAutocompleteRequestCurrent(
      requestId,
      controller,
      snapshotText,
      snapshotLine,
      snapshotCol,
    )
  ) {
    return;
  }

  this.autocompleteAbort = undefined;

  if (
    !suggestions ||
    !Array.isArray(suggestions.items) ||
    suggestions.items.length === 0
  ) {
    this.cancelAutocomplete();
    this.tui.requestRender();
    return;
  }

  if (
    options.force &&
    options.explicitTab &&
    suggestions.items.length === 1
  ) {
    const item = suggestions.items[0]!;
    this.pushUndoSnapshot();
    this.lastAction = null;
    const result = this.autocompleteProvider.applyCompletion(
      this.state.lines,
      this.state.cursorLine,
      this.state.cursorCol,
      item,
      suggestions.prefix,
    );
    this.state.lines = result.lines;
    this.state.cursorLine = result.cursorLine;
    this.setCursorCol(result.cursorCol);
    if (this.onChange) this.onChange(this.getText());
    this.tui.requestRender();
    return;
  }

  this.applyAutocompleteSuggestions(
    suggestions,
    options.force ? "force" : "regular",
  );
  this.tui.requestRender();
}

export function isAutocompleteRequestCurrent(this: Editor, 
  requestId: number,
  controller: AbortController,
  snapshotText: string,
  snapshotLine: number,
  snapshotCol: number,
): boolean {
  return (
    !controller.signal.aborted &&
    requestId === this.autocompleteRequestId &&
    this.getText() === snapshotText &&
    this.state.cursorLine === snapshotLine &&
    this.state.cursorCol === snapshotCol
  );
}

export function applyAutocompleteSuggestions(this: Editor, 
  suggestions: AutocompleteSuggestions,
  state: "regular" | "force",
): void {
  this.autocompletePrefix = suggestions.prefix;
  this.autocompleteList = this.createAutocompleteList(
    suggestions.prefix,
    suggestions.items,
  );

  const bestMatchIndex = this.getBestAutocompleteMatchIndex(
    suggestions.items,
    suggestions.prefix,
  );
  if (bestMatchIndex >= 0) {
    this.autocompleteList.setSelectedIndex(bestMatchIndex);
  }

  this.autocompleteState = state;
}

export function cancelAutocompleteRequest(this: Editor, ): void {
  this.autocompleteStartToken += 1;
  if (this.autocompleteDebounceTimer) {
    clearTimeout(this.autocompleteDebounceTimer);
    this.autocompleteDebounceTimer = undefined;
  }
  this.autocompleteAbort?.abort();
  this.autocompleteAbort = undefined;
}

export function clearAutocompleteUi(this: Editor, ): void {
  this.autocompleteState = null;
  this.autocompleteList = undefined;
  this.autocompletePrefix = "";
}

export function cancelAutocomplete(this: Editor, ): void {
  this.cancelAutocompleteRequest();
  this.clearAutocompleteUi();
}

export function updateAutocomplete(this: Editor, ): void {
  if (!this.autocompleteState || !this.autocompleteProvider) return;
  this.requestAutocomplete({
    force: this.autocompleteState === "force",
    explicitTab: false,
  });
}


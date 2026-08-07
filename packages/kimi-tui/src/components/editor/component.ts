import type { AutocompleteProvider } from "../../autocomplete.ts";
import { KillRing } from "../../kill-ring.ts";
import { PasteBurst } from "../../paste-burst.ts";
import type { Component, Focusable, TUI } from "../../tui.ts";
import { UndoStack } from "../../undo-stack.ts";
import type { SelectList } from "../select-list.ts";
import {
  applyAutocompleteSuggestions,
  cancelAutocomplete,
  cancelAutocompleteRequest,
  clearAutocompleteUi,
  createAutocompleteList,
  forceFileAutocomplete,
  getAutocompleteDebounceMs,
  getBestAutocompleteMatchIndex,
  handleSlashCommandCompletion,
  handleTabCompletion,
  isAtStartOfMessage,
  isAutocompleteRequestCurrent,
  isInSlashCommandContext,
  isSlashMenuAllowed,
  requestAutocomplete,
  runAutocompleteRequest,
  setAutocompleteTriggerCharacters,
  startAutocompleteRequest,
  tryTriggerAutocomplete,
  updateAutocomplete,
} from "./autocomplete.ts";
import {
  computeVerticalMoveColumn,
  deleteToEndOfLine,
  deleteToStartOfLine,
  deleteWordBackwards,
  deleteWordForward,
  handleBackspace,
  handleForwardDelete,
  moveToLineEnd,
  moveToLineStart,
  moveToVisualLine,
  setCursorCol,
} from "./cursor.ts";
import {
  addNewLine,
  handlePaste,
  insertCharacter,
  insertTextAtCursorInternal,
  isEditorEmpty,
  isOnFirstVisualLine,
  isOnLastVisualLine,
  normalizeText,
  pushUndoSnapshot,
  shouldSubmitOnBackslashEnter,
  submitValue,
  undo,
} from "./editing.ts";
import {
  exitHistoryBrowsing,
  navigateHistory,
  setTextInternal,
} from "./history.ts";
import { handleInput } from "./input.ts";
import { layoutText } from "./layout.ts";
import {
  buildVisualLineMap,
  deleteYankedText,
  findCurrentVisualLine,
  findVisualLineAt,
  insertYankedText,
  jumpToChar,
  moveCursor,
  moveWordBackwards,
  moveWordForwards,
  pageScroll,
  yank,
  yankPop,
} from "./navigation.ts";
import { render } from "./render.ts";
import { segment, validPasteIds } from "./segment.ts";
import {
  addToHistory,
  expandPasteMarkers,
  getAutocompleteMaxVisible,
  getCursor,
  getExpandedText,
  getLines,
  getPaddingX,
  getText,
  insertTextAtCursor,
  invalidate,
  isShowingAutocomplete,
  setAutocompleteMaxVisible,
  setAutocompleteProvider,
  setDisablePasteBurst,
  setHistoryFilter,
  setPaddingX,
  setText,
} from "./textApi.ts";
import {
  buildDebouncePattern,
  buildTriggerPattern,
  DEFAULT_AUTOCOMPLETE_TRIGGER_CHARACTERS,
  type EditorOptions,
  type EditorState,
  type EditorTheme,
} from "./types.ts";

export class Editor implements Component, Focusable {
  protected state: EditorState = {
    lines: [""],
    cursorLine: 0,
    cursorCol: 0,
  };

  /** Focusable interface - set by TUI when focus changes */
  focused: boolean = false;

  protected tui: TUI;
  protected theme: EditorTheme;
  protected paddingX: number = 0;

  // Store last render width for cursor navigation
  protected lastWidth: number = 80;

  // Vertical scrolling support
  protected scrollOffset: number = 0;

  // Border color (can be changed dynamically)
  public borderColor: (str: string) => string;

  // Autocomplete support
  protected autocompleteProvider?: AutocompleteProvider;
  protected autocompleteTriggerCharacters = [
    ...DEFAULT_AUTOCOMPLETE_TRIGGER_CHARACTERS,
  ];
  protected autocompleteTriggerPattern = buildTriggerPattern(
    this.autocompleteTriggerCharacters,
  );
  protected autocompleteDebouncePattern = buildDebouncePattern(
    this.autocompleteTriggerCharacters,
  );
  protected autocompleteList?: SelectList;
  protected autocompleteState: "regular" | "force" | null = null;
  protected autocompletePrefix: string = "";
  protected autocompleteMaxVisible: number = 5;
  protected autocompleteAbort?: AbortController;
  protected autocompleteDebounceTimer?: ReturnType<typeof setTimeout>;
  protected autocompleteRequestTask: Promise<void> = Promise.resolve();
  protected autocompleteStartToken: number = 0;
  protected autocompleteRequestId: number = 0;

  // Paste tracking for large pastes
  protected pastes: Map<number, string> = new Map();
  protected pasteCounter: number = 0;

  // Bracketed paste mode buffering
  protected pasteBuffer: string = "";
  protected isInPaste: boolean = false;

  // Non-bracketed paste-burst fallback
  protected pasteBurst = new PasteBurst();
  protected disablePasteBurst: boolean = false;

  // Prompt history for up/down navigation
  protected history: string[] = [];
  protected historyIndex: number = -1; // -1 = not browsing, 0 = most recent, 1 = older, etc.
  protected historyDraft: EditorState | null = null;
  protected hostHistoryDraft: unknown = undefined;
  protected historyFilter: ((entry: string) => boolean) | null = null;

  // Kill ring for Emacs-style kill/yank operations
  protected killRing = new KillRing();
  protected lastAction: "kill" | "yank" | "type-word" | null = null;

  // Character jump mode
  protected jumpMode: "forward" | "backward" | null = null;

  // Preferred visual column for vertical cursor movement (sticky column)
  protected preferredVisualCol: number | null = null;

  // When the cursor is snapped to the start of an atomic segment, e.g. a
  // paste marker, cursorCol no longer reflects where the cursor would have
  // landed. This field stores the pre-snap cursorCol so that the next
  // vertical move can resolve it to a visual column on whatever VL it belongs
  // to.
  protected snappedFromCursorCol: number | null = null;

  // Undo support
  protected undoStack = new UndoStack<EditorState>();

  public onSubmit?: (text: string) => void;
  public onChange?: (text: string) => void;
  /**
   * Called when a history entry is recalled, before it is put into the buffer.
   * Return the text to display, or `undefined` to use the entry as-is. Lets the
   * host decorate entries (e.g. strip a marker) and react to recalls (e.g.
   * switch input mode) without touching editor internals.
   */
  public onRecall?: (entry: string, direction: 1 | -1) => string | undefined;
  /**
   * Called when entering history browsing, to capture host state that should be
   * saved alongside the editor draft. The returned value is passed to
   * `onHistoryDraftRestore` when the user navigates back to the draft, so the
   * host can restore state the editor does not own (e.g. an input mode).
   */
  public onHistoryDraftSave?: () => unknown;
  /** Called with the value from `onHistoryDraftSave` when the draft is restored. */
  public onHistoryDraftRestore?: (state: unknown) => void;
  public disableSubmit: boolean = false;

  constructor(tui: TUI, theme: EditorTheme, options: EditorOptions = {}) {
    this.tui = tui;
    this.theme = theme;
    this.borderColor = theme.borderColor;
    const paddingX = options.paddingX ?? 0;
    this.paddingX = Number.isFinite(paddingX)
      ? Math.max(0, Math.floor(paddingX))
      : 0;
    const maxVisible = options.autocompleteMaxVisible ?? 5;
    this.autocompleteMaxVisible = Number.isFinite(maxVisible)
      ? Math.max(3, Math.min(20, Math.floor(maxVisible)))
      : 5;
    this.disablePasteBurst = options.disablePasteBurst ?? false;
  }

  validPasteIds = validPasteIds;
  segment = segment;
  getPaddingX = getPaddingX;
  setPaddingX = setPaddingX;
  getAutocompleteMaxVisible = getAutocompleteMaxVisible;
  setAutocompleteMaxVisible = setAutocompleteMaxVisible;
  setDisablePasteBurst = setDisablePasteBurst;
  setAutocompleteProvider = setAutocompleteProvider;
  setHistoryFilter = setHistoryFilter;
  addToHistory = addToHistory;
  isEditorEmpty = isEditorEmpty;
  isOnFirstVisualLine = isOnFirstVisualLine;
  isOnLastVisualLine = isOnLastVisualLine;
  navigateHistory = navigateHistory;
  exitHistoryBrowsing = exitHistoryBrowsing;
  setTextInternal = setTextInternal;
  invalidate = invalidate;
  render = render;
  handleInput = handleInput;
  layoutText = layoutText;
  getText = getText;
  expandPasteMarkers = expandPasteMarkers;
  getExpandedText = getExpandedText;
  getLines = getLines;
  getCursor = getCursor;
  setText = setText;
  insertTextAtCursor = insertTextAtCursor;
  normalizeText = normalizeText;
  insertTextAtCursorInternal = insertTextAtCursorInternal;
  insertCharacter = insertCharacter;
  handlePaste = handlePaste;
  addNewLine = addNewLine;
  shouldSubmitOnBackslashEnter = shouldSubmitOnBackslashEnter;
  submitValue = submitValue;
  handleBackspace = handleBackspace;
  setCursorCol = setCursorCol;
  moveToVisualLine = moveToVisualLine;
  computeVerticalMoveColumn = computeVerticalMoveColumn;
  moveToLineStart = moveToLineStart;
  moveToLineEnd = moveToLineEnd;
  deleteToStartOfLine = deleteToStartOfLine;
  deleteToEndOfLine = deleteToEndOfLine;
  deleteWordBackwards = deleteWordBackwards;
  deleteWordForward = deleteWordForward;
  handleForwardDelete = handleForwardDelete;
  buildVisualLineMap = buildVisualLineMap;
  findVisualLineAt = findVisualLineAt;
  findCurrentVisualLine = findCurrentVisualLine;
  moveCursor = moveCursor;
  pageScroll = pageScroll;
  moveWordBackwards = moveWordBackwards;
  yank = yank;
  yankPop = yankPop;
  insertYankedText = insertYankedText;
  deleteYankedText = deleteYankedText;
  pushUndoSnapshot = pushUndoSnapshot;
  undo = undo;
  jumpToChar = jumpToChar;
  moveWordForwards = moveWordForwards;
  isSlashMenuAllowed = isSlashMenuAllowed;
  isAtStartOfMessage = isAtStartOfMessage;
  isInSlashCommandContext = isInSlashCommandContext;
  getBestAutocompleteMatchIndex = getBestAutocompleteMatchIndex;
  createAutocompleteList = createAutocompleteList;
  tryTriggerAutocomplete = tryTriggerAutocomplete;
  handleTabCompletion = handleTabCompletion;
  handleSlashCommandCompletion = handleSlashCommandCompletion;
  forceFileAutocomplete = forceFileAutocomplete;
  requestAutocomplete = requestAutocomplete;
  startAutocompleteRequest = startAutocompleteRequest;
  setAutocompleteTriggerCharacters = setAutocompleteTriggerCharacters;
  getAutocompleteDebounceMs = getAutocompleteDebounceMs;
  runAutocompleteRequest = runAutocompleteRequest;
  isAutocompleteRequestCurrent = isAutocompleteRequestCurrent;
  applyAutocompleteSuggestions = applyAutocompleteSuggestions;
  cancelAutocompleteRequest = cancelAutocompleteRequest;
  clearAutocompleteUi = clearAutocompleteUi;
  cancelAutocomplete = cancelAutocomplete;
  isShowingAutocomplete = isShowingAutocomplete;
  updateAutocomplete = updateAutocomplete;
}

import type { AutocompleteProvider } from "../../autocomplete.ts";
import { KillRing } from "../../kill-ring.ts";
import { PasteBurst } from "../../paste-burst.ts";
import { type Component, type Focusable, type TUI } from "../../tui.ts";
import { UndoStack } from "../../undo-stack.ts";
import type { SelectList } from "../select-list.ts";
import {
  buildDebouncePattern,
  buildTriggerPattern,
  DEFAULT_AUTOCOMPLETE_TRIGGER_CHARACTERS,
  type EditorOptions,
  type EditorState,
  type EditorTheme,
} from "./types.ts";
import { validPasteIds } from "./segment.ts";
import { segment } from "./segment.ts";
import { getPaddingX } from "./textApi.ts";
import { setPaddingX } from "./textApi.ts";
import { getAutocompleteMaxVisible } from "./textApi.ts";
import { setAutocompleteMaxVisible } from "./textApi.ts";
import { setDisablePasteBurst } from "./textApi.ts";
import { setAutocompleteProvider } from "./textApi.ts";
import { setHistoryFilter } from "./textApi.ts";
import { addToHistory } from "./textApi.ts";
import { isEditorEmpty } from "./editing.ts";
import { isOnFirstVisualLine } from "./editing.ts";
import { isOnLastVisualLine } from "./editing.ts";
import { navigateHistory } from "./history.ts";
import { exitHistoryBrowsing } from "./history.ts";
import { setTextInternal } from "./history.ts";
import { invalidate } from "./textApi.ts";
import { render } from "./render.ts";
import { handleInput } from "./input.ts";
import { layoutText } from "./layout.ts";
import { getText } from "./textApi.ts";
import { expandPasteMarkers } from "./textApi.ts";
import { getExpandedText } from "./textApi.ts";
import { getLines } from "./textApi.ts";
import { getCursor } from "./textApi.ts";
import { setText } from "./textApi.ts";
import { insertTextAtCursor } from "./textApi.ts";
import { normalizeText } from "./editing.ts";
import { insertTextAtCursorInternal } from "./editing.ts";
import { insertCharacter } from "./editing.ts";
import { handlePaste } from "./editing.ts";
import { addNewLine } from "./editing.ts";
import { shouldSubmitOnBackslashEnter } from "./editing.ts";
import { submitValue } from "./editing.ts";
import { handleBackspace } from "./cursor.ts";
import { setCursorCol } from "./cursor.ts";
import { moveToVisualLine } from "./cursor.ts";
import { computeVerticalMoveColumn } from "./cursor.ts";
import { moveToLineStart } from "./cursor.ts";
import { moveToLineEnd } from "./cursor.ts";
import { deleteToStartOfLine } from "./cursor.ts";
import { deleteToEndOfLine } from "./cursor.ts";
import { deleteWordBackwards } from "./cursor.ts";
import { deleteWordForward } from "./cursor.ts";
import { handleForwardDelete } from "./cursor.ts";
import { buildVisualLineMap } from "./navigation.ts";
import { findVisualLineAt } from "./navigation.ts";
import { findCurrentVisualLine } from "./navigation.ts";
import { moveCursor } from "./navigation.ts";
import { pageScroll } from "./navigation.ts";
import { moveWordBackwards } from "./navigation.ts";
import { yank } from "./navigation.ts";
import { yankPop } from "./navigation.ts";
import { insertYankedText } from "./navigation.ts";
import { deleteYankedText } from "./navigation.ts";
import { pushUndoSnapshot } from "./editing.ts";
import { undo } from "./editing.ts";
import { jumpToChar } from "./navigation.ts";
import { moveWordForwards } from "./navigation.ts";
import { isSlashMenuAllowed } from "./autocomplete.ts";
import { isAtStartOfMessage } from "./autocomplete.ts";
import { isInSlashCommandContext } from "./autocomplete.ts";
import { getBestAutocompleteMatchIndex } from "./autocomplete.ts";
import { createAutocompleteList } from "./autocomplete.ts";
import { tryTriggerAutocomplete } from "./autocomplete.ts";
import { handleTabCompletion } from "./autocomplete.ts";
import { handleSlashCommandCompletion } from "./autocomplete.ts";
import { forceFileAutocomplete } from "./autocomplete.ts";
import { requestAutocomplete } from "./autocomplete.ts";
import { startAutocompleteRequest } from "./autocomplete.ts";
import { setAutocompleteTriggerCharacters } from "./autocomplete.ts";
import { getAutocompleteDebounceMs } from "./autocomplete.ts";
import { runAutocompleteRequest } from "./autocomplete.ts";
import { isAutocompleteRequestCurrent } from "./autocomplete.ts";
import { applyAutocompleteSuggestions } from "./autocomplete.ts";
import { cancelAutocompleteRequest } from "./autocomplete.ts";
import { clearAutocompleteUi } from "./autocomplete.ts";
import { cancelAutocomplete } from "./autocomplete.ts";
import { isShowingAutocomplete } from "./textApi.ts";
import { updateAutocomplete } from "./autocomplete.ts";

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

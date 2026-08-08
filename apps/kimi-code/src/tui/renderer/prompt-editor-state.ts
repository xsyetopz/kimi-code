export type PromptInputMode = "prompt" | "bash";

export interface PromptCompletionState {
  readonly items: readonly string[];
  readonly selected: number;
}

/** Renderer-neutral prompt buffer. Cursor is a UTF-16 offset in `text`. */
export interface PromptEditorState {
  readonly text: string;
  readonly cursor: number;
  readonly inputMode: PromptInputMode;
  readonly history: readonly string[];
  readonly historyIndex: number | null;
  readonly historyDraft: string;
  readonly completion: PromptCompletionState | null;
}

export type PromptEditorAction =
  | { readonly type: "insert"; readonly text: string }
  | { readonly type: "backspace" }
  | { readonly type: "delete" }
  | { readonly type: "delete-to-line-start" }
  | { readonly type: "delete-word-backward" }
  | { readonly type: "move-left" }
  | { readonly type: "move-right" }
  | { readonly type: "move-word-left" }
  | { readonly type: "move-word-right" }
  | { readonly type: "move-up" }
  | { readonly type: "move-down" }
  | { readonly type: "move-home" }
  | { readonly type: "move-end" }
  | { readonly type: "newline" }
  | { readonly type: "set-text"; readonly text: string }
  | { readonly type: "set-mode"; readonly inputMode: PromptInputMode }
  | { readonly type: "history-add"; readonly text: string }
  | { readonly type: "history-up" }
  | { readonly type: "history-down" }
  | { readonly type: "completion-set"; readonly items: readonly string[] }
  | { readonly type: "completion-next" }
  | { readonly type: "completion-previous" }
  | { readonly type: "completion-accept" }
  | { readonly type: "completion-cancel" };

export function createPromptEditorState(
  initial: Partial<
    Pick<PromptEditorState, "text" | "cursor" | "inputMode" | "history">
  > = {},
): PromptEditorState {
  const text = initial.text ?? "";
  return {
    text,
    cursor: clampCursor(initial.cursor ?? text.length, text),
    inputMode: initial.inputMode ?? "prompt",
    history: [...(initial.history ?? [])],
    historyIndex: null,
    historyDraft: "",
    completion: null,
  };
}

export function promptEditorLineColumn(
  state: Pick<PromptEditorState, "text" | "cursor">,
): { readonly line: number; readonly column: number } {
  const before = state.text.slice(0, clampCursor(state.cursor, state.text));
  const lines = before.split("\n");
  return { line: lines.length - 1, column: lines.at(-1)?.length ?? 0 };
}

export function reducePromptEditor(
  state: PromptEditorState,
  action: PromptEditorAction,
): PromptEditorState {
  switch (action.type) {
    case "insert": {
      if (action.text.length === 0) return state;
      const text =
        state.text.slice(0, state.cursor) +
        action.text +
        state.text.slice(state.cursor);
      return resetCompletion({
        ...state,
        text,
        cursor: state.cursor + action.text.length,
      });
    }
    case "newline":
      return reducePromptEditor(state, { type: "insert", text: "\n" });
    case "backspace": {
      if (state.cursor === 0) return state;
      const text =
        state.text.slice(0, state.cursor - 1) + state.text.slice(state.cursor);
      return resetCompletion({ ...state, text, cursor: state.cursor - 1 });
    }
    case "delete": {
      if (state.cursor >= state.text.length) return state;
      const text =
        state.text.slice(0, state.cursor) + state.text.slice(state.cursor + 1);
      return resetCompletion({ ...state, text });
    }
    case "delete-to-line-start": {
      const lineStart = state.text.lastIndexOf("\n", state.cursor - 1) + 1;
      if (state.cursor <= lineStart) return state;
      const text =
        state.text.slice(0, lineStart) + state.text.slice(state.cursor);
      return resetCompletion({ ...state, text, cursor: lineStart });
    }
    case "delete-word-backward": {
      if (state.cursor === 0) return state;
      const deleteFrom = findWordBoundaryLeft(state.text, state.cursor);
      const text =
        state.text.slice(0, deleteFrom) + state.text.slice(state.cursor);
      return resetCompletion({ ...state, text, cursor: deleteFrom });
    }
    case "move-left":
      return { ...state, cursor: Math.max(0, state.cursor - 1) };
    case "move-right":
      return {
        ...state,
        cursor: Math.min(state.text.length, state.cursor + 1),
      };
    case "move-word-left":
      return {
        ...state,
        cursor: findWordBoundaryLeft(state.text, state.cursor),
      };
    case "move-word-right":
      return {
        ...state,
        cursor: findWordBoundaryRight(state.text, state.cursor),
      };
    case "move-up":
      return moveVertical(state, -1);
    case "move-down":
      return moveVertical(state, 1);
    case "move-home": {
      const lineStart = state.text.lastIndexOf("\n", state.cursor - 1) + 1;
      return { ...state, cursor: lineStart };
    }
    case "move-end": {
      const lineEnd = state.text.indexOf("\n", state.cursor);
      return { ...state, cursor: lineEnd === -1 ? state.text.length : lineEnd };
    }
    case "set-text":
      return resetCompletion({
        ...state,
        text: action.text,
        cursor: action.text.length,
        historyIndex: null,
      });
    case "set-mode":
      return { ...state, inputMode: action.inputMode };
    case "history-add": {
      const text = action.text.trim();
      if (text.length === 0 || state.history.at(-1) === text) return state;
      return { ...state, history: [...state.history, text] };
    }
    case "history-up":
      return historyMove(state, -1);
    case "history-down":
      return historyMove(state, 1);
    case "completion-set":
      return {
        ...state,
        completion:
          action.items.length === 0
            ? null
            : { items: [...action.items], selected: 0 },
      };
    case "completion-next":
      return moveCompletion(state, 1);
    case "completion-previous":
      return moveCompletion(state, -1);
    case "completion-cancel":
      return { ...state, completion: null };
    case "completion-accept": {
      const item = state.completion?.items[state.completion.selected];
      if (item === undefined) return state;
      const suffix = item.endsWith(" ") ? item : `${item} `;
      const next = {
        ...state,
        text: suffix,
        cursor: suffix.length,
        completion: null,
      };
      return next;
    }
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

function findWordBoundaryLeft(text: string, cursor: number): number {
  if (cursor <= 0) return 0;
  let index = cursor;
  while (index > 0 && /\s/u.test(text[index - 1]!)) index -= 1;
  while (index > 0 && !/\s/u.test(text[index - 1]!)) index -= 1;
  return index;
}

function findWordBoundaryRight(text: string, cursor: number): number {
  if (cursor >= text.length) return text.length;
  let index = cursor;
  while (index < text.length && !/\s/u.test(text[index]!)) index += 1;
  while (index < text.length && /\s/u.test(text[index]!)) index += 1;
  return index;
}

function historyMove(
  state: PromptEditorState,
  delta: -1 | 1,
): PromptEditorState {
  if (state.history.length === 0) return state;
  if (state.historyIndex === null) {
    if (delta > 0) return state;
    const index = state.history.length - 1;
    return {
      ...state,
      historyIndex: index,
      historyDraft: state.text,
      text: state.history[index] ?? "",
      cursor: state.history[index]?.length ?? 0,
    };
  }
  const nextIndex = state.historyIndex + delta;
  if (nextIndex < 0) return state;
  if (nextIndex >= state.history.length) {
    if (delta < 0) return state;
    return {
      ...state,
      historyIndex: null,
      text: state.historyDraft,
      cursor: state.historyDraft.length,
    };
  }
  const text = state.history[nextIndex] ?? "";
  return { ...state, historyIndex: nextIndex, text, cursor: text.length };
}

function moveCompletion(
  state: PromptEditorState,
  delta: -1 | 1,
): PromptEditorState {
  const completion = state.completion;
  if (completion === null || completion.items.length === 0) return state;
  const selected =
    (completion.selected + delta + completion.items.length) %
    completion.items.length;
  return { ...state, completion: { ...completion, selected } };
}

function moveVertical(
  state: PromptEditorState,
  delta: -1 | 1,
): PromptEditorState {
  const { line, column } = promptEditorLineColumn(state);
  const lines = state.text.split("\n");
  const target = line + delta;
  if (target < 0 || target >= lines.length) return state;
  let offset = 0;
  for (let index = 0; index < target; index++) {
    offset += (lines[index]?.length ?? 0) + 1;
  }
  return {
    ...state,
    cursor: offset + Math.min(column, lines[target]?.length ?? 0),
  };
}

function resetCompletion(state: PromptEditorState): PromptEditorState {
  return state.completion === null ? state : { ...state, completion: null };
}

function clampCursor(cursor: number, text: string): number {
  return Math.max(0, Math.min(text.length, cursor));
}

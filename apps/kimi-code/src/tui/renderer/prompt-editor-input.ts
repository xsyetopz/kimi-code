import type { PromptEditorState } from "./prompt-editor-state";

export type PromptSemanticAction =
  | "ctrl-c"
  | "ctrl-d"
  | "ctrl-g"
  | "ctrl-o"
  | "ctrl-s"
  | "ctrl-b"
  | "ctrl-t"
  | "paste-image"
  | "undo"
  | "shift-tab"
  | "escape"
  | "up-empty"
  | "down-empty";

export type PromptEditorRoute =
  | {
      readonly type: "action";
      readonly action: import("./prompt-editor-state").PromptEditorAction;
    }
  | {
      readonly type: "submit";
      readonly text: string;
      readonly inputMode: "prompt" | "bash";
    }
  | { readonly type: "semantic"; readonly action: PromptSemanticAction }
  | { readonly type: "noop" };

/** Translate Ink's canonical key bytes into editor actions or host semantics. */
export function routePromptEditorInput(
  state: PromptEditorState,
  data: string,
): PromptEditorRoute {
  if (data === "\r") {
    return { type: "submit", text: state.text, inputMode: state.inputMode };
  }
  if (data === "\n") return { type: "action", action: { type: "newline" } };
  if (data === "\u007f" || data === "\u0008") {
    if (state.inputMode === "bash" && state.text.length === 0) {
      return {
        type: "action",
        action: { type: "set-mode", inputMode: "prompt" },
      };
    }
    return { type: "action", action: { type: "backspace" } };
  }
  if (data === "\u0004") {
    return state.text.length === 0
      ? { type: "semantic", action: "ctrl-d" }
      : { type: "action", action: { type: "delete" } };
  }
  if (data === "\u0001")
    return { type: "action", action: { type: "move-home" } };
  if (data === "\u0005")
    return { type: "action", action: { type: "move-end" } };
  if (data === "\u0016" || data === "\u001bv") {
    return { type: "semantic", action: "paste-image" };
  }
  if (data === "\u001b") {
    if (state.completion !== null) {
      return { type: "action", action: { type: "completion-cancel" } };
    }
    if (state.inputMode === "bash" && state.text.length === 0) {
      return {
        type: "action",
        action: { type: "set-mode", inputMode: "prompt" },
      };
    }
    return { type: "semantic", action: "escape" };
  }
  if (data === "\u001b[Z") return { type: "semantic", action: "shift-tab" };
  if (data === "\u001b[A") {
    return state.completion !== null
      ? { type: "action", action: { type: "completion-previous" } }
      : state.text.length === 0
        ? { type: "semantic", action: "up-empty" }
        : { type: "action", action: { type: "move-up" } };
  }
  if (data === "\u001b[B") {
    return state.completion !== null
      ? { type: "action", action: { type: "completion-next" } }
      : state.text.length === 0
        ? { type: "semantic", action: "down-empty" }
        : { type: "action", action: { type: "move-down" } };
  }
  if (data === "\u001b[C")
    return { type: "action", action: { type: "move-right" } };
  if (data === "\u001b[D")
    return { type: "action", action: { type: "move-left" } };
  if (data === "\u001b[H")
    return { type: "action", action: { type: "move-home" } };
  if (data === "\u001b[F")
    return { type: "action", action: { type: "move-end" } };
  if (data === "\u001b[3~")
    return { type: "action", action: { type: "delete" } };
  if (data === "\t") {
    return state.completion === null
      ? { type: "noop" }
      : { type: "action", action: { type: "completion-accept" } };
  }

  const semantic = semanticForControl(data);
  if (semantic !== undefined) return { type: "semantic", action: semantic };
  if (data === "!" && state.inputMode === "prompt" && state.text.length === 0) {
    return { type: "action", action: { type: "set-mode", inputMode: "bash" } };
  }
  if (
    state.inputMode === "prompt" &&
    state.text.length === 0 &&
    data.startsWith("!")
  ) {
    return {
      type: "action",
      action: { type: "insert", text: data.slice(1) },
    };
  }
  if (data.length > 0 && !data.startsWith("\u001b")) {
    return { type: "action", action: { type: "insert", text: data } };
  }
  return { type: "noop" };
}

function semanticForControl(data: string): PromptSemanticAction | undefined {
  switch (data) {
    case "\u0003":
      return "ctrl-c";
    case "\u0007":
      return "ctrl-g";
    case "\u000f":
      return "ctrl-o";
    case "\u0013":
      return "ctrl-s";
    case "\u0002":
      return "ctrl-b";
    case "\u0014":
      return "ctrl-t";
    case "\u001f":
      return "undo";
    default:
      return undefined;
  }
}

import { describe, expect, it } from "vitest";

import {
  createPromptEditorState,
  promptEditorLineColumn,
  reducePromptEditor,
} from "#/tui/renderer/prompt-editor-state";
import { routePromptEditorInput } from "#/tui/renderer/prompt-editor-input";

function apply(
  text: string,
  ...actions: Parameters<typeof reducePromptEditor>[1][]
) {
  return actions.reduce(
    (state, action) => reducePromptEditor(state, action),
    createPromptEditorState({ text }),
  );
}

describe("prompt editor state", () => {
  it("edits multiline text and reports a stable line/column cursor", () => {
    const state = apply(
      "ab",
      { type: "insert", text: "\ncd" },
      { type: "move-left" },
      { type: "backspace" },
    );

    expect(state.text).toBe("ab\nd");
    expect(promptEditorLineColumn(state)).toEqual({ line: 1, column: 0 });
  });

  it("preserves a draft while navigating history", () => {
    let state = createPromptEditorState({ text: "draft" });
    state = reducePromptEditor(state, { type: "history-add", text: "one" });
    state = reducePromptEditor(state, { type: "history-add", text: "two" });
    state = reducePromptEditor(state, { type: "history-up" });
    expect(state.text).toBe("two");
    state = reducePromptEditor(state, { type: "history-down" });
    expect(state.text).toBe("draft");
    expect(state.historyIndex).toBeNull();
  });

  it("accepts and cancels completion without coupling to Ink or pi-tui", () => {
    let state = createPromptEditorState({ text: "/he" });
    state = reducePromptEditor(state, {
      type: "completion-set",
      items: ["/help", "/health"],
    });
    state = reducePromptEditor(state, { type: "completion-next" });
    expect(state.completion?.selected).toBe(1);
    state = reducePromptEditor(state, { type: "completion-accept" });
    expect(state.text).toBe("/health ");
    expect(state.completion).toBeNull();
  });
});

describe("routePromptEditorInput", () => {
  it("routes normal editing and semantic shortcuts separately", () => {
    const state = createPromptEditorState();
    expect(routePromptEditorInput(state, "a")).toEqual({
      type: "action",
      action: { type: "insert", text: "a" },
    });
    expect(routePromptEditorInput(state, "\u0003")).toEqual({
      type: "semantic",
      action: "ctrl-c",
    });
    expect(routePromptEditorInput(state, "\r")).toEqual({
      type: "submit",
      text: "",
      inputMode: "prompt",
    });
  });

  it("keeps bash marker out of the buffer and handles empty bash exit", () => {
    const prompt = createPromptEditorState();
    expect(routePromptEditorInput(prompt, "!x")).toEqual({
      type: "action",
      action: { type: "insert", text: "x" },
    });
    const bash = createPromptEditorState({ inputMode: "bash" });
    expect(routePromptEditorInput(bash, "\u007f")).toEqual({
      type: "action",
      action: { type: "set-mode", inputMode: "prompt" },
    });
  });

  it("routes vertical movement, newline, and image paste without pi input", () => {
    const state = createPromptEditorState({ text: "ab\ncd", cursor: 4 });
    expect(routePromptEditorInput(state, "\u001b[A")).toEqual({
      type: "action",
      action: { type: "move-up" },
    });
    expect(routePromptEditorInput(state, "\n")).toEqual({
      type: "action",
      action: { type: "newline" },
    });
    expect(routePromptEditorInput(state, "\u0016")).toEqual({
      type: "semantic",
      action: "paste-image",
    });
  });
});

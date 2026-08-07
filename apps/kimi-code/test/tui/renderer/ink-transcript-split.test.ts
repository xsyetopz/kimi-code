import { describe, expect, it } from "vitest";

import { createTerminalViewState } from "#/tui/renderer/terminal-view-state";
import { splitInkTranscript } from "#/tui/renderer/ink/transcript-split";
import type { AppState, LivePaneState } from "#/tui/types";

const baseAppState = {
  model: "k2",
  workDir: "/workspace",
  additionalDirs: [],
  sessionId: "ses_1",
  permissionMode: "manual",
  planMode: false,
  inputMode: "prompt",
  swarmMode: false,
  thinkingEffort: "off",
  contextUsage: 0,
  contextTokens: 0,
  maxContextTokens: 100_000,
  isCompacting: false,
  isReplaying: false,
  streamingPhase: "idle",
  streamingStartTime: 0,
  theme: "dark",
  version: "1.0.0",
  editorCommand: null,
  notifications: {},
  upgrade: {},
  availableModels: {},
  availableProviders: {},
  sessionTitle: null,
  goal: null,
  mcpServersSummary: null,
} as unknown as AppState;

const livePane: LivePaneState = {
  mode: "idle",
  pendingApproval: null,
  pendingQuestion: null,
};

function makeView(
  transcriptEntries: ReturnType<typeof createTerminalViewState>["transcript"],
  appState: Partial<AppState> = {},
) {
  return createTerminalViewState({
    appState: { ...baseAppState, ...appState } as AppState,
    startupState: "ready",
    transcriptEntries,
    livePane,
    queuedMessages: [],
    activeDialog: null,
    toolOutputExpanded: false,
    externalEditorRunning: false,
    queuedMessageDispatchPending: false,
    swarmModeEntry: undefined,
    deferUserMessages: false,
    activityTip: undefined,
  });
}

describe("splitInkTranscript", () => {
  it("freezes the full transcript while idle", () => {
    const entries = [
      {
        id: "u1",
        kind: "user" as const,
        renderMode: "plain" as const,
        content: "hi",
      },
      {
        id: "a1",
        kind: "assistant" as const,
        renderMode: "markdown" as const,
        content: "hello",
      },
    ];
    const split = splitInkTranscript(makeView(entries));
    expect(split.staticEntries.map((entry) => entry.id)).toEqual(["u1", "a1"]);
    expect(split.liveEntries).toEqual([]);
  });

  it("keeps the current turn tail live while composing", () => {
    const entries = [
      {
        id: "u1",
        kind: "user" as const,
        renderMode: "plain" as const,
        content: "first",
      },
      {
        id: "a1",
        kind: "assistant" as const,
        renderMode: "markdown" as const,
        content: "done",
      },
      {
        id: "u2",
        kind: "user" as const,
        renderMode: "plain" as const,
        content: "second",
      },
      {
        id: "a2",
        kind: "assistant" as const,
        renderMode: "markdown" as const,
        content: "...",
      },
    ];
    const split = splitInkTranscript(
      makeView(entries, { streamingPhase: "composing" }),
    );
    expect(split.staticEntries.map((entry) => entry.id)).toEqual([
      "u1",
      "a1",
      "u2",
    ]);
    expect(split.liveEntries.map((entry) => entry.id)).toEqual(["a2"]);
  });

  it("keeps the whole transcript dynamic when tool output is expanded", () => {
    const entries = [
      {
        id: "u1",
        kind: "user" as const,
        renderMode: "plain" as const,
        content: "hi",
      },
    ];
    const view = makeView(entries);
    const split = splitInkTranscript({ ...view, toolOutputExpanded: true });
    expect(split.staticEntries).toEqual([]);
    expect(split.liveEntries.map((entry) => entry.id)).toEqual(["u1"]);
  });
});

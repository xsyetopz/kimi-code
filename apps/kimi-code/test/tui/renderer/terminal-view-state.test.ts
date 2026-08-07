import { describe, expect, it } from "vitest";

import {
  createTerminalViewState,
  resolveTerminalActivityMode,
  resolveTerminalModelLabel,
  type TerminalViewSource,
  type TerminalEditorView,
} from "#/tui/renderer/terminal-view-state";
import type { AppState, LivePaneState, QueuedMessage } from "#/tui/types";

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
  notifications: {} as AppState["notifications"],
  upgrade: {} as AppState["upgrade"],
  availableModels: {},
  availableProviders: {},
  sessionTitle: null,
  goal: null,
  mcpServersSummary: null,
} as unknown as AppState;

const idleLivePane: LivePaneState = {
  mode: "idle",
  pendingApproval: null,
  pendingQuestion: null,
};

function source(
  overrides: {
    readonly appState?: Partial<AppState>;
    readonly activeDialog?: TerminalViewSource["activeDialog"];
    readonly livePane?: LivePaneState;
    readonly queuedMessages?: readonly QueuedMessage[];
    readonly editor?: Omit<TerminalEditorView, "autocomplete">;
    readonly deferUserMessages?: boolean;
    readonly activityTip?: string;
  } = {},
): TerminalViewSource {
  return {
    appState: {
      ...baseAppState,
      ...overrides.appState,
    } as AppState,
    startupState: "ready",
    transcriptEntries: [],
    livePane: overrides.livePane ?? idleLivePane,
    queuedMessages: overrides.queuedMessages ?? [],
    editor: overrides.editor,
    activeDialog: overrides.activeDialog ?? null,
    toolOutputExpanded: false,
    externalEditorRunning: false,
    queuedMessageDispatchPending: false,
    swarmModeEntry: undefined,
    deferUserMessages: overrides.deferUserMessages ?? false,
    activityTip: overrides.activityTip,
  };
}

describe("resolveTerminalActivityMode", () => {
  it.each([
    ["session picker", { activeDialog: "session-picker" }, "hidden"],
    [
      "pending approval",
      {
        livePane: {
          ...idleLivePane,
          pendingApproval: { data: {} as never },
        },
      },
      "hidden",
    ],
    ["compaction", { appState: { isCompacting: true } }, "hidden"],
    [
      "pending question",
      {
        livePane: {
          ...idleLivePane,
          pendingQuestion: { data: {} as never },
        },
      },
      "hidden",
    ],
    ["shell streaming", { appState: { streamingPhase: "shell" } }, "waiting"],
    [
      "thinking while idle",
      { appState: { streamingPhase: "thinking" } },
      "thinking",
    ],
    [
      "composing while idle",
      { appState: { streamingPhase: "composing" } },
      "composing",
    ],
    ["active tool", { livePane: { ...idleLivePane, mode: "tool" } }, "tool"],
  ] as const)("maps %s to %s", (_label, overrides, expected) => {
    expect(resolveTerminalActivityMode(source(overrides))).toBe(expected);
  });
});

describe("createTerminalViewState", () => {
  it("projects state without exposing mutable coordinator arrays", () => {
    const queuedMessages: readonly QueuedMessage[] = [
      { text: "queued prompt", mode: "prompt" },
    ];
    const sourceState = source({
      appState: {
        additionalDirs: ["/shared"],
        contextUsage: 0.42,
        contextTokens: 42_000,
        streamingPhase: "waiting",
      },
      livePane: { ...idleLivePane, mode: "waiting" },
      queuedMessages,
      deferUserMessages: true,
      activityTip: "Working…",
      editor: {
        text: "/model",
        cursorLine: 0,
        cursorColumn: 6,
        inputMode: "prompt",
        autocomplete: [],
      },
    });
    const view = createTerminalViewState(sourceState);

    expect(view.app.additionalDirs).toEqual(["/shared"]);
    expect(view.app.additionalDirs).not.toBe(
      sourceState.appState.additionalDirs,
    );
    expect(view.queue).toMatchObject({
      messages: queuedMessages,
      isStreaming: true,
      isCompacting: false,
      canSteerImmediately: false,
    });
    expect(view.queue.messages).not.toBe(sourceState.queuedMessages);
    expect(view.activity).toEqual({ mode: "waiting", tip: "Working…" });
    expect(view.editor).toEqual({
      text: "/model",
      cursorLine: 0,
      cursorColumn: 6,
      inputMode: "prompt",
      autocomplete: [],
    });
    expect(view.transcript).not.toBe(sourceState.transcriptEntries);
  });

  it("projects renderer-owned slash autocomplete without exposing the editor", () => {
    const view = createTerminalViewState({
      ...source({
        editor: {
          text: "/lo",
          cursorLine: 0,
          cursorColumn: 3,
          inputMode: "prompt",
        },
      }),
      helpCommands: [
        { name: "login", aliases: ["auth"], description: "Sign in" },
        { name: "model", aliases: [], description: "Choose a model" },
      ],
    });
    expect(view.editor.autocomplete).toEqual(["/login — Sign in"]);
  });

  it("resolves env overlay model aliases to catalog labels", () => {
    const label = resolveTerminalModelLabel({
      ...baseAppState,
      model: "__kimi_env_model__",
      availableModels: {
        __kimi_env_model__: {
          provider: "__kimi_env__",
          model: "syn:large:text",
          displayName: "Synthetic Large",
          maxContextSize: 262_144,
          capabilities: ["thinking"],
        },
      },
    } as AppState);
    expect(label).toBe("Synthetic Large");
  });
});

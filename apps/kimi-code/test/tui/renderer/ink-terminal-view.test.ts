import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

const inkRender = vi.hoisted(() => vi.fn());

vi.mock("ink", async () => {
  const actual = await vi.importActual<typeof import("ink")>("ink");
  return { ...actual, render: inkRender };
});

import { renderToString } from "ink";
import { visibleWidth } from "@moonshot-ai/kimi-tui";

import {
  InkDialogView,
  projectInkHelpLines,
} from "#/tui/renderer/ink/terminal-dialog";
import {
  InkTerminalView,
  encodeInkInput,
  projectInkChrome,
  projectInkEditor,
  projectInkActivity,
  projectInkQueue,
  projectInkTranscript,
} from "#/tui/renderer/ink/terminal-view";
import type { InkTerminalRenderer } from "#/tui/renderer/ink/terminal-renderer";
import { mountInkTerminalRenderer as mountRenderer } from "#/tui/renderer/ink/terminal-renderer";
import {
  createTerminalViewState,
  type TerminalViewState,
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
  streamingPhase: "thinking",
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

const livePane: LivePaneState = {
  mode: "idle",
  pendingApproval: null,
  pendingQuestion: null,
};

function view(
  overrides: {
    readonly appState?: Partial<AppState>;
    readonly transcriptEntries?: TerminalViewState["transcript"];
    readonly queuedMessages?: readonly QueuedMessage[];
    readonly deferUserMessages?: boolean;
    readonly activityTip?: string;
  } = {},
): TerminalViewState {
  return createTerminalViewState({
    appState: { ...baseAppState, ...overrides.appState } as AppState,
    startupState: "ready",
    transcriptEntries: overrides.transcriptEntries ?? [
      {
        id: "user-1",
        kind: "user",
        renderMode: "plain",
        content: "hello",
      },
      {
        id: "assistant-1",
        kind: "assistant",
        renderMode: "markdown",
        content: "world",
      },
    ],
    livePane,
    queuedMessages: overrides.queuedMessages ?? [],
    activeDialog: null,
    toolOutputExpanded: false,
    externalEditorRunning: false,
    queuedMessageDispatchPending: false,
    swarmModeEntry: undefined,
    deferUserMessages: overrides.deferUserMessages ?? false,
    activityTip: overrides.activityTip,
  });
}

describe("InkTerminalView", () => {
  it("projects footer chrome without coupling to kimi-tui", () => {
    const terminalView = view({
      appState: {
        model: "__kimi_env_model__",
        availableModels: {
          __kimi_env_model__: {
            provider: "__kimi_env__",
            model: "syn:large:text",
            maxContextSize: 262_144,
            capabilities: ["thinking"],
          },
        },
        planMode: true,
        thinkingEffort: "high",
        contextUsage: 0.42,
      },
    });
    const chrome = projectInkChrome(terminalView);
    expect(chrome.footer).toContain("syn:large:text");
    expect(chrome.footer).not.toContain("__kimi_env_model__");
    expect(chrome.footer).toContain("42%");
  });

  it("renders the active editor mode and cursor in the Ink tree", () => {
    const terminalView = view({
      appState: { inputMode: "bash" },
    });
    const withEditor = {
      ...terminalView,
      editor: {
        text: "echo hi",
        cursorLine: 0,
        cursorColumn: 5,
        inputMode: "bash" as const,
        autocomplete: [],
      },
    };

    expect(projectInkEditor(withEditor.editor)).toEqual({
      prompt: "!",
      text: "echo hi",
      cursorLine: 0,
      cursorColumn: 5,
      autocomplete: [],
    });
    expect(
      renderToString(createElement(InkTerminalView, { view: withEditor })),
    ).toContain("! echo ▌hi");
  });

  it("renders a selectable completion pointer for the active editor buffer", () => {
    const terminalView = view();
    const withAutocomplete = {
      ...terminalView,
      editor: {
        ...terminalView.editor,
        text: "/lo",
        autocomplete: ["/login — Sign in", "/logout — Sign out"],
      },
    };
    expect(
      renderToString(
        createElement(InkTerminalView, { view: withAutocomplete }),
      ),
    ).toContain("❯ /login — Sign in");
  });

  it("maps Ink key metadata back to kimi-tui input sequences", () => {
    const key = (overrides: Record<string, boolean> = {}) =>
      ({
        upArrow: false,
        downArrow: false,
        leftArrow: false,
        rightArrow: false,
        pageDown: false,
        pageUp: false,
        home: false,
        end: false,
        return: false,
        escape: false,
        ctrl: false,
        shift: false,
        tab: false,
        backspace: false,
        delete: false,
        meta: false,
        super: false,
        hyper: false,
        capsLock: false,
        numLock: false,
        ...overrides,
      }) as Parameters<typeof encodeInkInput>[1];

    expect(encodeInkInput("", key({ upArrow: true }))).toBe("\u001b[A");
    expect(encodeInkInput("", key({ return: true }))).toBe("\r");
    expect(encodeInkInput("c", key({ ctrl: true }))).toBe("\u0003");
    expect(encodeInkInput("x", key({ meta: true }))).toBe("\u001bx");
    expect(encodeInkInput("hello", key())).toBe("hello");
  });

  it("renders transcript, activity, and queue projections in order", () => {
    const terminalView = view({
      activityTip: "keep going",
      queuedMessages: [
        { text: "  next\nstep ", mode: "prompt" },
        { text: "ls -la", mode: "bash" },
      ],
    });
    const output = renderToString(
      createElement(InkTerminalView, { view: terminalView }),
    );

    expect(output.indexOf("hello")).toBeGreaterThanOrEqual(0);
    expect(output.indexOf("world")).toBeGreaterThan(output.indexOf("hello"));
    expect(output).toContain("Thinking · Tip: keep going");
    expect(output).toContain("❯ next step");
    expect(output).toContain("❯ $ ls -la");
    expect(output).toContain("↑ to edit · ctrl-s to steer immediately");
  });

  it("keeps Ink projections aligned with the renderer-neutral view", () => {
    const terminalView = view({
      queuedMessages: [{ text: "queued", mode: "prompt" }],
    });

    expect(projectInkTranscript(terminalView)).toEqual(terminalView.transcript);
    expect(projectInkActivity(terminalView.activity)).toBe("Thinking");
    expect(projectInkActivity({ mode: "hidden", tip: "ignored" })).toBe(
      undefined,
    );
    expect(projectInkActivity({ mode: "waiting", tip: "working" })).toBe(
      "Waiting · Tip: working",
    );
    expect(projectInkActivity({ mode: "tool", tip: undefined })).toBe("Tool");
    expect(projectInkQueue(terminalView.queue)).toEqual({
      messages: ["  ❯ queued"],
      hint: "  ↑ to edit · ctrl-s to steer immediately",
    });
    expect(
      projectInkQueue({
        messages: [{ text: "ls", mode: "bash" }],
        isCompacting: true,
        isStreaming: false,
        canSteerImmediately: true,
      }),
    ).toEqual({
      messages: ["  ❯ $ ls"],
      hint: "  ↑ to edit · will send after compaction",
    });
  });

  it("renders the migrated dialog payload instead of only its title", () => {
    const terminalView = view();
    const approval = {
      data: {
        id: "approval-1",
        tool_call_id: "tool-1",
        tool_name: "Bash",
        action: "Run this command?",
        description: "List the workspace files",
        display: [
          {
            type: "shell",
            language: "bash",
            command: "ls -la",
            cwd: "/workspace",
          },
        ],
        choices: [
          { label: "Allow once", response: "approved" as const },
          { label: "Reject", response: "rejected" as const },
        ],
      },
    };
    const output = renderToString(
      createElement(InkTerminalView, {
        view: {
          ...terminalView,
          dialog: {
            ...terminalView.dialog,
            pendingApproval: approval,
          },
        },
      }),
    );
    expect(output).toContain("Run this command?");
    expect(output).toContain("ls -la · /workspace");
    expect(output).toContain("❯ Allow once");
    expect(output).toContain("2 Reject");
    const rejectOutput = renderToString(
      createElement(InkDialogView, {
        view: {
          ...terminalView,
          dialog: {
            ...terminalView.dialog,
            pendingApproval: approval,
            selectedIndex: 1,
          },
        },
      }),
    );
    expect(rejectOutput).toContain("❯ Reject");
  });

  it("projects session, trust, and help chrome from the same snapshot", () => {
    const terminalView = view();
    const sessionOutput = renderToString(
      createElement(InkTerminalView, {
        view: {
          ...terminalView,
          dialog: {
            ...terminalView.dialog,
            active: "session-picker",
            sessions: [
              {
                id: "ses-2",
                title: "Deploy",
                lastPrompt: null,
                workDir: "/workspace",
                updatedAt: 1,
              },
            ],
          },
        },
      }),
    );
    expect(sessionOutput).toContain("Deploy · /workspace");

    const trustOutput = renderToString(
      createElement(InkTerminalView, {
        view: {
          ...terminalView,
          dialog: {
            ...terminalView.dialog,
            active: "trust-prompt",
            trustPrompt: {
              workDir: "/workspace",
              gatedMcpServers: ["local-tools"],
            },
          },
        },
      }),
    );
    expect(trustOutput).toContain("Gated servers: local-tools");

    const helpOutput = renderToString(
      createElement(InkTerminalView, {
        view: {
          ...terminalView,
          dialog: {
            ...terminalView.dialog,
            active: "help",
            helpCommands: [
              { name: "login", aliases: ["auth"], description: "Sign in" },
            ],
          },
        },
      }),
    );
    expect(helpOutput).toContain("/login (/auth) — Sign in");
  });

  it("keeps Ink help rows within a narrow terminal and exposes the scroll tail", () => {
    const terminalView = view();
    const helpView = {
      ...terminalView,
      dialog: {
        ...terminalView.dialog,
        active: "help" as const,
        scrollTop: 3,
        helpCommands: Array.from({ length: 20 }, (_, index) => ({
          name: `command-${String(index)}`,
          aliases: [],
          description: "A deliberately long description that must be clipped",
        })),
      },
    };
    const lines = projectInkHelpLines(helpView.dialog, 28, 6);
    expect(lines.join("\n")).toContain("showing 4-9 of");
    expect(lines.every((line) => visibleWidth(line) <= 28)).toBe(true);
  });
});

describe("mountInkTerminalRenderer", () => {
  it("owns the Ink render lifecycle and forwards snapshots", async () => {
    const rerender = vi.fn();
    const unmount = vi.fn();
    const waitUntilExit = vi.fn(() => Promise.resolve("done"));
    inkRender.mockReturnValue({ rerender, unmount, waitUntilExit });

    const initial = view();
    const next = view({
      appState: { streamingPhase: "composing" },
      activityTip: "drafting",
    });
    const onInput = vi.fn();
    const renderer: InkTerminalRenderer = mountRenderer(initial, { onInput });

    expect(inkRender).toHaveBeenCalledTimes(1);
    expect(inkRender.mock.calls[0]?.[0]).toMatchObject({
      type: InkTerminalView,
      props: { view: initial, onInput },
    });
    expect(inkRender.mock.calls[0]?.[1]).toMatchObject({
      exitOnCtrlC: false,
    });

    renderer.update(next);
    expect(rerender).toHaveBeenCalledTimes(1);
    expect(rerender.mock.calls[0]?.[0]).toMatchObject({
      type: InkTerminalView,
      props: { view: next },
    });

    renderer.unmount();
    renderer.unmount();
    renderer.update(initial);
    expect(unmount).toHaveBeenCalledTimes(1);
    expect(rerender).toHaveBeenCalledTimes(1);
    await expect(renderer.waitUntilExit()).resolves.toBe("done");
  });
});

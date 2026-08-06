import { describe, expect, it, vi } from "vitest";

import { KimiTUI, type KimiTUIStartupInput } from "#/tui/kimi-tui";

type InkDialogDriver = {
  state: KimiTUI["state"];
  handleInkSimpleDialogInput(data: string): boolean;
  showHelpPanel(): void;
  getTerminalViewState(): ReturnType<KimiTUI["getTerminalViewState"]>;
  inkDialogSelection: number;
  inkDialogScrollTop: number;
  inkApprovalFeedbackMode: boolean;
  inkApprovalFeedbackText: string;
  inkApprovalPreviewBlock: { type: string; path: string; content: string } | null;
  inkApprovalPreviewScrollTop: number;
  handleInkInput(data: string): void;
  inkSessionPickerSelect?: (session: { id: string }) => void;
  trustPromptChoiceResolver?: (choice: "trust" | "distrust") => void;
  approvalController: { respond: (response: unknown) => void };
  questionController: { respond: (response: unknown) => void };
};

function makeTui() {
  const input: KimiTUIStartupInput = {
    cliOptions: {
      session: undefined,
      continue: false,
      yolo: false,
      auto: false,
      plan: false,
      model: undefined,
      outputFormat: undefined,
      prompt: undefined,
      skillsDirs: [],
      agent: undefined,
      agentFiles: [],
    },
    tuiConfig: {
      theme: "dark",
      disablePasteBurst: false,
      editorCommand: null,
      notifications: { enabled: true, condition: "unfocused" },
      upgrade: { autoInstall: true },
      statusLine: { items: null, command: null },
    },
    version: "test",
    workDir: "/tmp/kimi-test",
    terminalRenderer: "ink",
  };
  return new KimiTUI(
    { track: vi.fn() } as never,
    input,
  ) as unknown as InkDialogDriver;
}

describe("Ink-owned simple dialog input", () => {
  it("moves trust selection and invokes the existing trust callback", () => {
    const tui = makeTui();
    tui.state.activeDialog = "trust-prompt";
    const select = vi.fn();
    tui.trustPromptChoiceResolver = select;

    expect(tui.handleInkSimpleDialogInput("\u001b[B")).toBe(true);
    expect(tui.inkDialogSelection).toBe(1);
    expect(tui.handleInkSimpleDialogInput("\r")).toBe(true);
    expect(select).toHaveBeenCalledWith("distrust");
  });

  it("moves session selection and invokes the existing session callback", () => {
    const tui = makeTui();
    tui.state.activeDialog = "session-picker";
    tui.state.sessions = [
      {
        id: "ses-1",
        title: "First",
        last_prompt: null,
        work_dir: "/tmp/kimi-test",
        updated_at: 1,
      },
      {
        id: "ses-2",
        title: "Second",
        last_prompt: null,
        work_dir: "/tmp/kimi-test",
        updated_at: 2,
      },
    ];
    const select = vi.fn();
    tui.inkSessionPickerSelect = select;

    expect(tui.handleInkSimpleDialogInput("\u001b[B")).toBe(true);
    expect(tui.inkDialogSelection).toBe(1);
    expect(tui.handleInkSimpleDialogInput("\r")).toBe(true);
    expect(select).toHaveBeenCalledWith(tui.state.sessions[1]);
  });

  it("routes help to Ink without mounting the legacy kimi-tui panel", () => {
    const tui = makeTui();
    const mountEditorReplacement = vi.spyOn(
      tui as unknown as { mountEditorReplacement: () => void },
      "mountEditorReplacement",
    );

    tui.showHelpPanel();

    expect(tui.state.activeDialog).toBe("help");
    expect(mountEditorReplacement).not.toHaveBeenCalled();
  });

  it("routes session picker to Ink without mounting the legacy kimi-tui panel", () => {
    const tui = makeTui();
    const mountEditorReplacement = vi.spyOn(
      tui as unknown as { mountEditorReplacement: () => void },
      "mountEditorReplacement",
    );
    tui.state.sessions = [
      {
        id: "ses-1",
        title: "First",
        last_prompt: null,
        work_dir: "/tmp/kimi-test",
        updated_at: 1,
      },
    ];

    (
      tui as unknown as {
        mountSessionPicker: (options: {
          onCancel: () => void;
        }) => void;
      }
    ).mountSessionPicker({ onCancel: () => {} });

    expect(tui.state.activeDialog).toBe("session-picker");
    expect(mountEditorReplacement).not.toHaveBeenCalled();
  });

  it("closes help with printable and functional keys, including Kitty q", () => {
    const tui = makeTui();
    tui.showHelpPanel();

    expect(tui.handleInkSimpleDialogInput("\u001b[113u")).toBe(true);
    expect(tui.state.activeDialog).toBeNull();

    tui.showHelpPanel();
    expect(tui.handleInkSimpleDialogInput("\r")).toBe(true);
    expect(tui.state.activeDialog).toBeNull();

    tui.showHelpPanel();
    expect(tui.handleInkSimpleDialogInput("\u001b")).toBe(true);
    expect(tui.state.activeDialog).toBeNull();
  });

  it("scrolls the Ink help snapshot one row and one page at a time", () => {
    const tui = makeTui();
    tui.showHelpPanel();

    expect(tui.handleInkSimpleDialogInput("\u001b[B")).toBe(true);
    expect(tui.inkDialogScrollTop).toBe(1);
    expect(tui.handleInkSimpleDialogInput("\u001b[6~")).toBe(true);
    expect(tui.inkDialogScrollTop).toBe(11);
    expect(tui.handleInkSimpleDialogInput("\u001b[5~")).toBe(true);
    expect(tui.inkDialogScrollTop).toBe(1);
    expect(tui.handleInkSimpleDialogInput("\u001b[A")).toBe(true);
    expect(tui.inkDialogScrollTop).toBe(0);
    expect(tui.getTerminalViewState().dialog.scrollTop).toBe(0);
  });

  it("routes approval to Ink without mounting the legacy kimi-tui panel", () => {
    const tui = makeTui();
    const mountEditorReplacement = vi.spyOn(
      tui as unknown as { mountEditorReplacement: () => void },
      "mountEditorReplacement",
    );

    (
      tui as unknown as {
        showApprovalPanel: (payload: {
          id: string;
          tool_call_id: string;
          tool_name: string;
          action: string;
          description: string;
          display: readonly [];
          choices: readonly [{ label: string; response: "approved" }];
        }) => void;
      }
    ).showApprovalPanel({
      id: "approval-1",
      tool_call_id: "tool-1",
      tool_name: "Bash",
      action: "Run?",
      description: "",
      display: [],
      choices: [{ label: "Allow", response: "approved" }],
    });

    expect(tui.state.livePane.pendingApproval).not.toBeNull();
    expect(mountEditorReplacement).not.toHaveBeenCalled();
  });

  it("submits the selected Ink approval choice through the approval controller", () => {
    const tui = makeTui();
    const respond = vi.spyOn(tui.approvalController, "respond");
    tui.state.livePane.pendingApproval = {
      data: {
        id: "approval-1",
        tool_call_id: "tool-1",
        tool_name: "Bash",
        action: "Run?",
        description: "",
        display: [],
        choices: [
          { label: "Allow once", response: "approved" },
          { label: "Reject", response: "rejected" },
        ],
      },
    };

    expect(tui.handleInkSimpleDialogInput("\u001b[B")).toBe(true);
    expect(tui.inkDialogSelection).toBe(1);
    expect(tui.handleInkSimpleDialogInput("\r")).toBe(true);
    expect(respond).toHaveBeenCalledWith({
      decision: "rejected",
      feedback: undefined,
      selectedLabel: undefined,
    });
  });

  it("collects inline feedback before submitting a requires_feedback approval", () => {
    const tui = makeTui();
    const respond = vi.spyOn(tui.approvalController, "respond");
    tui.state.livePane.pendingApproval = {
      data: {
        id: "approval-1",
        tool_call_id: "tool-1",
        tool_name: "Bash",
        action: "Run?",
        description: "",
        display: [],
        choices: [
          {
            label: "Allow with note",
            response: "approved",
            requires_feedback: true,
          },
        ],
      },
    };

    expect(tui.handleInkSimpleDialogInput("\r")).toBe(true);
    expect(tui.inkApprovalFeedbackMode).toBe(true);
    expect(tui.handleInkSimpleDialogInput("n")).toBe(true);
    expect(tui.handleInkSimpleDialogInput("o")).toBe(true);
    expect(tui.getTerminalViewState().dialog.approvalFeedbackText).toBe("no");
    expect(tui.handleInkSimpleDialogInput("\r")).toBe(true);
    expect(respond).toHaveBeenCalledWith({
      decision: "approved",
      feedback: "no",
      selectedLabel: undefined,
    });
  });

  it("routes a single simple question to Ink without mounting legacy panel", () => {
    const tui = makeTui();
    const mountEditorReplacement = vi.spyOn(
      tui as unknown as { mountEditorReplacement: () => void },
      "mountEditorReplacement",
    );

    (
      tui as unknown as {
        showQuestionDialog: (payload: {
          id: string;
          tool_call_id: string;
          questions: readonly [
            {
              question: string;
              multi_select: boolean;
              options: readonly [{ label: string }];
            },
          ];
        }) => void;
      }
    ).showQuestionDialog({
      id: "question-1",
      tool_call_id: "tool-1",
      questions: [
        {
          question: "Pick one",
          multi_select: false,
          options: [{ label: "Yes" }],
        },
      ],
    });

    expect(tui.state.livePane.pendingQuestion).not.toBeNull();
    expect(mountEditorReplacement).not.toHaveBeenCalled();
  });

  it("submits a single-select Ink question through the question controller", () => {
    const tui = makeTui();
    const respond = vi.spyOn(tui.questionController, "respond");
    tui.state.livePane.pendingQuestion = {
      data: {
        id: "question-1",
        tool_call_id: "tool-1",
        questions: [
          {
            question: "Pick one",
            multi_select: false,
            options: [
              { label: "First" },
              { label: "Second" },
            ],
          },
        ],
      },
    };

    expect(tui.handleInkSimpleDialogInput("\u001b[B")).toBe(true);
    expect(tui.handleInkSimpleDialogInput("\r")).toBe(true);
    expect(respond).toHaveBeenCalledWith({
      answers: ["Second"],
      method: "enter",
    });
  });

  it("opens and scrolls an Ink approval preview with ctrl+e", () => {
    const tui = makeTui();
    tui.state.livePane.pendingApproval = {
      data: {
        id: "approval-1",
        tool_call_id: "tool-1",
        tool_name: "Write",
        action: "Write file?",
        description: "",
        display: [
          {
            type: "file_content",
            path: "src/example.ts",
            content: Array.from({ length: 40 }, (_, i) => `line-${String(i + 1)}`).join(
              "\n",
            ),
          },
        ],
        choices: [{ label: "Allow", response: "approved" }],
      },
    };

    expect(tui.handleInkInput("\u0005")).toBeUndefined();
    expect(tui.inkApprovalPreviewBlock).not.toBeNull();
    expect(tui.getTerminalViewState().approvalPreview).not.toBeNull();

    tui.handleInkInput("\u001b[B");
    expect(tui.inkApprovalPreviewScrollTop).toBe(1);

    tui.handleInkInput("\u001b");
    expect(tui.inkApprovalPreviewBlock).toBeNull();
  });
});

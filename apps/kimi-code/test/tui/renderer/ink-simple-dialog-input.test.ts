import { describe, expect, it, vi } from "vitest";

import { KimiTUI, type KimiTUIStartupInput } from "#/tui/kimi-tui";

type InkDialogDriver = {
  state: KimiTUI["state"];
  handleInkSimpleDialogInput(data: string): boolean;
  showHelpPanel(): void;
  getTerminalViewState(): ReturnType<KimiTUI["getTerminalViewState"]>;
  inkDialogSelection: number;
  inkDialogScrollTop: number;
  inkSessionPickerSelect?: (session: { id: string }) => void;
  trustPromptChoiceResolver?: (choice: "trust" | "distrust") => void;
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

  it("routes help to Ink without mounting the legacy pi-tui panel", () => {
    const tui = makeTui();
    const mountEditorReplacement = vi.spyOn(
      tui as unknown as { mountEditorReplacement: () => void },
      "mountEditorReplacement",
    );

    tui.showHelpPanel();

    expect(tui.state.activeDialog).toBe("help");
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
});

import { describe, expect, it, vi } from "vitest";

import { ApiKeyInputDialogComponent } from "#/tui/components/dialogs/api-key-input-dialog";
import { CustomRegistryImportDialogComponent } from "#/tui/components/dialogs/custom-registry-import";
import { FeedbackInputDialogComponent } from "#/tui/components/dialogs/feedback-input-dialog";
import { KimiTUI, type KimiTUIStartupInput } from "#/tui/kimi-tui";
import { createInkApiKeyInputSession } from "#/tui/renderer/ink/sessions/api-key-input";
import { createInkCustomRegistryImportSession } from "#/tui/renderer/ink/sessions/custom-registry-import";
import { createInkFeedbackInputSession } from "#/tui/renderer/ink/sessions/feedback-input";

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
  };
  return new KimiTUI({ track: vi.fn() } as never, input);
}

describe("ink input dialogs", () => {
  it("submits feedback text with Enter", () => {
    const onDone = vi.fn();
    const session = createInkFeedbackInputSession({ onDone });

    for (const ch of "hello") {
      expect(session.handleInput(ch)).toBe(true);
    }
    expect(session.handleInput("\r")).toBe(true);
    expect(onDone).toHaveBeenCalledWith({ kind: "ok", value: "hello" });
  });

  it("masks api key input in the projected view", () => {
    const onDone = vi.fn();
    const session = createInkApiKeyInputSession({
      platformName: "Example",
      subtitleLines: ["Paste your API key below."],
      onDone,
    });

    session.handleInput("s");
    session.handleInput("e");
    session.handleInput("c");
    session.handleInput("r");
    session.handleInput("e");
    session.handleInput("t");
    const view = session.projectView();
    expect(view.inputLine).toContain("•");
    expect(view.inputLine).not.toContain("secret");
  });

  it("advances custom registry fields before submit", () => {
    const onDone = vi.fn();
    const session = createInkCustomRegistryImportSession({ onDone });

    for (const ch of "https://example.test/api.json") {
      session.handleInput(ch);
    }
    expect(session.handleInput("\t")).toBe(true);
    for (const ch of "token") {
      session.handleInput(ch);
    }
    expect(session.handleInput("\r")).toBe(true);
    expect(onDone).toHaveBeenCalledWith({
      kind: "ok",
      value: { url: "https://example.test/api.json", apiKey: "token" },
    });
  });

  it("routes input dialog mounts to Ink without legacy panels", () => {
    const tui = makeTui();

    tui.mountEditorReplacement(new FeedbackInputDialogComponent(vi.fn()));
    expect(tui.state.activeDialog).toBe("feedback-input");

    tui.restoreEditor();

    tui.mountEditorReplacement(
      new ApiKeyInputDialogComponent("Example", ["hint"], vi.fn()),
    );
    expect(tui.state.activeDialog).toBe("api-key-input");

    tui.restoreEditor();

    tui.mountEditorReplacement(
      new CustomRegistryImportDialogComponent(vi.fn()),
    );
    expect(tui.state.activeDialog).toBe("custom-registry-import");
  });
});

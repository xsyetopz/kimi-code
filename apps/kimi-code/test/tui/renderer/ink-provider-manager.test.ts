import type { ProviderConfig } from "@moonshot-ai/kimi-code-sdk";
import { describe, expect, it, vi } from "vitest";

import {
  ProviderManagerComponent,
  type ProviderManagerOptions,
} from "#/tui/components/dialogs/provider-manager";
import { KimiTUI, type KimiTUIStartupInput } from "#/tui/kimi-tui";
import {
  createInkProviderManagerSession,
  projectInkProviderManagerView,
} from "#/tui/renderer/ink/sessions/provider-manager";

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
  return new KimiTUI({ track: vi.fn() } as never, input);
}

describe("ink provider manager", () => {
  it("arms delete confirmation and confirms with y", () => {
    const onDeleteSource = vi.fn();
    const onClose = vi.fn();
    const session = createInkProviderManagerSession({
      providers: {
        acme: { baseUrl: "https://acme.test" },
      } as unknown as Record<string, ProviderConfig>,
      activeProviderId: "acme",
      onAdd: vi.fn(),
      onDeleteSource,
      onClose,
    });

    expect(session.handleInput("d", { onAdd: vi.fn(), onDeleteSource, onClose }))
      .toBe(true);
    expect(projectInkProviderManagerView(session).confirmPrompt).toContain(
      "Delete platform",
    );
    expect(session.handleInput("y", { onAdd: vi.fn(), onDeleteSource, onClose }))
      .toBe(true);
    expect(onDeleteSource).toHaveBeenCalledWith(["acme"]);
  });

  it("routes ProviderManagerComponent mounts to Ink without legacy panel", () => {
    const tui = makeTui();
    const onClose = vi.fn();

    tui.mountEditorReplacement(
      new ProviderManagerComponent({
        providers: {} as Record<string, ProviderConfig>,
        onAdd: vi.fn(),
        onDeleteSource: vi.fn(),
        onClose,
      }),
    );

    expect(tui.state.activeDialog).toBe("provider-manager");
    expect(tui.getTerminalViewState().dialog.providerManager?.title).toBe(
      "Providers",
    );
    expect(
      (
        tui as unknown as { handleInkSimpleDialogInput: (data: string) => boolean }
      ).handleInkSimpleDialogInput("\u001B"),
    ).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
  });
});

import { execSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runShell } from "#/cli/run-shell";

import {
  captureProcessWrite,
  ExitCalled,
  mockProcessExit,
} from "../helpers/process";

const mocks = vi.hoisted(() => {
  type TuiConfigFallback = {
    theme: "dark" | "light" | "auto";
    editorCommand: string | null;
    notifications: { enabled: boolean; condition: "unfocused" | "always" };
  };

  class TuiConfigParseError extends Error {
    readonly fallback: TuiConfigFallback;

    constructor(fallback: TuiConfigFallback) {
      super("Invalid TUI config in ~/.kimi-code/tui.toml; using defaults.");
      this.fallback = fallback;
    }
  }

  return {
    loadTuiConfig: vi.fn(),
    detectTerminalTheme: vi.fn(),
    kimiHarnessV2Constructor: vi.fn(),
    harnessEnsureConfigFile: vi.fn(),
    harnessGetConfig: vi.fn(async () => ({
      providers: {},
      defaultModel: "k2",
      telemetry: true,
    })),
    harnessGetConfigDiagnostics: vi.fn(async () => ({
      warnings: [] as readonly string[],
    })),
    harnessClose: vi.fn(),
    kimiTuiConstructor: vi.fn(),
    tuiStart: vi.fn(),
    tuiGetCurrentSessionId: vi.fn(() => ""),
    tuiHasSessionContent: vi.fn(() => false),
    resolveKimiHome: vi.fn(
      (homeDir?: string) => homeDir ?? "/tmp/kimi-code-test-home",
    ),
    flushDiagnosticLogsSync: vi.fn(),
    execSync: vi.fn(),
    TuiConfigParseError,
  };
});

vi.mock("@moonshot-ai/kimi-code-sdk", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@moonshot-ai/kimi-code-sdk")>();
  const makeHarnessStub = (args: unknown[]) => {
    const options = args[0] as { readonly homeDir?: string } | undefined;
    const homeDir = options?.homeDir ?? "/tmp/kimi-code-test-home";
    return {
      homeDir,
      ensureConfigFile: mocks.harnessEnsureConfigFile,
      getConfig: mocks.harnessGetConfig,
      getConfigDiagnostics: mocks.harnessGetConfigDiagnostics,
      close: mocks.harnessClose,
    };
  };
  return {
    ...actual,
    resolveKimiHome: mocks.resolveKimiHome,
    flushDiagnosticLogsSync: mocks.flushDiagnosticLogsSync,
    createKimiHarnessV2: (...args: unknown[]) => {
      mocks.kimiHarnessV2Constructor(...args);
      return makeHarnessStub(args);
    },
  };
});

vi.mock("../../src/tui/config", () => ({
  loadTuiConfig: mocks.loadTuiConfig,
  TuiConfigParseError: mocks.TuiConfigParseError,
}));

vi.mock("../../src/tui/index", () => ({
  KimiTUI: class {
    onExit?: () => Promise<void>;

    constructor(...args: unknown[]) {
      mocks.kimiTuiConstructor(this, ...args);
    }

    start = mocks.tuiStart;
    getCurrentSessionId = mocks.tuiGetCurrentSessionId;
    hasSessionContent = mocks.tuiHasSessionContent;
  },
}));

vi.mock("../../src/tui/theme/detect", () => ({
  detectTerminalTheme: mocks.detectTerminalTheme,
}));

vi.mock("node:child_process", () => ({
  execSync: mocks.execSync,
}));

describe("runShell", () => {
  afterEach(() => {
    vi.clearAllMocks();
    mocks.harnessGetConfig.mockResolvedValue({
      providers: {},
      defaultModel: "k2",
      telemetry: true,
    });
    mocks.tuiGetCurrentSessionId.mockReturnValue("");
    mocks.tuiHasSessionContent.mockReturnValue(false);
    mocks.resolveKimiHome.mockImplementation(
      (homeDir?: string) => homeDir ?? "/tmp/kimi-code-test-home",
    );
  });

  const minimalCliOptions = {
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
  };

  function stubTuiStartup(): void {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: "dark",
      editorCommand: null,
      notifications: { enabled: true, condition: "unfocused" },
    });
    mocks.tuiStart.mockResolvedValue(undefined);
  }

  it("always builds the v2 harness", async () => {
    stubTuiStartup();
    await runShell(minimalCliOptions, "1.2.3-test");
    expect(mocks.kimiHarnessV2Constructor).toHaveBeenCalledTimes(1);
  });

  it("constructs KimiHarness and KimiTUI with startup input", async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: "dark",
      editorCommand: null,
      notifications: { enabled: true, condition: "unfocused" },
    });
    mocks.tuiStart.mockResolvedValue(undefined);
    mocks.tuiGetCurrentSessionId.mockReturnValue("ses-startup");

    const cliOptions = {
      session: undefined,
      continue: false,
      yolo: true,
      auto: false,
      plan: true,
      model: undefined,
      outputFormat: undefined,
      prompt: undefined,
      skillsDirs: [],
      agent: undefined,
      agentFiles: [],
      addDirs: ["../shared", "/tmp/extra"],
    };

    await runShell(cliOptions, "1.2.3-test");

    expect(mocks.kimiHarnessV2Constructor).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({
          productName: "kimi-code-cli",
          version: "1.2.3-test",
        }),
        sessionStartedProperties: {
          yolo: true,
          auto: false,
          plan: true,
          afk: false,
        },
      }),
    );
    expect(mocks.harnessEnsureConfigFile).toHaveBeenCalledOnce();
    expect(
      mocks.harnessEnsureConfigFile.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.harnessGetConfig.mock.invocationCallOrder[0]!);
    expect(execSync).toHaveBeenCalledWith("stty -ixon", {
      stdio: ["inherit", "ignore", "ignore"],
    });
    expect(mocks.kimiTuiConstructor).toHaveBeenCalledTimes(1);

    const [, harness, startupInput] = mocks.kimiTuiConstructor.mock.calls[0]!;
    expect(harness).toBeTypeOf("object");
    expect(startupInput).toMatchObject({
      cliOptions,
      additionalDirs: ["../shared", "/tmp/extra"],
      tuiConfig: {
        theme: "dark",
        editorCommand: null,
        notifications: { enabled: true, condition: "unfocused" },
      },
      version: "1.2.3-test",
      workDir: process.cwd(),
    });
    expect(mocks.tuiStart).toHaveBeenCalledOnce();
  });

  it("resolves the --agent profile into the TUI startup input", async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: "dark",
      editorCommand: null,
      notifications: { enabled: true, condition: "unfocused" },
    });
    mocks.tuiStart.mockResolvedValue(undefined);

    await runShell(
      {
        session: undefined,
        continue: false,
        yolo: false,
        auto: false,
        plan: false,
        model: undefined,
        outputFormat: undefined,
        prompt: undefined,
        skillsDirs: [],
        agent: "reviewer",
        agentFiles: [],
      },
      "1.2.3-test",
    );

    const [, , startupInput] = mocks.kimiTuiConstructor.mock.calls[0]!;
    expect(startupInput).toMatchObject({ agentProfile: "reviewer" });
  });

  it("forwards skillsDirs from CLI options to the harness", async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: "dark",
      editorCommand: null,
      notifications: { enabled: true, condition: "unfocused" },
    });
    mocks.tuiStart.mockResolvedValue(undefined);

    await runShell(
      {
        session: undefined,
        continue: false,
        yolo: false,
        auto: false,
        plan: false,
        model: undefined,
        outputFormat: undefined,
        prompt: undefined,
        skillsDirs: ["/skills"],
        agent: undefined,
        agentFiles: [],
      },
      "1.2.3-test",
    );

    expect(mocks.kimiHarnessV2Constructor).toHaveBeenCalledWith(
      expect.objectContaining({ skillDirs: ["/skills"] }),
    );
  });

  it("detects auto theme and forwards config parse warnings as startup notice", async () => {
    mocks.loadTuiConfig.mockRejectedValue(
      new mocks.TuiConfigParseError({
        theme: "auto",
        editorCommand: "vim",
        notifications: { enabled: true, condition: "always" },
      }),
    );
    mocks.detectTerminalTheme.mockResolvedValue("light");
    mocks.tuiStart.mockResolvedValue(undefined);

    await runShell(
      {
        session: "",
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
      "1.2.3-test",
    );

    expect(mocks.detectTerminalTheme).toHaveBeenCalledOnce();
    const [, , startupInput] = mocks.kimiTuiConstructor.mock.calls[0]!;
    expect(startupInput).toMatchObject({
      startupNotice:
        "Invalid TUI config in ~/.kimi-code/tui.toml; using defaults.",
      tuiConfig: {
        theme: "auto",
        editorCommand: "vim",
        notifications: { enabled: true, condition: "always" },
      },
    });
  });

  it("leaves config.toml diagnostics to the TUI instead of the startup notice", async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: "dark",
      editorCommand: null,
      notifications: { enabled: true, condition: "unfocused" },
    });
    mocks.harnessGetConfigDiagnostics.mockResolvedValue({
      warnings: ["Ignored invalid config in config.toml: loop_control."],
    });
    mocks.tuiStart.mockResolvedValue(undefined);

    await runShell(
      {
        session: "",
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
      "1.2.3-test",
    );

    // Diagnostics render in warning yellow via `showConfigWarningsIfAny` at
    // `finishStartup`; the (dim) startup notice stays reserved for things like
    // tui.toml parse errors, so the same warning is not shown twice.
    const [, , startupInput] = mocks.kimiTuiConstructor.mock.calls[0]!;
    expect(startupInput.startupNotice).toBeUndefined();
  });

  it("flushes diagnostic logs synchronously before exiting on a runtime crash", async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: "dark",
      editorCommand: null,
      notifications: { enabled: true, condition: "unfocused" },
    });
    mocks.tuiStart.mockResolvedValue(undefined);

    const processOnSpy = vi.spyOn(process, "on");
    const stdout = captureProcessWrite("stdout");
    const exitSpy = mockProcessExit();

    try {
      await runShell(
        {
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
        "1.2.3-test",
      );

      const handler = processOnSpy.mock.calls.find(
        ([event]) => event === "uncaughtException",
      )?.[1] as ((error: unknown) => void) | undefined;
      expect(handler).toBeDefined();

      // The async log sink cannot flush before process.exit() runs, so the
      // crash handler must force a synchronous flush or the crash reason is
      // lost (regression: uncaughtException logs never reached disk).
      expect(() => handler?.(new Error("boom"))).toThrow(ExitCalled);
      expect(mocks.flushDiagnosticLogsSync).toHaveBeenCalledOnce();
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(
        mocks.flushDiagnosticLogsSync.mock.invocationCallOrder[0]!,
      ).toBeLessThan(exitSpy.mock.invocationCallOrder[0]!);
    } finally {
      processOnSpy.mockRestore();
      exitSpy.mockRestore();
      stdout.restore();
    }
  });

  it("flushes diagnostic logs synchronously before exiting on an unhandled rejection", async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: "dark",
      editorCommand: null,
      notifications: { enabled: true, condition: "unfocused" },
    });
    mocks.tuiStart.mockResolvedValue(undefined);

    const processOnSpy = vi.spyOn(process, "on");
    const stdout = captureProcessWrite("stdout");
    const exitSpy = mockProcessExit();

    try {
      await runShell(
        {
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
        "1.2.3-test",
      );

      const handler = processOnSpy.mock.calls.find(
        ([event]) => event === "unhandledRejection",
      )?.[1] as ((reason: unknown) => void) | undefined;
      expect(handler).toBeDefined();

      expect(() => handler?.(new Error("boom"))).toThrow(ExitCalled);
      expect(mocks.flushDiagnosticLogsSync).toHaveBeenCalledOnce();
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(
        mocks.flushDiagnosticLogsSync.mock.invocationCallOrder[0]!,
      ).toBeLessThan(exitSpy.mock.invocationCallOrder[0]!);
    } finally {
      processOnSpy.mockRestore();
      exitSpy.mockRestore();
      stdout.restore();
    }
  });

  it("closes the harness when TUI startup fails", async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: "dark",
      editorCommand: null,
      notifications: { enabled: true, condition: "unfocused" },
    });
    mocks.tuiStart.mockRejectedValue(new Error("boom"));

    await expect(
      runShell(
        {
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
        "1.2.3-test",
      ),
    ).rejects.toThrow("boom");

    expect(mocks.harnessClose).toHaveBeenCalledOnce();
  });

  it("prints resume instructions from the TUI exit handler", async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: "dark",
      editorCommand: null,
      notifications: { enabled: true, condition: "unfocused" },
    });
    mocks.tuiStart.mockResolvedValue(undefined);
    mocks.tuiGetCurrentSessionId.mockReturnValue("ses-1");
    mocks.tuiHasSessionContent.mockReturnValue(true);

    const stdout = captureProcessWrite("stdout");
    const stderr = captureProcessWrite("stderr");
    const exitSpy = mockProcessExit();

    try {
      await runShell(
        {
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
        "1.2.3-test",
      );
      const [tui] = mocks.kimiTuiConstructor.mock.calls[0]!;

      await expect(
        (tui as { onExit: () => Promise<void> }).onExit(),
      ).rejects.toBeInstanceOf(ExitCalled);

      expect(stdout.text()).toBe(" Bye!\n");
      expect(stderr.text()).toContain(" To resume this session: kimi -r ses-1");
    } finally {
      exitSpy.mockRestore();
      stdout.restore();
      stderr.restore();
    }
  });
});

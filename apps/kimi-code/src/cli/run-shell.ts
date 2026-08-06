import { execSync, spawnSync } from "node:child_process";
import process from "node:process";
import {
  createKimiHarnessV2,
  flushDiagnosticLogsSync,
  type KimiHarnessOptions,
  log,
  resolveKimiHome,
} from "@moonshot-ai/kimi-code-sdk";
import type { TuiConfig } from "#/tui/config";
import { loadTuiConfig, TuiConfigParseError } from "#/tui/config";
import { CHROME_GUTTER } from "#/tui/constant/rendering";
import { KimiTUI } from "#/tui/index";
import { currentTheme, getColorPalette } from "#/tui/theme";
import { startupTrace } from "#/utils/startup-trace";
import { toTerminalHyperlink } from "#/utils/terminal-hyperlink";
import { restoreTerminalModes } from "#/utils/terminal-restore";
import { resolveAgentProfileSelection } from "./agent-selection.ts";
import type { CLIOptions } from "./options.ts";
import { createKimiCodeHostIdentity } from "./version.ts";

export async function runShell(
  opts: CLIOptions,
  version: string,
): Promise<void> {
  let tuiConfig: TuiConfig;
  let configWarning: string | undefined;
  try {
    tuiConfig = await loadTuiConfig();
  } catch (error) {
    if (!(error instanceof TuiConfigParseError)) throw error;
    tuiConfig = error.fallback;
    configWarning = error.message;
  }

  // Initialise the global Theme singleton before kimi-tui grabs stdin.
  const palette = await getColorPalette(tuiConfig.theme);
  currentTheme.setPalette(palette);

  const workDir = process.cwd();
  const harnessOptions: KimiHarnessOptions = {
    homeDir: resolveKimiHome(),
    identity: createKimiCodeHostIdentity(version),
    skillDirs: opts.skillsDirs,
    sessionStartedProperties: {
      yolo: opts.yolo,
      auto: opts.auto,
      plan: opts.plan,
      afk: false,
    },
  };
  const harness = createKimiHarnessV2(harnessOptions);
  startupTrace("harness:created");
  await harness.ensureConfigFile();
  await harness.getConfig();
  startupTrace("config:loaded");
  // Config diagnostics (deprecated keys, invalid sections, ...) are surfaced
  // by the TUI itself at `finishStartup` via `showConfigWarningsIfAny` —
  // folded into the dim startup notice they were too easy to miss.
  // Resolve --agent/--agent-file once for the startup session; validateOptions
  // has already rejected them alongside --session/--continue.
  const agentProfile = await resolveAgentProfileSelection(opts, workDir);
  const tui = new KimiTUI(harness, {
    cliOptions: opts,
    ...(agentProfile === undefined ? {} : { agentProfile }),
    ...(opts.addDirs?.length ? { additionalDirs: opts.addDirs } : {}),
    tuiConfig,
    version,
    workDir,
    ...(configWarning === undefined ? {} : { startupNotice: configWarning }),
    // The interactive CLI is v2-only; retain this coordinator capability
    // marker for the remaining command/controller interfaces while they are
    // collapsed onto the v2 contracts.
    engineV2: true,
    // Ink is the production terminal owner. kimi-tui remains an explicit
    // rollback switch while the last renderer-specific surfaces are retired.
    terminalRenderer:
      process.env["KIMI_TUI_RENDERER"] === "kimi-tui" ? "kimi-tui" : "ink",
  });

  let savedStty: string | undefined;
  try {
    // stty operates on the terminal behind stdin, so stdin must be the TTY —
    // piping /dev/null (ignore) makes stty fail with "not a tty".
    const saved = execSync("stty -g", {
      encoding: "utf8",
      stdio: ["inherit", "pipe", "ignore"],
    });
    savedStty = typeof saved === "string" ? saved.trim() : undefined;
    execSync("stty -ixon", { stdio: ["inherit", "ignore", "ignore"] });
  } catch {
    /* ignore */
  }
  const restoreStty = (): void => {
    if (savedStty === undefined) return;
    const args = savedStty.split(/\s+/u).filter((arg) => arg.length > 0);
    if (args.length === 0) return;
    spawnSync("stty", args, { stdio: ["inherit", "ignore", "ignore"] });
  };

  // If we crash without going through KimiTUI.stop(), the terminal is left in
  // raw mode with a hidden cursor and XON/XOFF flow control disabled. Restore
  // both before exiting so the user's shell is usable afterwards.
  const emergencyExit = (exitCode: number): void => {
    // The crash log above is only enqueued into the async sink; flush it
    // synchronously or the `process.exit()` below would drop the one line that
    // explains why we crashed. Best-effort: an exit path must never throw.
    try {
      flushDiagnosticLogsSync();
    } catch {
      /* ignore */
    }
    restoreTerminalModes();
    restoreStty();
    process.exit(exitCode);
  };
  const onUncaughtException = (error: unknown): void => {
    try {
      log.error("uncaughtException, restoring terminal and exiting", {
        error: String(error),
      });
    } catch {
      /* ignore */
    }
    emergencyExit(1);
  };
  const onUnhandledRejection = (reason: unknown): void => {
    try {
      log.error("unhandledRejection, restoring terminal and exiting", {
        reason: String(reason),
      });
    } catch {
      /* ignore */
    }
    emergencyExit(1);
  };
  process.on("uncaughtException", onUncaughtException);
  process.on("unhandledRejection", onUnhandledRejection);
  // Remove the crash handlers once the TUI exits cleanly so repeated runShell()
  // calls in the same process (e.g. tests) don't accumulate process listeners.
  const removeCrashHandlers = (): void => {
    process.off("uncaughtException", onUncaughtException);
    process.off("unhandledRejection", onUnhandledRejection);
  };

  tui.onExit = async (exitCode = 0) => {
    const sessionId = tui.getCurrentSessionId();
    const hasContent = tui.hasSessionContent();
    const gutter = " ".repeat(CHROME_GUTTER);
    process.stdout.write(`${gutter}Bye!\n`);
    const hints: string[] = [];
    if (sessionId !== "" && hasContent) {
      hints.push(`${gutter}To resume this session: kimi -r ${sessionId}`);
    }
    if (tui.exitOpenUrl !== undefined) {
      hints.push(
        `${gutter}open ${toTerminalHyperlink(tui.exitOpenUrl, tui.exitOpenUrl)}`,
      );
    }
    if (hints.length > 0) {
      process.stderr.write(`\n${hints.join("\n")}\n`);
    }
    removeCrashHandlers();
    restoreStty();
    if (tui.exitForegroundTask !== undefined) {
      // `/web` starting a new server: the TUI has shut down cleanly; hand the
      // terminal to the foreground server instead of exiting. The task runs
      // until the server stops (Ctrl+C), then this process exits.
      await tui.exitForegroundTask(exitCode);
      return;
    }
    process.exit(exitCode);
  };
  try {
    startupTrace("tui.start:begin");
    await tui.start();
    startupTrace("tui.start:end");
  } catch (error) {
    removeCrashHandlers();
    await harness.close();
    throw error;
  }
}

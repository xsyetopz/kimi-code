/**
 * Native v2 `kimi -p` (print mode) runner.
 *
 * This runner talks to agent-core-v2's native DI services directly. It:
 *   - `bootstrap()`s the app scope,
 *   - creates / resumes a session and its main agent via native services,
 *   - subscribes to the main agent's per-agent `IEventBus` and renders the
 *     native `DomainEvent` stream,
 *   - drives a turn through `IAgentPromptService.enqueue()` and awaits
 *     `Turn.result` for authoritative completion,
 *   - applies the print-mode background policy (config-driven:
 *     `exit` / `drain` / `steer`) before exiting.
 *
 * Selected by `runPrompt` for the v2 print surface.
 */

import {
  IConfigService,
  applyPrintModeConfigDefaults,
  bootstrap,
  logSeed,
  resolveKimiHome,
  resolveLoggingConfig,
} from "@moonshot-ai/agent-core-v2";
import { createKimiDefaultHeaders } from "@moonshot-ai/kimi-code-oauth";

import { PROMPT_CLEANUP_TIMEOUT_MS } from "#/constant/app";

import { parseHeadlessGoalCreate } from "../goal-prompt";
import {
  type PromptRunIO,
  installPromptTerminationCleanup,
  raceWithTimeout,
} from "../run-prompt";
import { createKimiCodeHostIdentity } from "../version";

import { resolveOutputFormat } from "../options";
import type { CLIOptions } from "../options";
import { writeVersion, writeResumeHint } from "../prompt-render";
import { resolveNativeSession } from "./run-v2-print-session";
import { runNativeGoal, runNativeTurn } from "./run-v2-print-turn";

export {
  applyPrintBackgroundPolicy,
  createPrintTurnEndings,
  PrintSteeredTurnFailedError,
  type PrintBackgroundPolicyInput,
  type PrintTurnEnding,
  type PrintTurnEndings,
} from "./run-v2-print-background";

export async function runV2Print(
  opts: CLIOptions,
  version: string,
  io: PromptRunIO = {},
): Promise<void> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const promptProcess = io.process ?? process;
  const outputFormat = resolveOutputFormat(opts);
  const workDir = process.cwd();

  writeVersion(version, outputFormat, stdout, stderr);

  const homeDir = resolveKimiHome();
  const logging = resolveLoggingConfig({ homeDir, env: process.env });
  const identity = createKimiCodeHostIdentity(version);
  const hostHeaders = createKimiDefaultHeaders({ homeDir, ...identity });

  const { app } = bootstrap(
    {
      homeDir,
      clientIdentity: identity,
      args: {
        requestHeaders: hostHeaders,
        // Explicit skill dirs replace default
        // user / project discovery for this process.
        skillDirs: opts.skillsDirs,
        // `--agent-file`: explicit agent definition files, registered with the
        // highest-precedence source for this process. Passed through unresolved —
        // the engine expands `~` and resolves relative paths against the session
        // workDir (mirroring `--skills-dir`).
        agentFiles: opts.agentFiles,
      },
    },
    [...logSeed(logging)],
  );
  const configService = app.accessor.get(IConfigService);
  await configService.ready;
  // Print-mode config defaults (task timeouts / loop step cap / subagent
  // timeout → unbounded) before anything resolves a session; only keys the
  // user left unset are filled, in the memory layer.
  await applyPrintModeConfigDefaults(configService);
  const defaultModel = configService.get<string>("defaultModel") ?? undefined;
  for (const diagnostic of configService.diagnostics()) {
    if (diagnostic.severity === "warning") {
      stderr.write(`Warning: ${diagnostic.message}\n`);
    }
  }

  let restorePermission = async (): Promise<void> => {};
  let removeTerminationCleanup: (() => void) | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = async (): Promise<void> => {
    const pending = (cleanupPromise ??= (async () => {
      removeTerminationCleanup?.();
      try {
        await restorePermission();
      } finally {
        app.dispose();
      }
    })());
    await raceWithTimeout(pending, PROMPT_CLEANUP_TIMEOUT_MS);
  };
  removeTerminationCleanup = installPromptTerminationCleanup(
    promptProcess,
    cleanup,
  );

  try {
    const resolved = await resolveNativeSession(
      app,
      opts,
      workDir,
      defaultModel,
      stderr,
    );
    restorePermission = resolved.restorePermission;

    const goalCreate = parseHeadlessGoalCreate(opts.prompt!);
    if (goalCreate !== undefined) {
      await runNativeGoal(
        app,
        resolved.session,
        resolved.agent,
        goalCreate,
        resolved.goalModel,
        outputFormat,
        stdout,
        stderr,
      );
    } else {
      await runNativeTurn(
        app,
        resolved.session,
        resolved.agent,
        opts.prompt!,
        outputFormat,
        stdout,
        stderr,
      );
    }
    writeResumeHint(resolved.session.id, outputFormat, stdout, stderr);
  } finally {
    await cleanup();
  }
}

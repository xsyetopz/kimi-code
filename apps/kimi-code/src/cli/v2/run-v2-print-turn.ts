import {
  IAgentGoalService,
  IAgentLifecycleService,
  IAgentPromptService,
  IAgentTaskService,
  IAuthSummaryService,
  IConfigService,
  IEventBus,
  ISessionCronService,
  PRINT_MAX_TURNS_DEFAULT,
  PRINT_WAIT_CEILING_S_DEFAULT,
  resolveAgentTaskConfig,
  resolvePrintBackgroundMode,
  type DomainEvent,
  type IAgentScopeHandle,
  type ISessionScopeHandle,
  type LoopRunResult,
  type Scope,
} from "@moonshot-ai/kimi-code-sdk";

import {
  formatGoalSummaryText,
  goalExitCode,
  goalSummaryJson,
  type HeadlessGoalCreate,
} from "../goal-prompt";
import { requireConfiguredModel } from "../run-prompt";
import type { PromptOutputFormat } from "../options";
import {
  type PromptOutput,
  PromptJsonWriter,
  type PromptTurnWriter,
  PromptTranscriptWriter,
} from "../prompt-render";
import {
  applyPrintBackgroundPolicy,
  createPrintTurnEndings,
  PrintSteeredTurnFailedError,
} from "./run-v2-print-background";

export async function runNativeTurn(
  app: Scope,
  session: ISessionScopeHandle,
  agent: IAgentScopeHandle,
  prompt: string,
  outputFormat: PromptOutputFormat,
  stdout: PromptOutput,
  stderr: PromptOutput,
): Promise<void> {
  const writer: PromptTurnWriter =
    outputFormat === "stream-json"
      ? new PromptJsonWriter(stdout)
      : new PromptTranscriptWriter(stdout, stderr);

  await agent.accessor.get(IAuthSummaryService).ensureReady();

  const turnEndings = createPrintTurnEndings();
  const subscription = agent.accessor
    .get(IEventBus)
    .subscribe((event: DomainEvent) => {
      dispatchNativeEvent(writer, event, stderr);
      // Arm the turn-endings collector before `turn.result` settles so a
      // background-task completion that steers a new turn right after the main
      // turn ends cannot have its `turn.ended` slip past the policy loop.
      if (event.type === "turn.ended") turnEndings.push(event);
    });
  try {
    const handle = await agent.accessor.get(IAgentPromptService).enqueue({
      message: {
        role: "user",
        content: [{ type: "text", text: prompt }],
        toolCalls: [],
        origin: { kind: "user" },
      },
    });
    const turn = await handle.launched;
    if (turn === undefined) {
      // A prompt blocked by an onBeforeSubmitPrompt hook never launches a turn.
      writer.finish();
      const completion = await handle.completion;
      throw new Error(
        completion.state === "blocked"
          ? "Prompt hook blocked the request."
          : "Prompt turn could not be started",
      );
    }
    const result = await turn.result;

    // Turn settled, but `-p` is not done until the print-mode background
    // policy says so (config-driven: exit / drain / steer). Flush the buffered
    // assistant message first so a long drain/steer wait does not withhold the
    // final message.
    writer.flushAssistant();
    if (result.type === "completed") {
      const configService = app.accessor.get(IConfigService);
      const taskConfig = resolveAgentTaskConfig(configService);
      const goalService = agent.accessor.get(IAgentGoalService);
      const cronService = session.accessor.get(ISessionCronService);
      try {
        await applyPrintBackgroundPolicy({
          mode: resolvePrintBackgroundMode(configService),
          ceilingS:
            taskConfig?.printWaitCeilingS ?? PRINT_WAIT_CEILING_S_DEFAULT,
          maxTurns: taskConfig?.printMaxTurns ?? PRINT_MAX_TURNS_DEFAULT,
          countPending: () => countPendingBackgroundTasks(session),
          drain: () =>
            drainBackgroundTasks(session, taskConfig?.printWaitCeilingS),
          turnEndings,
          skipTurnId: turn.id,
          warn: (message) => stderr.write(`Warning: ${message}\n`),
          now: () => Date.now(),
          goalActive: () => goalService.getGoal().goal?.status === "active",
          cronNextFireAt: () => cronService.getNextFireTime(),
        });
      } catch (error) {
        // A steered turn that fails fails the run, matching the print contract;
        // other background failures are best-effort and must not fail the
        // already completed main turn.
        if (error instanceof PrintSteeredTurnFailedError) {
          writer.finish();
          throw error;
        }
        stderr.write(
          `Warning: print background policy failed: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      }
      writer.finish();
      return;
    }
    writer.finish();
    throw new Error(formatNativeTurnFailure(result));
  } catch (error) {
    writer.finish();
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    subscription.dispose();
  }
}

export async function runNativeGoal(
  app: Scope,
  session: ISessionScopeHandle,
  agent: IAgentScopeHandle,
  goal: HeadlessGoalCreate,
  model: string | undefined,
  outputFormat: PromptOutputFormat,
  stdout: PromptOutput,
  stderr: PromptOutput,
): Promise<void> {
  requireConfiguredModel(model);
  const goalService = agent.accessor.get(IAgentGoalService);
  await goalService.createGoal({
    objective: goal.objective,
    replace: goal.replace,
  });
  let completedSnapshot: { readonly status: string } | null = null;
  const subscription = agent.accessor
    .get(IEventBus)
    .subscribe((event: DomainEvent) => {
      if (
        event.type === "goal.updated" &&
        event.change?.kind === "completion" &&
        event.snapshot !== null
      ) {
        completedSnapshot = event.snapshot;
      }
    });
  try {
    await runNativeTurn(
      app,
      session,
      agent,
      goal.objective,
      outputFormat,
      stdout,
      stderr,
    );
  } finally {
    subscription.dispose();
    const snapshot = completedSnapshot ?? goalService.getGoal().goal;
    if (outputFormat === "stream-json") {
      stdout.write(`${JSON.stringify(goalSummaryJson(snapshot))}\n`);
    } else {
      stderr.write(`${formatGoalSummaryText(snapshot)}\n`);
    }
    if (snapshot !== null && snapshot.status !== "complete") {
      process.exitCode = goalExitCode(snapshot.status);
    }
  }
}

function dispatchNativeEvent(
  writer: PromptTurnWriter,
  event: DomainEvent,
  stderr: PromptOutput,
): void {
  switch (event.type) {
    case "turn.step.started":
    case "turn.step.interrupted":
      writer.flushAssistant();
      return;
    case "turn.step.retrying":
      writer.discardAssistant();
      writer.writeRetrying(event);
      return;
    case "assistant.delta":
      writer.writeAssistantDelta(event.delta);
      return;
    case "hook.result":
      writer.writeHookResult(event);
      return;
    case "thinking.delta":
      writer.writeThinkingDelta(event.delta);
      return;
    case "tool.call.started":
      writer.writeToolCall(event.toolCallId, event.name, event.args);
      return;
    case "tool.call.delta":
      writer.writeToolCallDelta(
        event.toolCallId,
        event.name,
        event.argumentsPart,
      );
      return;
    case "tool.result":
      writer.writeToolResult(event.toolCallId, event.output);
      return;
    case "tool.progress":
      if (event.update.text !== undefined && event.update.text.length > 0) {
        stderr.write(
          event.update.text.endsWith("\n")
            ? event.update.text
            : `${event.update.text}\n`,
        );
      }
      return;
  }
}

function formatNativeTurnFailure(result: LoopRunResult): string {
  if (result.type === "failed") {
    const error = result.error as
      | { readonly code?: string; readonly message?: string }
      | undefined;
    if (error?.code === "provider.filtered") {
      return "Provider safety policy blocked the response.";
    }
    if (error?.code !== undefined) {
      return `${error.code}: ${error.message ?? ""}`.trimEnd();
    }
    if (result.error instanceof Error) {
      return result.error.message;
    }
  }
  return `Prompt turn ended with reason: ${result.type}`;
}

function countPendingBackgroundTasks(session: ISessionScopeHandle): number {
  let count = 0;
  for (const handle of session.accessor.get(IAgentLifecycleService).list()) {
    count += handle.accessor.get(IAgentTaskService).list(true).length;
  }
  return count;
}

async function drainBackgroundTasks(
  session: ISessionScopeHandle,
  ceilingS: number | undefined,
): Promise<void> {
  const ceilingMs =
    typeof ceilingS === "number" && Number.isFinite(ceilingS) && ceilingS > 0
      ? ceilingS * 1000
      : PRINT_WAIT_CEILING_S_DEFAULT * 1000;

  const deadline = Date.now() + ceilingMs;
  const seen = new Set<string>();
  const allWaiters: Promise<unknown>[] = [];
  while (Date.now() < deadline) {
    const batch: Promise<unknown>[] = [];
    const suppressions: Promise<void>[] = [];
    let activeCount = 0;
    for (const handle of session.accessor.get(IAgentLifecycleService).list()) {
      const taskService = handle.accessor.get(IAgentTaskService);
      for (const task of taskService.list(true)) {
        activeCount++;
        if (seen.has(task.taskId)) continue;
        seen.add(task.taskId);
        suppressions.push(
          taskService.suppressTerminalNotification(task.taskId),
        );
        const remaining = Math.max(1, deadline - Date.now());
        const waiter = taskService.wait(task.taskId, remaining);
        batch.push(waiter);
        allWaiters.push(waiter);
      }
    }
    if (suppressions.length > 0) await Promise.all(suppressions);
    if (activeCount === 0 || batch.length === 0) break;
    await Promise.all(batch);
  }
  if (allWaiters.length > 0) await Promise.all(allWaiters);
}

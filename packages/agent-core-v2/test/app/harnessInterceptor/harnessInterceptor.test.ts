/**
 * Scenario: App-scope harness interceptor registry and agent-scope wiring into
 * existing hook slots.
 *
 * Run: `pnpm exec vitest run packages/agent-core-v2/test/app/harnessInterceptor/harnessInterceptor.test.ts`.
 */

import { afterEach, describe, expect, it, onTestFinished } from "vitest";

import { DisposableStore } from "#/_base/di/lifecycle";
import { createServices } from "#/_base/di/test";
import { Event } from "#/_base/event";
import { IAgentContextMemoryService } from "#/agent/contextMemory/contextMemory";
import type { ContextMessage } from "#/agent/contextMemory/types";
import {
  AgentHarnessInterceptorService,
} from "#/agent/harnessInterceptor/harnessInterceptorService";
import { IAgentHarnessInterceptorService } from "#/agent/harnessInterceptor/harnessInterceptor";
import { IAgentFullCompactionService } from "#/agent/fullCompaction/fullCompaction";
import { IAgentLoopService } from "#/agent/loop/loop";
import { IAgentPromptService } from "#/agent/prompt/prompt";
import { AgentPromptService } from "#/agent/prompt/promptService";
import { IAgentSystemReminderService } from "#/agent/systemReminder/systemReminder";
import { AgentSystemReminderService } from "#/agent/systemReminder/systemReminderService";
import {
  denyToolExecution,
} from "#/agent/toolExecutor/beforeToolExecuteEvent";
import type { BeforeToolExecuteEvent } from "#/agent/toolExecutor/toolHooks";
import { IAgentToolExecutorService } from "#/agent/toolExecutor/toolExecutor";
import { AgentToolExecutorService } from "#/agent/toolExecutor/toolExecutorService";
import { IAgentToolRegistryService } from "#/agent/toolRegistry/toolRegistry";
import { AgentToolRegistryService } from "#/agent/toolRegistry/toolRegistryService";
import {
  HarnessInterceptorRegistryService,
} from "#/app/harnessInterceptor/harnessInterceptorRegistryService";
import { IHarnessInterceptorRegistry } from "#/app/harnessInterceptor/harnessInterceptorRegistry";
import { IEventBus } from "#/app/event/eventBus";
import { EventBusService } from "#/app/event/eventBusService";
import { ITelemetryService } from "#/app/telemetry/telemetry";
import { BugIndicatingError } from "#/errors";
import { createHooks } from "#/hooks";
import { IWireService } from "#/wire/wire";

import { registerLogServices } from "../../_base/log/stubs";
import { recordingTelemetry } from "../../app/telemetry/stubs";
import { stubContextMemory } from "../../agent/contextMemory/stubs";
import { stubLoopWithHooks } from "../../agent/loop/stubs";
import { stubToolExecutorEvents } from "../../agent/toolExecutor/stubs";
import { registerToolResultTruncationServices } from "../../agent/toolResultTruncation/stubs";
import { registerStateServices } from "../../state/stubs";
import { registerTestAgentWireServices } from "../../wire/stubs";

function message(text: string): ContextMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    toolCalls: [],
    origin: { kind: "user" },
  };
}

function createPromptHarness(registry: IHarnessInterceptorRegistry) {
  const disposables = new DisposableStore();
  onTestFinished(() => disposables.dispose());
  const context = stubContextMemory();
  const loop = stubLoopWithHooks({ pendingTurnResult: true });
  const fullCompaction = {
    _serviceBrand: undefined,
    compacting: null,
    begin: () => false,
    hooks: createHooks(["onWillCompact"]),
    onDidFinishCompaction: Event.None,
  } as unknown as IAgentFullCompactionService;
  const ix = createServices(disposables, {
    strict: true,
    additionalServices: (reg) => {
      registerStateServices(reg);
      registerLogServices(reg);
      registerTestAgentWireServices(reg, "wire/harness-interceptor");
      registerToolResultTruncationServices(reg);
      reg.defineInstance(IHarnessInterceptorRegistry, registry);
      reg.defineInstance(IAgentContextMemoryService, context);
      reg.defineInstance(IAgentLoopService, loop);
      reg.defineInstance(IWireService, {
        _serviceBrand: undefined,
        append: () => {},
        getModel: () => undefined,
        restore: async () => {},
        seal: async () => {},
        hooks: createHooks(["onDidRestore"]),
      } as unknown as IWireService);
      reg.defineInstance(
        ITelemetryService,
        recordingTelemetry([]),
      );
      reg.defineInstance(IAgentFullCompactionService, fullCompaction);
      reg.define(IEventBus, EventBusService);
      reg.define(IAgentSystemReminderService, AgentSystemReminderService);
      reg.define(IAgentToolRegistryService, AgentToolRegistryService);
      reg.define(IAgentToolExecutorService, AgentToolExecutorService);
      reg.define(IAgentPromptService, AgentPromptService);
      reg.define(IAgentHarnessInterceptorService, AgentHarnessInterceptorService);
    },
  });
  return {
    prompt: ix.get(IAgentPromptService),
    toolExecutor: ix.get(IAgentToolExecutorService),
    wiring: ix.get(IAgentHarnessInterceptorService),
    loop,
    context,
  };
}

describe("HarnessInterceptorRegistryService", () => {
  let disposables: DisposableStore;

  afterEach(() => {
    disposables?.dispose();
  });

  it("lists interceptors sorted by priority then name", () => {
    disposables = new DisposableStore();
    const registry = disposables.add(new HarnessInterceptorRegistryService());
    registry.register({
      name: "z-late",
      priority: 10,
      hooks: {},
    });
    registry.register({
      name: "a-early",
      priority: 0,
      hooks: {},
    });
    registry.register({
      name: "b-early",
      priority: 0,
      hooks: {},
    });
    expect(registry.list().map((item) => item.name)).toEqual([
      "a-early",
      "b-early",
      "z-late",
    ]);
  });

  it("rejects duplicate interceptor names", () => {
    disposables = new DisposableStore();
    const registry = disposables.add(new HarnessInterceptorRegistryService());
    registry.register({ name: "dup", priority: 0, hooks: {} });
    expect(() =>
      registry.register({ name: "dup", priority: 1, hooks: {} }),
    ).toThrow(BugIndicatingError);
  });
});

describe("AgentHarnessInterceptorService", () => {
  it("wires onBeforeSubmitPrompt interceptors into the prompt hook slot", async () => {
    const registry = new HarnessInterceptorRegistryService();
    let called = false;
    registry.register({
      name: "stub-block",
      priority: 0,
      hooks: {
        onBeforeSubmitPrompt: async (ctx, next) => {
          called = true;
          ctx.block = true;
          await next();
        },
      },
    });

    const { prompt, wiring } = createPromptHarness(registry);
    expect(wiring).toBeDefined();
    const handle = await prompt.enqueue({ message: message("blocked") });

    expect(called).toBe(true);
    await expect(handle.completion).resolves.toMatchObject({
      state: "blocked",
    });
  });

  it("wires onBeforeExecuteTool interceptors into the tool veto event", async () => {
    const registry = new HarnessInterceptorRegistryService();
    let called = false;
    registry.register({
      name: "stub-veto",
      priority: 0,
      hooks: {
        onBeforeExecuteTool: (event: BeforeToolExecuteEvent) => {
          called = true;
          event.veto(denyToolExecution("harness veto"));
        },
      },
    });

    const disposables = new DisposableStore();
    onTestFinished(() => disposables.dispose());
    const events = stubToolExecutorEvents();
    const ix = createServices(disposables, {
      strict: true,
      additionalServices: (reg) => {
        registerStateServices(reg);
        registerLogServices(reg);
        registerTestAgentWireServices(reg, "wire/harness-interceptor-tool");
        registerToolResultTruncationServices(reg);
        reg.defineInstance(IHarnessInterceptorRegistry, registry);
        reg.defineInstance(IAgentToolRegistryService, AgentToolRegistryService);
        reg.defineInstance(IAgentToolExecutorService, events.executor);
        reg.define(IAgentHarnessInterceptorService, AgentHarnessInterceptorService);
      },
    });
    void ix.get(IAgentHarnessInterceptorService);

    const decision = await events.fireBeforeExecute({
      turnId: 1,
      signal: new AbortController().signal,
      toolCall: {
        id: "call-1",
        type: "function",
        function: { name: "Read", arguments: "{}" },
      },
      toolCalls: [],
      tool: undefined,
      args: {},
      execution: {
        toolName: "Read",
        toolCallId: "call-1",
        accesses: {},
        execute: async () => ({ output: "ok", isError: false }),
      },
    });

    expect(called).toBe(true);
    expect(decision?.veto).toMatchObject({
      output: "harness veto",
      isError: true,
    });
  });
});

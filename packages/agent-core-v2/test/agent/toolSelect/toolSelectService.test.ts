/**
 * Scenario: progressive tool disclosure shapes the provider-visible tool view,
 * dynamic history, selection results, executor interception, and announcements.
 *
 * Responsibilities: assert the gate contract, profile-active filtering,
 * loadable/loaded MCP settlement, and the select_tools built-in behavior.
 * Wiring: real toolSelect, registry, announcement sidecar, system reminder,
 * and hook slots with fake loop/context memory/profile/flag/event services;
 * Run: ../../node_modules/.bin/vitest run test/toolSelect/toolSelectService.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DisposableStore,
  toDisposable,
  type IDisposable,
} from "#/_base/di/lifecycle";
import {
  createServices,
  type ServiceRegistration,
  type TestInstantiationService,
} from "#/_base/di/test";
import { OrderedHookSlot } from "#/hooks";
import { IEventBus, type DomainEvent } from "#/app/event/eventBus";
import { IFlagService } from "#/app/flag/flag";
import type { ModelCapability } from "#/kosong/contract/capability";
import type { ToolCall } from "#/kosong/contract/message";
import { IAgentContextMemoryService } from "#/agent/contextMemory/contextMemory";
import type { UndoCut } from "#/agent/contextMemory/contextOps";
import type { ContextMessage } from "#/agent/contextMemory/types";
import type { LoopRecordedEvent } from "#/agent/contextMemory/loopEventFold";
import {
  IAgentLoopService,
  type AfterStepContext,
  type BeforeStepContext,
  type EnqueueReceipt,
  type LoopRunResult,
  type StepEnqueueOptions,
  type Turn,
} from "#/agent/loop/loop";
import type { StepRequest } from "#/agent/loop/stepRequest";
import { IAgentProfileService } from "#/agent/profile/profile";
import { IAgentToolPolicyService } from "#/agent/toolPolicy/toolPolicy";
import {
  IAgentScopeContext,
  makeAgentScopeContext,
} from "#/agent/scopeContext/scopeContext";
import { IAgentSystemReminderService } from "#/agent/systemReminder/systemReminder";
import { AgentSystemReminderService } from "#/agent/systemReminder/systemReminderService";
import type {
  ExecutableTool,
  ToolDisclosure,
  ToolExecution,
} from "#/tool/toolContract";
import {
  IAgentToolExecutorService,
  type ToolExecutionResult,
} from "#/agent/toolExecutor/toolExecutor";
import { AgentToolExecutorService } from "#/agent/toolExecutor/toolExecutorService";
import { IAgentToolRegistryService } from "#/agent/toolRegistry/toolRegistry";
import { AgentToolRegistryService } from "#/agent/toolRegistry/toolRegistryService";
import {
  DYNAMIC_TOOL_SCHEMA_VARIANT,
  LOADABLE_TOOLS_TRIGGER,
} from "#/agent/toolSelect/dynamicTools";
import { TOOL_SELECT_FLAG_ID } from "#/agent/toolSelect/flag";
import {
  IAgentToolSelectService,
  SELECT_TOOLS_TOOL_NAME,
} from "#/agent/toolSelect/toolSelect";
import { IAgentToolSelectAnnouncementsService } from "#/agent/toolSelect/toolSelectAnnouncements";
import { AgentToolSelectAnnouncementsService } from "#/agent/toolSelect/toolSelectAnnouncementsService";
import { AgentToolSelectService } from "#/agent/toolSelect/toolSelectService";
import { SelectToolsTool } from "#/agent/tools/select-tools/selectToolsTool";
import { registerLogServices } from "../../_base/log/stubs";
import { registerStateServices } from "../../state/stubs";
import { stubToolExecutor } from "../loop/stubs";
      ].join("\n"),
    });
  });

  it("returns an error when select_tools only receives unknown names", async () => {
    const h = createHarness();
    const selectTools = h.ix.createInstance(SelectToolsTool);
    const ctx = {
      turnId: 1,
      toolCallId: "call-1",
      signal: new AbortController().signal,
    };
    const unknownOnly = selectTools.resolveExecution({ names: [MCP_GONE] });
    if (unknownOnly.isError === true)
      throw new Error("expected a runnable execution");
    expect(await unknownOnly.execute(ctx)).toEqual({
      output: `Unknown tool: ${MCP_GONE}. Pick from the latest announced tools list.`,
      isError: true,
    });
  });
});

describe("AgentToolSelectService executor interception", () => {
  beforeEach(() => {
    flagEnabled = true;
  });

  it("the executor settles the intercepted call without running the tool", async () => {
    const h = createExecutorHarness();
    const alpha = new StubMcpTool(MCP_ALPHA);
    registerMcp(h, alpha);

    const results = await execute(h, toolCall("call-1", MCP_ALPHA));
    expect(results).toHaveLength(1);
    expect(results[0]!.result.isError).toBe(true);
    expect(results[0]!.result.output).toContain("is available but not loaded");
    expect(alpha.calls).toBe(0);
  });

  it("the executor returns loading guidance before validating args for an unloaded MCP tool", async () => {
    const h = createExecutorHarness();
    const alpha = new StubMcpTool(
      MCP_ALPHA,
      "mcp ok",
      REQUIRED_PAYLOAD_PARAMETERS,
    );
    registerMcp(h, alpha);

    const results = await execute(
      h,
      toolCall("call-1", MCP_ALPHA, { unexpected: true }),
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.result).toEqual({
      output:
        `Tool "${MCP_ALPHA}" is available but not loaded. ` +
        `Call select_tools with ["${MCP_ALPHA}"] first, then call the tool.`,
      isError: true,
      stopTurn: false,
    });
    expect(alpha.calls).toBe(0);
  });

  it("the executor runs the tool once its schema is loaded", async () => {
    const h = createExecutorHarness();
    const alpha = new StubMcpTool(MCP_ALPHA);
    registerMcp(h, alpha);
    h.contextMemory.history.push(schemaMessage(MCP_ALPHA));

    const results = await execute(h, toolCall("call-1", MCP_ALPHA));
    expect(results).toHaveLength(1);
    expect(results[0]!.result.output).toBe("mcp ok");
    expect(alpha.calls).toBe(1);
  });

  it("the executor rejects a loaded MCP tool when the profile disables it", async () => {
    const h = createExecutorHarness();
    const alpha = new StubMcpTool(MCP_ALPHA);
    registerMcp(h, alpha);
    h.contextMemory.history.push(schemaMessage(MCP_ALPHA));
    activeToolNames = new Set([]);

    const results = await execute(h, toolCall("call-1", MCP_ALPHA));

    expect(results).toHaveLength(1);
    expect(results[0]!.result).toEqual({
      output: `Tool "${MCP_ALPHA}" was loaded but is no longer active. Ask the user to enable it before calling it again.`,
      isError: true,
      stopTurn: false,
    });
    expect(alpha.calls).toBe(0);
  });

  it("the executor runs non-MCP tools without loading", async () => {
    const h = createExecutorHarness();
    const echo = new EchoTool();
    registerBuiltin(h, echo);

    const results = await execute(h, toolCall("call-1", "Echo"));
    expect(results).toHaveLength(1);
    expect(results[0]!.result.output).toBe("echo ok");
    expect(echo.calls).toBe(1);
  });

  it("intercepts an unloaded deferred user tool and runs it after selection", async () => {
    const h = createExecutorHarness();
    const dashboard = new EchoTool(USER_DEFERRED);
    registerUser(h, dashboard, "deferred");

    const beforeLoad = await execute(h, toolCall("call-1", USER_DEFERRED));
    expect(beforeLoad[0]!.result.output).toContain(
      "is available but not loaded",
    );
    expect(dashboard.calls).toBe(0);

    h.contextMemory.history.push(schemaMessage(USER_DEFERRED));
    const afterLoad = await execute(h, toolCall("call-2", USER_DEFERRED));
    expect(afterLoad[0]!.result.output).toBe("echo ok");
    expect(dashboard.calls).toBe(1);
  });
});

describe("AgentToolSelectService missing tool wording", () => {
  beforeEach(() => {
    flagEnabled = true;
  });

  it("tells a loaded-but-disconnected MCP tool apart from an unknown name", async () => {
    const h = createExecutorHarness();
    h.contextMemory.history.push(schemaMessage(MCP_GONE));

    const results = await execute(h, toolCall("call-1", MCP_GONE));
    expect(results).toHaveLength(1);
    expect(results[0]!.result.isError).toBe(true);
    expect(results[0]!.result.output).toBe(
      `Tool "${MCP_GONE}" was loaded but its MCP server is currently disconnected. ` +
        "It may become available again when the server reconnects; do not retry immediately.",
    );
  });

  it("keeps the default message for a name that was never loaded", async () => {
    const h = createExecutorHarness();
    const results = await execute(h, toolCall("call-1", MCP_GONE));
    expect(results[0]!.result.output).toBe(`Tool "${MCP_GONE}" not found`);
  });

  it("reports a loaded user tool that is no longer registered", async () => {
    const h = createExecutorHarness();
    const registration = registerUser(
      h,
      new EchoTool(USER_DEFERRED),
      "deferred",
    );
    h.contextMemory.history.push(schemaMessage(USER_DEFERRED));
    registration.dispose();

    const results = await execute(h, toolCall("call-1", USER_DEFERRED));

    expect(results[0]!.result.output).toBe(
      `Tool "${USER_DEFERRED}" was loaded but is no longer registered. ` +
        "Do not retry it unless it becomes available again.",
    );
  });
});

describe("AgentToolSelectService loadable-tools announcements", () => {
  beforeEach(() => {
    flagEnabled = true;
  });

  it("announces the full loadable set on first run, then stays silent while unchanged", async () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_BETA));
    registerMcp(h, new StubMcpTool(MCP_ALPHA));

    const first = await announce(h);
    expect(first).toContain(
      `<tools_added>\n${MCP_ALPHA}\n${MCP_BETA}\n</tools_added>`,
    );
    expect(first).not.toContain("<tools_removed>");

    expect(await announce(h, 2)).toBeUndefined();
  });

  it("waits until the next boundary before announcing registry diffs", async () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    await announce(h);

    registerMcp(h, new StubMcpTool(MCP_GAMMA));
    expect(await announce(h, 2)).toBeUndefined();

    h.eventBus.emit("turn.started");
    const diff = await announce(h);
    expect(diff).toContain(`<tools_added>\n${MCP_GAMMA}\n</tools_added>`);
  });

  it("diffs registry additions and removals against the folded announcements", async () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    const betaRegistration = h.registry.register(new StubMcpTool(MCP_BETA), {
      source: "mcp",
    });
    disposables.add(betaRegistration);

    await announce(h);

    betaRegistration.dispose();
    registerMcp(h, new StubMcpTool(MCP_GAMMA));
    h.eventBus.emit("turn.started");

    const diff = await announce(h);
    expect(diff).toContain(`<tools_added>\n${MCP_GAMMA}\n</tools_added>`);
    expect(diff).toContain(`<tools_removed>\n${MCP_BETA}\n</tools_removed>`);
  });

  it("re-announces the full set after compaction discards the history", async () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    registerMcp(h, new StubMcpTool(MCP_BETA));

    await announce(h);
    expect(await announce(h, 2)).toBeUndefined();

    h.contextMemory.clear();
    h.eventBus.emit("compaction.completed");

    const reannounced = await announce(h, 2);
    expect(reannounced).toContain(
      `<tools_added>\n${MCP_ALPHA}\n${MCP_BETA}\n</tools_added>`,
    );
  });

  it("announces only profile-active tools", async () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    registerMcp(h, new StubMcpTool(MCP_BETA));
    activeToolNames = new Set([MCP_BETA]);

    const first = await announce(h);
    expect(first).toContain(`<tools_added>\n${MCP_BETA}\n</tools_added>`);
    expect(first).not.toContain(MCP_ALPHA);
  });

  it("stays silent while the gate is closed", async () => {
    flagEnabled = false;
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    expect(await announce(h)).toBeUndefined();
  });
});

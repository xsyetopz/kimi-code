import type { ContentPart } from "#/kosong/contract/message";
import type { Tool as KosongTool } from "#/kosong/contract/tool";
import { Jimp } from "jimp";
import {
  CallToolResultSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SyncDescriptor } from "#/_base/di/descriptors";
import { DisposableStore, toDisposable } from "#/_base/di/lifecycle";
import { TestInstantiationService } from "#/_base/di/test";
import { Event } from "#/_base/event";
import { abortError } from "#/_base/utils/abort";
import { type DomainEvent, IEventBus } from "#/app/event/eventBus";
import type {
  McpConnectionManager,
  McpServerEntry,
} from "#/mcpCore/connection-manager";
import { IAgentMcpService } from "#/agent/mcp/mcp";
import { AgentMcpService } from "#/agent/mcp/mcpService";
import { ISessionMcpHandle } from "#/session/mcp/sessionMcpHandle";
import { ISessionContext } from "#/session/sessionContext/sessionContext";
import type { McpOAuthService } from "#/mcpCore/oauth/service";
import type { MCPClient, MCPToolDefinition } from "#/mcpCore/types";
import { IWireService } from "#/wire/wire";
import type { WireRecord } from "#/wire/record";
import { McpDiscoveryModel } from "#/agent/mcp/mcpDiscoveryOps";
import { AgentToolExecutorService } from "#/agent/toolExecutor/toolExecutorService";
import { IAgentToolExecutorService } from "#/agent/toolExecutor/toolExecutor";
import { IAgentToolResultTruncationService } from "#/agent/toolResultTruncation/toolResultTruncation";
import { IAgentToolRegistryService } from "#/agent/toolRegistry/toolRegistry";
import { AgentToolRegistryService } from "#/agent/toolRegistry/toolRegistryService";
import { IAgentLoopService } from "#/agent/loop/loop";
import { IAgentProfileService } from "#/agent/profile/profile";
import { IAgentStateService } from "#/agent/state/agentState";
import { AgentStateService } from "#/agent/state/agentStateService";

import {
  createTestAgent,
  mcpServices,
  type TestAgentContext,
} from "../../harness";
import { stubLoopWithHooks } from "../loop/stubs";
import { stubToolResultTruncationService } from "../toolResultTruncation/stubs";
import { recordingWireLog, registerTestAgentWire } from "../../wire/stubs";

      signal: new AbortController().signal,
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toBe("back from the dead");
    expect(freshCounter.calls).toBe(1);
    expect(reconnects).toBe(1);
  });

  it("returns a non-transport MCP error without reconnecting the server", async () => {
    const manager = new FakeMcpManager();
    const base = fakeMcpClient();
    const client: MCPClient = {
      listTools: () => base.listTools(),
      async callTool() {
        throw new McpError(ErrorCode.InvalidParams, "Invalid tool arguments");
      },
      ping: () => base.ping(),
    };
    let reconnects = 0;
    manager.reconnectHandler = async () => {
      reconnects += 1;
    };
    manager.setResolved("s", client, await discoverTools(client));
    createService(manager);
    manager.connect("s");

    const echo = ix.get(IAgentToolRegistryService).resolve("mcp__s__echo");
    await expect(
      executeTool(echo!, {
        turnId: 1,
        toolCallId: "tc-non-transport-error",
        args: { text: "hi" },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Invalid tool arguments");
    expect(reconnects).toBe(0);
  });

  it("rethrows the original error when the server does not come back", async () => {
    const manager = new FakeMcpManager();
    const deadClient = throwingClient(fakeMcpClient(), () => manager.fail("s"));
    manager.reconnectHandler = async (name) => {
      manager.fail(name);
    };
    manager.setResolved("s", deadClient, await discoverTools(deadClient));
    createService(manager);
    manager.connect("s");

    const echo = ix.get(IAgentToolRegistryService).resolve("mcp__s__echo");
    await expect(
      executeTool(echo!, {
        turnId: 1,
        toolCallId: "tc-still-dead",
        args: { text: "hi" },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Connection closed");
    // The tools stay registered after the failed reconnect so a later call
    // can try healing the server again instead of hitting "tool not found".
    expect(
      ix
        .get(IAgentToolRegistryService)
        .list()
        .filter((tool) => tool.source === "mcp"),
    ).toHaveLength(2);
  });

  it("reports both errors when the reconnect attempt itself fails", async () => {
    const manager = new FakeMcpManager();
    const deadClient = throwingClient(fakeMcpClient(), () => manager.fail("s"));
    manager.reconnectHandler = async () => {
      throw new Error("spawn failed");
    };
    manager.setResolved("s", deadClient, await discoverTools(deadClient));
    createService(manager);
    manager.connect("s");

    const echo = ix.get(IAgentToolRegistryService).resolve("mcp__s__echo");
    await expect(
      executeTool(echo!, {
        turnId: 1,
        toolCallId: "tc-reconnect-fails",
        args: { text: "hi" },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/Connection closed .*spawn failed/);
  });

  it("does not reconnect when the call was aborted", async () => {
    const manager = new FakeMcpManager();
    const base = fakeMcpClient();
    const abortingClient: MCPClient = {
      listTools: () => base.listTools(),
      async callTool() {
        throw abortError("This operation was aborted");
      },
      ping: () => base.ping(),
    };
    let reconnects = 0;
    manager.reconnectHandler = async () => {
      reconnects += 1;
    };
    manager.setResolved(
      "s",
      abortingClient,
      await discoverTools(abortingClient),
    );
    createService(manager);
    manager.connect("s");

    const echo = ix.get(IAgentToolRegistryService).resolve("mcp__s__echo");
    await expect(
      executeTool(echo!, {
        turnId: 1,
        toolCallId: "tc-aborted",
        args: { text: "hi" },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("This operation was aborted");
    expect(reconnects).toBe(0);
  });

  it("dedupes concurrent reconnects from parallel failing tool calls", async () => {
    const manager = new FakeMcpManager();
    const deadClient = throwingClient(fakeMcpClient(), () => manager.fail("s"));
    const freshClient = fakeMcpClient();
    let reconnects = 0;
    manager.reconnectHandler = async (name) => {
      reconnects += 1;
      manager.setResolved(name, freshClient, await discoverTools(freshClient));
      manager.connect(name);
    };
    manager.setResolved("s", deadClient, await discoverTools(deadClient));
    createService(manager);
    manager.connect("s");

    const registry = ix.get(IAgentToolRegistryService);
    const echo = registry.resolve("mcp__s__echo");
    const noop = registry.resolve("mcp__s__noop");
    const [echoResult, noopResult] = await Promise.all([
      executeTool(echo!, {
        turnId: 1,
        toolCallId: "tc-par-1",
        args: { text: "one" },
        signal: new AbortController().signal,
      }),
      executeTool(noop!, {
        turnId: 1,
        toolCallId: "tc-par-2",
        args: {},
        signal: new AbortController().signal,
      }),
    ]);

    expect(echoResult.output).toBe("one");
    expect(noopResult.output).toBe("ok");
    expect(reconnects).toBe(1);
  });

  it("keeps the shared reconnect alive when one parallel call is aborted", async () => {
    const manager = new FakeMcpManager();
    const reconnectStarted = deferred<void>();
    const reconnectReleased = deferred<void>();
    const deadClient = throwingClient(fakeMcpClient(), () => manager.fail("s"));
    const freshClient = fakeMcpClient();
    let reconnects = 0;
    manager.reconnectHandler = async (name) => {
      reconnects += 1;
      reconnectStarted.resolve();
      await reconnectReleased.promise;
      manager.setResolved(name, freshClient, await discoverTools(freshClient));
      manager.connect(name);
    };
    manager.setResolved("s", deadClient, await discoverTools(deadClient));
    createService(manager);
    manager.connect("s");

    const registry = ix.get(IAgentToolRegistryService);
    const echo = registry.resolve("mcp__s__echo");
    const noop = registry.resolve("mcp__s__noop");
    const firstController = new AbortController();
    const firstCall = executeTool(echo!, {
      turnId: 1,
      toolCallId: "tc-par-abort-1",
      args: { text: "one" },
      signal: firstController.signal,
    });
    const secondCall = executeTool(noop!, {
      turnId: 1,
      toolCallId: "tc-par-abort-2",
      args: {},
      signal: new AbortController().signal,
    });

    await reconnectStarted.promise;
    firstController.abort(new Error("cancelled by test"));
    await expect(firstCall).rejects.toThrow("cancelled by test");

    reconnectReleased.resolve();
    await expect(secondCall).resolves.toMatchObject({ output: "ok" });
    expect(reconnects).toBe(1);
  });

  it("reconnects and retries when the call fails with a raw transport error the manager did not observe", async () => {
    const manager = new FakeMcpManager();
    const deadClient = throwingClient(
      fakeMcpClient(),
      undefined,
      () => new TypeError("fetch failed"),
    );
    const freshClient = fakeMcpClient();
    let reconnects = 0;
    manager.reconnectHandler = async (name) => {
      reconnects += 1;
      manager.setResolved(name, freshClient, await discoverTools(freshClient));
      manager.connect(name);
    };
    manager.setResolved("s", deadClient, await discoverTools(deadClient));
    createService(manager);
    manager.connect("s");

    const echo = ix.get(IAgentToolRegistryService).resolve("mcp__s__echo");
    const result = await executeTool(echo!, {
      turnId: 1,
      toolCallId: "tc-raw-transport",
      args: { text: "hello again" },
      signal: new AbortController().signal,
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toBe("hello again");
    expect(reconnects).toBe(1);
  });

  it("retries on the healed client without reconnecting again when the server already came back", async () => {
    const manager = new FakeMcpManager();
    const deadClient = throwingClient(
      fakeMcpClient(),
      undefined,
      () => new Error("Not connected"),
    );
    const freshClient = fakeMcpClient();
    let reconnects = 0;
    manager.reconnectHandler = async () => {
      reconnects += 1;
    };
    manager.setResolved("s", deadClient, await discoverTools(deadClient));
    createService(manager);
    manager.connect("s");

    const registry = ix.get(IAgentToolRegistryService);
    const staleEcho = registry.resolve("mcp__s__echo");

    // Resolve the stale tool first, then heal the server the way a parallel
    // call's reconnect would: the resolved entry swaps to a fresh client and
    // the registry re-seeds, leaving `staleEcho` bound to the dead client.
    manager.setResolved("s", freshClient, await discoverTools(freshClient));
    manager.connect("s");

    const result = await executeTool(staleEcho!, {
      turnId: 1,
      toolCallId: "tc-healed",
      args: { text: "late call" },
      signal: new AbortController().signal,
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toBe("late call");
    expect(reconnects).toBe(0);
  });

  it("rethrows a malformed tool result without reconnecting or retrying when the server answered", async () => {
    const manager = new FakeMcpManager();
    const base = fakeMcpClient();
    const malformed = CallToolResultSchema.safeParse({
      content: [{ text: "missing type" }],
    });
    if (malformed.success)
      throw new Error("expected the fixture result to fail validation");
    let calls = 0;
    const client: MCPClient = {
      listTools: () => base.listTools(),
      ping: () => base.ping(),
      async callTool() {
        calls += 1;
        throw malformed.error;
      },
    };
    let reconnects = 0;
    manager.reconnectHandler = async () => {
      reconnects += 1;
    };
    manager.setResolved("s", client, await discoverTools(client));
    createService(manager);
    manager.connect("s");

    const echo = ix.get(IAgentToolRegistryService).resolve("mcp__s__echo");
    await expect(
      executeTool(echo!, {
        turnId: 1,
        toolCallId: "tc-malformed-result",
        args: { text: "hi" },
        signal: new AbortController().signal,
      }),
    ).rejects.toBe(malformed.error);
    expect(calls).toBe(1);
    expect(reconnects).toBe(0);
  });

  it("retries a transient transport failure in place without reconnecting", async () => {
    const manager = new FakeMcpManager();
    const base = fakeMcpClient();
    let calls = 0;
    const flakyClient: MCPClient = {
      listTools: () => base.listTools(),
      ping: () => base.ping(),
      callTool: (name, args, signal) => {
        calls += 1;
        if (calls === 1) return Promise.reject(new TypeError("fetch failed"));
        return base.callTool(name, args, signal);
      },
    };
    let reconnects = 0;
    manager.reconnectHandler = async () => {
      reconnects += 1;
    };
    manager.setResolved("s", flakyClient, await discoverTools(flakyClient));
    createService(manager);
    manager.connect("s");

    const echo = ix.get(IAgentToolRegistryService).resolve("mcp__s__echo");
    const result = await executeTool(echo!, {
      turnId: 1,
      toolCallId: "tc-transient",
      args: { text: "hello again" },
      signal: new AbortController().signal,
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toBe("hello again");
    expect(calls).toBe(2);
    expect(reconnects).toBe(0);
  });

  it("reconnects when the transport failure persists past a successful probe", async () => {
    const manager = new FakeMcpManager();
    const base = fakeMcpClient();
    let calls = 0;
    const deadClient: MCPClient = {
      listTools: () => base.listTools(),
      ping: () => base.ping(),
      async callTool() {
        calls += 1;
        throw new TypeError("fetch failed");
      },
    };
    const freshClient = fakeMcpClient();
    let reconnects = 0;
    manager.reconnectHandler = async (name) => {
      reconnects += 1;
      manager.setResolved(name, freshClient, await discoverTools(freshClient));
      manager.connect(name);
    };
    manager.setResolved("s", deadClient, await discoverTools(deadClient));
    createService(manager);
    manager.connect("s");

    const echo = ix.get(IAgentToolRegistryService).resolve("mcp__s__echo");
    const result = await executeTool(echo!, {
      turnId: 1,
      toolCallId: "tc-persistent-transport",
      args: { text: "hello again" },
      signal: new AbortController().signal,
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toBe("hello again");
    expect(calls).toBe(2);
    expect(reconnects).toBe(1);
  });

  it("abandons the retry when the call is aborted during the liveness probe", async () => {
    const manager = new FakeMcpManager();
    const base = fakeMcpClient();
    const probeStarted = deferred<void>();
    const releaseProbe = deferred<void>();
    const client: MCPClient = {
      listTools: () => base.listTools(),
      async ping() {
        probeStarted.resolve();
        await releaseProbe.promise;
      },
      async callTool() {
        throw new TypeError("fetch failed");
      },
    };
    let reconnects = 0;
    manager.reconnectHandler = async () => {
      reconnects += 1;
    };
    manager.setResolved("s", client, await discoverTools(client));
    createService(manager);
    manager.connect("s");

    const echo = ix.get(IAgentToolRegistryService).resolve("mcp__s__echo");
    const controller = new AbortController();
    const call = executeTool(echo!, {
      turnId: 1,
      toolCallId: "tc-abort-during-probe",
      args: { text: "hi" },
      signal: controller.signal,
    });
    await probeStarted.promise;
    controller.abort(new Error("cancelled by test"));
    releaseProbe.resolve();
    await expect(call).rejects.toThrow("cancelled by test");
    expect(reconnects).toBe(0);
  });

  it("truncates oversized MCP text output through the wrapped tool path", async () => {
    const manager = new FakeMcpManager();
    const client: MCPClient = {
      async listTools() {
        return [
          {
            name: "big",
            description: "Returns a huge text",
            inputSchema: { type: "object", properties: {} },
          },
        ];
      },
      async callTool() {
        return {
          content: [{ type: "text", text: "x".repeat(100_001) }],
          isError: false,
        };
      },
      async ping() {},
    };
    manager.setResolved("s", client, await discoverTools(client));
    createService(manager);
    manager.connect("s");

    const big = ix.get(IAgentToolRegistryService).resolve("mcp__s__big");
    const result = await executeTool(big!, {
      turnId: 1,
      toolCallId: "tc-big-text",
      args: {},
      signal: new AbortController().signal,
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toBe("x".repeat(100_000) + MCP_OUTPUT_TRUNCATED_TEXT);
  });

  it("wraps MCP image output in mcp_tool_result companions through the wrapped tool path", async () => {
    const manager = new FakeMcpManager();
    const client: MCPClient = {
      async listTools() {
        return [
          {
            name: "snap",
            description: "Returns a small image",
            inputSchema: { type: "object", properties: {} },
          },
        ];
      },
      async callTool() {
        return {
          content: [
            { type: "image", data: "x".repeat(100_000), mimeType: "image/png" },
          ],
          isError: false,
        };
      },
      async ping() {},
    };
    manager.setResolved("s", client, await discoverTools(client));
    createService(manager);
    manager.connect("s");

    const snap = ix.get(IAgentToolRegistryService).resolve("mcp__s__snap");
    const result = await executeTool(snap!, {
      turnId: 1,
      toolCallId: "tc-small-image",
      args: {},
      signal: new AbortController().signal,
    });

    expect(result.isError).toBeUndefined();
    expect(Array.isArray(result.output)).toBe(true);
    expect(result.output as ContentPart[]).toEqual([
      { type: "text", text: '<mcp_tool_result name="mcp__s__snap">' },
      {
        type: "image_url",
        imageUrl: { url: "data:image/png;base64," + "x".repeat(100_000) },
      },
      { type: "text", text: "</mcp_tool_result>" },
    ]);
  });

  it("forwards the execution AbortSignal through the wrapped MCP tool", async () => {
    const manager = new FakeMcpManager();
    let receivedSignal: AbortSignal | undefined;
    const client: MCPClient = {
      async listTools() {
        return [
          {
            name: "echo",
            description: "Echoes back",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
            },
          },
        ];
      },
      async callTool(_name, args, signal) {
        receivedSignal = signal;
        return {
          content: [{ type: "text", text: String(args["text"]) }],
          isError: false,
        };
      },
      async ping() {},
    };
    manager.setResolved("s", client, await discoverTools(client));
    createService(manager);
    manager.connect("s");

    const controller = new AbortController();
    const echo = ix.get(IAgentToolRegistryService).resolve("mcp__s__echo");
    await executeTool(echo!, {
      turnId: 1,
      toolCallId: "tc-signal",
      args: { text: "hi" },
      signal: controller.signal,
    });

    expect(receivedSignal).toBe(controller.signal);
  });

  it("registers a synthetic authenticate tool when a server needs auth", () => {
    const oauthService = {
      beginAuthorization: async () => ({
        authorizationUrl: new URL("https://example.com/authorize"),
        complete: async () => {},
        cancel: async () => {},
      }),
    } as unknown as McpOAuthService;
    const manager = new FakeMcpManager({ oauthService });
    createService(manager);

    manager.needsAuth();

    const tools = ix.get(IAgentToolRegistryService).list();
    expect(tools).toEqual([
      expect.objectContaining({
        name: "mcp__needs-auth__authenticate",
        source: "mcp",
      }),
    ]);
  });

  it("keeps tools registered when a connected server fails so later calls can heal", async () => {
    const manager = new FakeMcpManager();
    const client = fakeMcpClient();
    manager.setResolved("s", client, await discoverTools(client));
    createService(manager);

    manager.connect("s");
    manager.fail("s");

    expect(
      ix
        .get(IAgentToolRegistryService)
        .list()
        .filter((tool) => tool.source === "mcp"),
    ).toHaveLength(2);
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: "tool.list.updated",
        reason: "mcp.failed",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "mcp.server.status",
        server: expect.objectContaining({ name: "s", status: "failed" }),
      }),
    );
  });

  it("keeps tools registered while the server is reconnecting", async () => {
    const manager = new FakeMcpManager();
    const client = fakeMcpClient();
    manager.setResolved("s", client, await discoverTools(client));
    createService(manager);

    manager.connect("s");
    manager.pending("s");

    expect(
      ix
        .get(IAgentToolRegistryService)
        .list()
        .filter((tool) => tool.source === "mcp"),
    ).toHaveLength(2);
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: "tool.list.updated",
        reason: "mcp.disconnected",
      }),
    );
  });

  const RAW_QUERY: MCPToolDefinition = {
    name: "query_range",
    description: "Query a metrics range",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  };

  function collectDiscoveries(): {
    records: { type: string; [key: string]: unknown }[];
    off: { dispose(): void };
  } {
    const records: { type: string; [key: string]: unknown }[] = [];
    const listener = (record: WireRecord): void => {
      if (record.type === "mcp.tools_discovered") {
        records.push(record as { type: string; [key: string]: unknown });
      }
    };
    wireRecordListeners.add(listener);
    return {
      records,
      off: toDisposable(() => wireRecordListeners.delete(listener)),
    };
  }

  it("records tools/list once after restore and dedups unchanged reconnects", async () => {
    const manager = new FakeMcpManager();
    const client = fakeMcpClient([RAW_QUERY]);
    const rawTools = await client.listTools();
    manager.setResolved(
      "grafana",
      client,
      await discoverTools(client),
      new Set(["query_range"]),
      rawTools,
    );
    createService(manager);

    const { records, off } = collectDiscoveries();
    try {
      manager.connect("grafana");
      expect(records).toHaveLength(0);
      await wire.restore();
      await wire.flush();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        type: "mcp.tools_discovered",
        serverName: "grafana",
        tools: rawTools,
        enabledNames: ["query_range"],
      });
      expect(records[0]!["collisions"]).toBeUndefined();

      manager.connect("grafana");
      expect(records).toHaveLength(1);

      manager.setResolved(
        "grafana",
        client,
        await discoverTools(client),
        new Set(),
        rawTools,
      );
      manager.connect("grafana");
      await wire.flush();
      expect(records).toHaveLength(2);
    } finally {
      off.dispose();
    }
  });

  it("parks a discovery observed before restore and flushes it after replay", async () => {
    const manager = new FakeMcpManager();
    const client = fakeMcpClient([RAW_QUERY]);
    const rawTools = await client.listTools();
    manager.setResolved(
      "grafana",
      client,
      await discoverTools(client),
      new Set(["query_range"]),
      rawTools,
    );
    createService(manager);

    const { records, off } = collectDiscoveries();
    try {
      manager.connect("grafana");
      expect(records).toHaveLength(0);
      await wire.restore();
      await wire.flush();
      expect(records).toHaveLength(1);
    } finally {
      off.dispose();
    }
  });

  it("snapshots enabledNames when parking a discovery before restore", async () => {
    const manager = new FakeMcpManager();
    const client = fakeMcpClient([RAW_QUERY]);
    const rawTools = await client.listTools();
    const enabledNames = new Set(["query_range"]);
    manager.setResolved(
      "grafana",
      client,
      await discoverTools(client),
      enabledNames,
      rawTools,
    );
    createService(manager);

    const { records, off } = collectDiscoveries();
    try {
      manager.connect("grafana");
      enabledNames.clear();
      enabledNames.add("mutated_after_observation");
      await wire.restore();
      await wire.flush();

      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        type: "mcp.tools_discovered",
        serverName: "grafana",
        tools: rawTools,
        enabledNames: ["query_range"],
      });
    } finally {
      off.dispose();
    }
  });

  it("re-records when only the collision outcome changes", async () => {
    const manager = new FakeMcpManager();
    const occupant = fakeMcpClient([RAW_QUERY]);
    const occupantRaw = await occupant.listTools();
    manager.setResolved(
      "graf.ana",
      occupant,
      await discoverTools(occupant),
      new Set(["query_range"]),
      occupantRaw,
    );
    createService(manager);
    manager.connect("graf.ana");
    await wire.restore();
    await wire.flush();

    const { records, off } = collectDiscoveries();
    try {
      const client = fakeMcpClient([RAW_QUERY]);
      const rawTools = await client.listTools();
      manager.setResolved(
        "graf_ana",
        client,
        await discoverTools(client),
        new Set(["query_range"]),
        rawTools,
      );
      manager.connect("graf_ana");
      await wire.flush();
      expect(records).toHaveLength(1);
      expect(records[0]!["collisions"]).toHaveLength(1);

      manager.disconnect("graf.ana");
      manager.connect("graf_ana");
      await wire.flush();
      expect(records).toHaveLength(2);
      expect(records[1]!["collisions"]).toBeUndefined();
    } finally {
      off.dispose();
    }
  });
});

describe("AgentMcpService + AgentProfileService", () => {
  let ctx: TestAgentContext;
  let manager: FakeMcpManager;
  let profile: IAgentProfileService;

  beforeEach(() => {
    manager = new FakeMcpManager();
    ctx = createTestAgent(
      mcpServices({ manager: manager as unknown as McpConnectionManager }),
    );
    const mcp = ctx.get(IAgentMcpService);
    mcp.list();
    profile = ctx.get(IAgentProfileService);
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it("gates MCP tools by the active profile", async () => {
    const client = fakeMcpClient();
    manager.setResolved("local", client, await discoverTools(client));
    manager.connect("local");

    profile.update({ activeToolNames: ["Read"] });
    expect(
      ctx
        .toolsData()
        .filter((tool) => tool.source === "mcp")
        .map((tool) => ({ name: tool.name, active: tool.active })),
    ).toEqual([
      { name: "mcp__local__echo", active: false },
      { name: "mcp__local__noop", active: false },
    ]);

    profile.update({ activeToolNames: ["Read", "mcp__*"] });
    expect(
      ctx
        .toolsData()
        .filter((tool) => tool.source === "mcp")
        .map((tool) => ({ name: tool.name, active: tool.active })),
    ).toEqual([
      { name: "mcp__local__echo", active: true },
      { name: "mcp__local__noop", active: true },
    ]);
  });

  it("supports server-scoped and exact MCP active-tool patterns", async () => {
    const githubClient = fakeMcpClient();
    const slackClient = fakeMcpClient();
    manager.setResolved(
      "github",
      githubClient,
      await discoverTools(githubClient),
    );
    manager.setResolved("slack", slackClient, await discoverTools(slackClient));
    manager.connect("github");
    manager.connect("slack");

    profile.update({ activeToolNames: ["mcp__github__*"] });
    expect(
      ctx
        .toolsData()
        .filter((tool) => tool.source === "mcp" && tool.active)
        .map((tool) => tool.name)
        .toSorted(),
    ).toEqual(["mcp__github__echo", "mcp__github__noop"]);

    profile.update({ activeToolNames: ["mcp__slack__echo"] });
    expect(
      ctx
        .toolsData()
        .filter((tool) => tool.source === "mcp" && tool.active)
        .map((tool) => tool.name),
    ).toEqual(["mcp__slack__echo"]);
  });
});

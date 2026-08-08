import type { ToolCall, ToolDefinition, ToolResult } from "@kimi-next/ir";

import { createMcpClient, type McpClient, type McpClientOptions } from "./mcp";
import {
  loadMcpStdioServers,
  type McpStdioServer,
  prefixMcpToolName,
} from "./plugins";

export interface McpToolExecutor {
  execute(call: ToolCall, generateId: () => string): Promise<ToolResult>;
  definitions(): readonly ToolDefinition[];
  close(): Promise<void>;
}

export interface McpToolBridgeOptions extends McpClientOptions {
  readonly createClient?: (
    server: McpStdioServer,
    options?: McpClientOptions,
  ) => McpClient;
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Turn malformed model arguments into a normal tool error.
  }
  throw new Error("MCP tool arguments must be a JSON object");
}

export async function createMcpToolBridge(
  servers: readonly McpStdioServer[],
  options?: McpToolBridgeOptions,
): Promise<McpToolExecutor> {
  const makeClient = options?.createClient ?? createMcpClient;
  const clients = new Map<string, McpClient>();
  const routes = new Map<string, { client: McpClient; toolName: string }>();
  const definitions: ToolDefinition[] = [];

  try {
    for (const server of servers) {
      const client = makeClient(server, options);
      clients.set(server.id, client);
      for (const tool of await client.listTools()) {
        const name = prefixMcpToolName(server.id, tool.name);
        routes.set(name, { client, toolName: tool.name });
        definitions.push({
          name,
          description: tool.description ?? `MCP tool ${tool.name}`,
          parameters: tool.inputSchema,
        });
      }
    }
  } catch (error) {
    await Promise.all([...clients.values()].map((client) => client.close()));
    throw error;
  }

  return {
    definitions() {
      return definitions;
    },
    async execute(call, generateId) {
      try {
        const route = routes.get(call.name);
        if (!route) throw new Error(`Unknown MCP tool: ${call.name}`);
        const result = await route.client.callTool(
          route.toolName,
          parseArguments(call.arguments),
        );
        return {
          kind: "tool_result",
          id: generateId(),
          callId: call.id,
          content: result.content,
          isError: result.isError,
        };
      } catch (error) {
        return {
          kind: "tool_result",
          id: generateId(),
          callId: call.id,
          content: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }
    },
    async close() {
      await Promise.all([...clients.values()].map((client) => client.close()));
    },
  };
}

/** Discover stdio MCP servers from plugin roots and expose their tools. */
export async function createMcpToolBridgeFromPluginRoots(
  pluginRoots: readonly string[],
  options?: McpToolBridgeOptions,
): Promise<McpToolExecutor> {
  const serverGroups = await Promise.all(
    pluginRoots.map((root) => loadMcpStdioServers(root)),
  );
  return createMcpToolBridge(serverGroups.flat(), options);
}

import type { ToolCall, ToolDefinition, ToolResult } from "@kimi-next/ir";

import { createMcpClient, type McpClient, type McpClientOptions } from "./mcp";
import {
  loadMcpStdioServers,
  type McpStdioServer,
  prefixMcpToolName,
} from "./plugins";

/** Minimal JSON Schema so the model sees the tool name without full arg schemas. */
const CATALOG_PARAMETERS: Record<string, unknown> = {
  type: "object",
  additionalProperties: true,
};

export const MCP_LIST_TOOL = "mcp_list";
export const MCP_SCHEMA_TOOL = "mcp_schema";

export interface McpToolExecutor {
  execute(call: ToolCall, generateId: () => string): Promise<ToolResult>;
  /** Tool defs for the LLM — catalog stubs + mcp_list/mcp_schema, not full schemas. */
  definitions(): readonly ToolDefinition[];
  /** Full input schemas keyed by prefixed tool name (for receipts / mcp_schema). */
  fullSchemas(): ReadonlyMap<string, Record<string, unknown>>;
  close(): Promise<void>;
}

export interface McpToolBridgeOptions extends McpClientOptions {
  readonly createClient?: (
    server: McpStdioServer,
    options?: McpClientOptions,
  ) => McpClient;
  /**
   * When true (default), LLM-facing definitions use stub parameters.
   * Full schemas stay available via mcp_schema / fullSchemas().
   */
  readonly deferSchemas?: boolean;
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

function catalogDefinition(
  name: string,
  description: string,
  deferSchemas: boolean,
  fullSchema: Record<string, unknown>,
): ToolDefinition {
  return {
    name,
    description,
    parameters: deferSchemas ? CATALOG_PARAMETERS : fullSchema,
  };
}

export async function createMcpToolBridge(
  servers: readonly McpStdioServer[],
  options?: McpToolBridgeOptions,
): Promise<McpToolExecutor> {
  const makeClient = options?.createClient ?? createMcpClient;
  const deferSchemas = options?.deferSchemas !== false;
  const clients = new Map<string, McpClient>();
  const routes = new Map<string, { client: McpClient; toolName: string }>();
  const schemaByName = new Map<string, Record<string, unknown>>();
  const catalog: ToolDefinition[] = [];

  try {
    for (const server of servers) {
      const client = makeClient(server, options);
      clients.set(server.id, client);
      for (const tool of await client.listTools()) {
        const name = prefixMcpToolName(server.id, tool.name);
        routes.set(name, { client, toolName: tool.name });
        schemaByName.set(name, tool.inputSchema);
        catalog.push(
          catalogDefinition(
            name,
            tool.description ?? `MCP tool ${tool.name}`,
            deferSchemas,
            tool.inputSchema,
          ),
        );
      }
    }
  } catch (error) {
    await Promise.all([...clients.values()].map((client) => client.close()));
    throw error;
  }

  const metaTools: ToolDefinition[] =
    deferSchemas && catalog.length > 0
      ? [
          {
            name: MCP_LIST_TOOL,
            description:
              "List available MCP tools (names + short descriptions). Call mcp_schema before first use of a tool to load its full argument schema.",
            parameters: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
          {
            name: MCP_SCHEMA_TOOL,
            description:
              "Load the full JSON Schema for one MCP tool by prefixed name (mcp:server:tool).",
            parameters: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  description: "Prefixed MCP tool name",
                },
              },
              required: ["name"],
              additionalProperties: false,
            },
          },
        ]
      : [];

  const definitions = [...metaTools, ...catalog];

  return {
    definitions() {
      return definitions;
    },
    fullSchemas() {
      return schemaByName;
    },
    async execute(call, generateId) {
      try {
        if (call.name === MCP_LIST_TOOL) {
          const lines = catalog.map(
            (tool) => `- ${tool.name}: ${tool.description}`,
          );
          return {
            kind: "tool_result",
            id: generateId(),
            callId: call.id,
            content:
              lines.length > 0
                ? ["MCP tools:", ...lines].join("\n")
                : "No MCP tools available.",
            isError: false,
          };
        }
        if (call.name === MCP_SCHEMA_TOOL) {
          const args = parseArguments(call.arguments);
          const name = args["name"];
          if (typeof name !== "string" || name.length === 0) {
            throw new Error("mcp_schema requires { \"name\": \"mcp:server:tool\" }");
          }
          const schema = schemaByName.get(name);
          if (!schema) throw new Error(`Unknown MCP tool: ${name}`);
          return {
            kind: "tool_result",
            id: generateId(),
            callId: call.id,
            content: JSON.stringify({ name, parameters: schema }, null, 2),
            isError: false,
          };
        }
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

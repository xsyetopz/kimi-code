import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { Transport } from "@modelcontextprotocol/client";

import type { McpStdioServer } from "./plugins";

export interface McpTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface McpClient {
  listTools(): Promise<McpTool[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content: string; isError: boolean }>;
  close(): Promise<void>;
}

export interface McpClientOptions {
  /**
   * Injectable transport factory for tests and hosts with a custom stdio
   * process launcher. Production uses the official MCP stdio transport.
   */
  readonly createTransport?: (server: McpStdioServer) => Transport;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    return content === undefined ? "" : JSON.stringify(content);
  }
  return content
    .map((part) => {
      const record = asRecord(part);
      return record?.["type"] === "text" && typeof record["text"] === "string"
        ? record["text"]
        : JSON.stringify(part);
    })
    .join("");
}

export function createMcpClient(
  server: McpStdioServer,
  options?: McpClientOptions,
): McpClient {
  const transport =
    options?.createTransport?.(server) ??
    new StdioClientTransport({
      command: server.command,
      args: [...server.args],
      cwd: server.cwd,
      env: { ...server.env },
      stderr: "pipe",
    });
  const client = new Client({ name: "kimi-next", version: "0.1.0" });
  let connected: Promise<void> | undefined;
  let closed = false;

  const ensureConnected = (): Promise<void> => {
    connected ??= client.connect(transport);
    return connected;
  };

  return {
    async listTools() {
      await ensureConnected();
      const result = await client.listTools();
      return result.tools.map((tool) => {
        const parsed: McpTool = {
          name: tool.name,
          inputSchema: asRecord(tool.inputSchema) ?? { type: "object" },
        };
        if (tool.description !== undefined) {
          return { ...parsed, description: tool.description };
        }
        return parsed;
      });
    },
    async callTool(name, args) {
      await ensureConnected();
      const result = await client.callTool({ name, arguments: args });
      return {
        content: contentToText(result.content),
        isError: result.isError === true,
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      await client.close();
    },
  };
}

export function createMcpClientStub(serverId: string): McpClient {
  return {
    async listTools() {
      return [];
    },
    async callTool(name) {
      return {
        content: `MCP server ${serverId} not connected (stub); tool=${name}`,
        isError: true,
      };
    },
    async close() {},
  };
}

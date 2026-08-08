import type { SpawnOptions } from "node:child_process";
import { spawn as spawnProcess } from "node:child_process";

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

interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

interface SpawnedMcpProcess {
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr?: NodeJS.ReadableStream;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: (code: number | null) => void): this;
}

export interface McpClientOptions {
  /** Injectable for transport tests; production uses node:child_process.spawn. */
  readonly spawn?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => SpawnedMcpProcess;
}

/**
 * MCP stdio framing uses the protocol's Content-Length header:
 * `Content-Length: <UTF-8 byte length>\\r\\n\\r\\n<JSON>`.
 */
export function encodeMcpFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "ascii"),
    body,
  ]);
}

export class McpFrameParser {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer | string): unknown[] {
    this.buffer = Buffer.concat([
      this.buffer,
      typeof chunk === "string" ? Buffer.from(chunk) : chunk,
    ]);
    const messages: unknown[] = [];
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return messages;
      const headers = this.buffer.subarray(0, headerEnd).toString("ascii");
      const lengthHeader = headers
        .split("\r\n")
        .find((header) => /^content-length:/i.test(header));
      const length = lengthHeader
        ? Number.parseInt(
            lengthHeader.slice(lengthHeader.indexOf(":") + 1).trim(),
            10,
          )
        : Number.NaN;
      if (!Number.isSafeInteger(length) || length < 0) {
        throw new Error("Invalid MCP Content-Length header");
      }
      const bodyStart = headerEnd + 4;
      if (this.buffer.byteLength < bodyStart + length) return messages;
      const body = this.buffer.subarray(bodyStart, bodyStart + length);
      this.buffer = this.buffer.subarray(bodyStart + length);
      messages.push(JSON.parse(body.toString("utf8")) as unknown);
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function resultOrThrow(response: JsonRpcResponse): Record<string, unknown> {
  if (response.error) {
    throw new Error(
      `MCP JSON-RPC ${response.error.code}: ${response.error.message}`,
    );
  }
  const result = asRecord(response.result);
  if (!result) throw new Error("MCP response has no result");
  return result;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content))
    return content === undefined ? "" : JSON.stringify(content);
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
  const spawn =
    options?.spawn ??
    ((command, args, spawnOptions) =>
      spawnProcess(
        command,
        [...args],
        spawnOptions,
      ) as unknown as SpawnedMcpProcess);
  const child = spawn(server.command, server.args, {
    cwd: server.cwd,
    env: { ...process.env, ...server.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const parser = new McpFrameParser();
  const pending = new Map<
    number,
    {
      resolve: (response: JsonRpcResponse) => void;
      reject: (error: Error) => void;
    }
  >();
  let nextId = 1;
  let initialized: Promise<void> | undefined;
  let closed = false;

  const failPending = (error: Error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };

  child.stdout.on("data", (chunk: Buffer | string) => {
    try {
      for (const message of parser.push(chunk)) {
        const response = asRecord(message) as JsonRpcResponse | null;
        if (!response || typeof response["id"] !== "number") continue;
        const request = pending.get(response.id);
        if (!request) continue;
        pending.delete(response.id);
        request.resolve(response);
      }
    } catch (error) {
      failPending(error instanceof Error ? error : new Error(String(error)));
    }
  });
  child.stderr?.on("data", () => {
    // MCP servers must keep protocol messages on stdout; stderr is diagnostic.
  });
  child.on("error", (error) => failPending(error));
  child.on("close", () => {
    closed = true;
    failPending(new Error(`MCP server "${server.id}" exited`));
  });

  const notify = (method: string, params: Record<string, unknown>) => {
    if (closed) throw new Error(`MCP server "${server.id}" is closed`);
    child.stdin.write(encodeMcpFrame({ jsonrpc: "2.0", method, params }));
  };

  const request = (method: string, params: Record<string, unknown>) =>
    new Promise<JsonRpcResponse>((resolve, reject) => {
      if (closed) {
        reject(new Error(`MCP server "${server.id}" is closed`));
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve, reject });
      try {
        child.stdin.write(
          encodeMcpFrame({ jsonrpc: "2.0", id, method, params }),
        );
      } catch (error) {
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

  const ensureInitialized = (): Promise<void> => {
    initialized ??= request("initialize", {
      protocolVersion: "2026-07-28",
      capabilities: {},
      clientInfo: { name: "kimi-next", version: "0.1.0" },
    }).then(() => {
      notify("notifications/initialized", {});
    });
    return initialized;
  };

  return {
    async listTools() {
      await ensureInitialized();
      const result = resultOrThrow(await request("tools/list", {}));
      if (!Array.isArray(result["tools"])) return [];
      return result["tools"].flatMap((tool): McpTool[] => {
        const record = asRecord(tool);
        if (!record || typeof record["name"] !== "string") return [];
        const parsed: McpTool = {
          name: record["name"],
          inputSchema: asRecord(record["inputSchema"]) ?? { type: "object" },
        };
        if (typeof record["description"] === "string") {
          return [{ ...parsed, description: record["description"] }];
        }
        return [parsed];
      });
    },
    async callTool(name, args) {
      await ensureInitialized();
      const result = resultOrThrow(
        await request("tools/call", {
          name,
          arguments: args,
        }),
      );
      return {
        content: contentToText(result["content"]),
        isError: result["isError"] === true,
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      failPending(new Error(`MCP server "${server.id}" closed`));
      child.kill("SIGTERM");
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

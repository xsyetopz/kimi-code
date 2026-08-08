import { describe, expect, it } from "vitest";
import {
  createMcpClientStub,
  createMcpToolBridge,
  encodeMcpFrame,
  type McpClient,
  McpFrameParser,
  prefixMcpToolName,
} from "../src/index";

describe("ext seams", () => {
  it("prefixes mcp tool names", () => {
    expect(prefixMcpToolName("fs", "read")).toBe("mcp:fs:read");
  });

  it("mcp stub returns error for calls", async () => {
    const client = createMcpClientStub("demo");
    const result = await client.callTool("x", {});
    expect(result.isError).toBe(true);
    await client.close();
  });

  it("parses content-length frames split across chunks", () => {
    const parser = new McpFrameParser();
    const frame = encodeMcpFrame({
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true },
    });
    expect(parser.push(frame.subarray(0, 12))).toEqual([]);
    expect(parser.push(frame.subarray(12))).toEqual([
      { jsonrpc: "2.0", id: 1, result: { ok: true } },
    ]);
  });

  it("routes prefixed tool calls to the matching server", async () => {
    const calls: string[] = [];
    const client: McpClient = {
      async listTools() {
        return [
          {
            name: "echo",
            description: "Echo",
            inputSchema: { type: "object" },
          },
        ];
      },
      async callTool(name, args) {
        calls.push(`${name}:${String(args["value"])}`);
        return { content: "done", isError: false };
      },
      async close() {},
    };
    const bridge = await createMcpToolBridge(
      [{ id: "demo", command: "unused", args: [], env: {}, cwd: "." }],
      { createClient: () => client },
    );
    const [definition] = bridge.definitions();
    expect(definition?.name).toBe("mcp:demo:echo");
    const result = await bridge.execute(
      { id: "call-1", name: "mcp:demo:echo", arguments: '{"value":"x"}' },
      () => "result-1",
    );
    expect(result.content).toBe("done");
    expect(calls).toEqual(["echo:x"]);
    await bridge.close();
  });
});

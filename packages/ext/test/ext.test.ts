import { describe, expect, it } from "vitest";
import {
  createMcpClientStub,
  createMcpToolBridge,
  MCP_LIST_TOOL,
  MCP_SCHEMA_TOOL,
  type McpClient,
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

  it("defers full schemas and exposes mcp_list / mcp_schema", async () => {
    const fullSchema = {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    };
    const client: McpClient = {
      async listTools() {
        return [
          {
            name: "echo",
            description: "Echo",
            inputSchema: fullSchema,
          },
        ];
      },
      async callTool(_name, args) {
        return { content: `echo:${String(args["value"])}`, isError: false };
      },
      async close() {},
    };
    const bridge = await createMcpToolBridge(
      [{ id: "demo", command: "unused", args: [], env: {}, cwd: "." }],
      { createClient: () => client },
    );
    const names = bridge.definitions().map((definition) => definition.name);
    expect(names).toEqual([MCP_LIST_TOOL, MCP_SCHEMA_TOOL, "mcp:demo:echo"]);
    const echo = bridge.definitions().find((definition) => definition.name === "mcp:demo:echo");
    expect(echo?.parameters).toEqual({
      type: "object",
      additionalProperties: true,
    });
    expect(bridge.fullSchemas().get("mcp:demo:echo")).toEqual(fullSchema);

    const listed = await bridge.execute(
      { id: "c1", name: MCP_LIST_TOOL, arguments: "{}" },
      () => "r1",
    );
    expect(listed.content).toContain("mcp:demo:echo");

    const schema = await bridge.execute(
      {
        id: "c2",
        name: MCP_SCHEMA_TOOL,
        arguments: JSON.stringify({ name: "mcp:demo:echo" }),
      },
      () => "r2",
    );
    expect(schema.content).toContain('"value"');

    const result = await bridge.execute(
      { id: "c3", name: "mcp:demo:echo", arguments: '{"value":"x"}' },
      () => "r3",
    );
    expect(result.content).toBe("echo:x");
    await bridge.close();
  });
});

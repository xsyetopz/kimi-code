import { ContentBlockSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ContentPart } from "#/kosong/contract/message";
import { Jimp } from "jimp";
import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  convertMCPContentBlock,
  mcpResultToExecutableOutput,
} from "#/agent/mcp/output";
import { createMcpTool } from "#/agent/mcp/tools/mcp";
import type {
  MCPClient,
  MCPContentBlock,
  MCPToolResult,
} from "#/mcpCore/types";
import type { ToolExecution } from "#/tool/toolContract";
      await new Jimp({
        width: 3600,
        height: 1800,
        color: 0x3366ccff,
      }).getBuffer("image/png"),
    ).toString("base64");

    const out = await mcpResultToExecutableOutput(
      result([{ type: "image", data: big, mimeType: "image/png" }]),
      "mcp__s__shot",
    );

    const parts = out.output as ContentPart[];
    const imagePart = parts.find((p) => p.type === "image_url");
    expect(imagePart).toBeDefined();
    const match = /^data:(image\/[a-z]+);base64,(.+)$/.exec(
      (imagePart as { imageUrl: { url: string } }).imageUrl.url,
    );
    expect(match).not.toBeNull();
    const dims = sniffImageDimensions(Buffer.from(match![2]!, "base64"));
    expect(Math.max(dims!.width, dims!.height)).toBeLessThanOrEqual(3000);
    const joined = parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    expect(joined).not.toContain("image_url dropped");
  });

  test("annotates a downsampled image with a caption and a readable original", async () => {
    const bigBytes = Buffer.from(
      await new Jimp({
        width: 3600,
        height: 1800,
        color: 0x3366ccff,
      }).getBuffer("image/png"),
    );

    const out = await mcpResultToExecutableOutput(
      result([
        {
          type: "image",
          data: bigBytes.toString("base64"),
          mimeType: "image/png",
        },
      ]),
      "mcp__s__shot",
    );

    const parts = out.output as ContentPart[];
    const caption = out.note;
    expect(caption).toContain("Image compressed");
    expect(caption).toContain("3600x1800");
    expect(parts.some((p) => p.type === "image_url")).toBe(true);

    const pathMatch = /saved at "([^"]+)"/.exec(caption!);
    expect(pathMatch).not.toBeNull();
    const persisted = await readFile(pathMatch![1]!);
    expect(persisted.equals(bigBytes)).toBe(true);
    await unlink(pathMatch![1]!).catch(() => undefined);
  });

  test("adds no caption for an image that passes through unchanged", async () => {
    const small = Buffer.from(
      await new Jimp({ width: 32, height: 32, color: 0x3366ccff }).getBuffer(
        "image/png",
      ),
    ).toString("base64");

    const out = await mcpResultToExecutableOutput(
      result([{ type: "image", data: small, mimeType: "image/png" }]),
      "mcp__s__shot",
    );

    expect(out.note).toBeUndefined();
  });

    const big = Buffer.from(
      await new Jimp({
        width: 3600,
        height: 1800,
        color: 0x3366ccff,
      }).getBuffer("image/png"),
    ).toString("base64");

    await mcpResultToExecutableOutput(
      result([{ type: "image", data: big, mimeType: "image/png" }]),
      "mcp__s__shot",
      {},
    );

    const events = records.filter(
      (record) => record.event === "image_compress",
    );
    expect(events).toHaveLength(1);
    const properties = events[0]!.properties;
    expect(properties).toEqual(
      expect.objectContaining({
        source: "mcp_tool_result",
        outcome: "compressed",
        input_mime: "image/png",
        output_mime: "image/png",
        original_width: 3600,
        original_height: 1800,
        exif_transposed: false,
      }),
    );
    expect(properties?.["final_width"]).toBeLessThanOrEqual(3000);
    expect(properties?.["final_height"]).toBeLessThanOrEqual(3000);
    expect(properties?.["duration_ms"]).toEqual(expect.any(Number));
  });

  test("persists originals into the provided session originals dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-originals-"));
    const bigBytes = Buffer.from(
      await new Jimp({
        width: 3600,
        height: 1800,
        color: 0x3366ccff,
      }).getBuffer("image/png"),
    );

    const out = await mcpResultToExecutableOutput(
      result([
        {
          type: "image",
          data: bigBytes.toString("base64"),
          mimeType: "image/png",
        },
      ]),
      "mcp__s__shot",
      { originalsDir: dir },
    );

    const caption = out.note;
    expect(caption).toContain("Image compressed");
    const pathMatch = /saved at "([^"]+)"/.exec(caption!);
    expect(pathMatch).not.toBeNull();
    expect(pathMatch![1]!.startsWith(dir)).toBe(true);
    const persisted = await readFile(pathMatch![1]!);
    expect(persisted.equals(bigBytes)).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  test("keeps the caption intact when the tool text exhausts the 100K budget", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-originals-"));
    const big = Buffer.from(
      await new Jimp({
        width: 3600,
        height: 1800,
        color: 0x3366ccff,
      }).getBuffer("image/png"),
    ).toString("base64");

    const out = await mcpResultToExecutableOutput(
      result([
        { type: "text", text: "x".repeat(100_001) },
        { type: "image", data: big, mimeType: "image/png" },
      ]),
      "mcp__s__shot",
      { originalsDir: dir },
    );

    const parts = out.output as ContentPart[];
    expect(out.truncated).toBe(true);
    expect(parts.some((p) => p.type === "image_url")).toBe(true);
    const toolText = parts[0];
    if (toolText?.type !== "text")
      throw new Error("expected the tool text part first");
    expect(toolText.text).toContain("Output truncated");
    expect(out.note).toMatch(/<\/system>$/);
    expect(out.note).toContain("saved at");
    await rm(dir, { recursive: true, force: true });
  });

  test("does not slice the caption when the budget is nearly exhausted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-originals-"));
    const big = Buffer.from(
      await new Jimp({
        width: 3600,
        height: 1800,
        color: 0x3366ccff,
      }).getBuffer("image/png"),
    ).toString("base64");

    const out = await mcpResultToExecutableOutput(
      result([
        { type: "text", text: "y".repeat(99_900) },
        { type: "image", data: big, mimeType: "image/png" },
      ]),
      "mcp__s__shot",
      { originalsDir: dir },
    );

    expect(out.truncated).toBeUndefined();
    expect(out.note).toMatch(/^<system>Image compressed/);
    expect(out.note).toMatch(/<\/system>$/);
    expect(out.note).toContain("saved at");
    const parts = out.output as ContentPart[];
    const joined = parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    expect(joined).not.toContain("Output truncated");
    await rm(dir, { recursive: true, force: true });
  });
});

describe("createMcpTool", () => {
  test("omits truncated when the MCP output was not truncated", async () => {
    const client = {
      async listTools() {
        return [];
      },
      async callTool() {
        return { content: [{ type: "text", text: "ok" }], isError: false };
      },
      async ping() {},
    } satisfies MCPClient;
    const tool = createMcpTool(
      "mcp__server__tool",
      { name: "tool", description: "Tool", parameters: {} },
      client,
    );
    const resolved = tool.resolveExecution({});
    const execution = isPromiseLike(resolved) ? await resolved : resolved;
    if (execution.isError === true)
      throw new Error("expected executable tool call");

    const result = await execution.execute({
      turnId: 1,
      toolCallId: "call_mcp",
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ output: "ok" });
    expect(result).not.toHaveProperty("truncated");
  });
});

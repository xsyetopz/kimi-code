import { openAiChatAdapter } from "@kimi-next/adapters";
import type { ToolCall, ToolResult } from "@kimi-next/ir";
import { resolveModel } from "@kimi-next/model";
import { describe, expect, it } from "vitest";
import {
  createBuiltinToolExecutor,
  createYoloPermissionGate,
  runAgentTurn,
} from "../src/index";

async function* fakeStream(): AsyncIterable<unknown> {
  yield {
    choices: [
      {
        delta: { content: "Done." },
        finish_reason: "stop",
      },
    ],
  };
}

describe("agent loop", () => {
  it("completes a text-only turn without tools", async () => {
    const profile = resolveModel("openai/gpt-4.1-mini");
    const events: string[] = [];
    const result = await runAgentTurn([], "hello", {
      profile,
      adapter: openAiChatAdapter,
      tools: [],
      toolExecutor: createBuiltinToolExecutor(process.cwd()),
      permission: createYoloPermissionGate(),
      permissionMode: "yolo",
      generateId: (() => {
        let n = 0;
        return () => `id-${++n}`;
      })(),
      stream: () => fakeStream(),
      onEvent: (e) => events.push(e.type),
    });
    expect(result.conversation.some((r) => r.kind === "user")).toBe(true);
    expect(result.conversation.some((r) => r.kind === "assistant")).toBe(true);
    expect(events).toContain("assistant");
  });

  it("runs hooks around tools and honors modified arguments", async () => {
    const profile = resolveModel("openai/gpt-4.1-mini");
    let streamCount = 0;
    let executedArguments = "";
    const hooks: string[] = [];
    const result: ToolResult = {
      kind: "tool_result",
      id: "result-1",
      callId: "call-1",
      content: "file",
      isError: false,
    };
    const toolExecutor = {
      definitions: () => [
        {
          name: "read",
          description: "read",
          parameters: { type: "object" },
        },
      ],
      execute: async (call: ToolCall) => {
        executedArguments = call.arguments;
        return result;
      },
    };
    const stream = () => {
      streamCount += 1;
      if (streamCount === 1) {
        return (async function* (): AsyncIterable<unknown> {
          yield {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-1",
                      function: { name: "read", arguments: "{}" },
                    },
                  ],
                },
              },
            ],
          };
          yield { choices: [{ finish_reason: "tool_calls" }] };
        })();
      }
      return fakeStream();
    };
    await runAgentTurn([], "hello", {
      profile,
      adapter: openAiChatAdapter,
      tools: toolExecutor.definitions(),
      toolExecutor,
      permission: createYoloPermissionGate(),
      permissionMode: "yolo",
      generateId: () => "generated",
      stream,
      hooks: {
        sessionStart: () => void hooks.push("start"),
        userPromptSubmit: () => void hooks.push("prompt"),
        preToolUse: () => {
          hooks.push("pre");
          return { action: "modify", arguments: '{"path":"changed"}' };
        },
        postToolUse: () => void hooks.push("post"),
      },
    });
    expect(executedArguments).toBe('{"path":"changed"}');
    expect(hooks).toEqual(["start", "prompt", "pre", "post"]);
  });
});

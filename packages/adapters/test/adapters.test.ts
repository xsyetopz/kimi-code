import { describe, expect, it } from "vitest";
import {
  applyStreamEvent,
  assembleAssistantTurn,
  createTurnAssembler,
  type Conversation,
} from "@kimi-next/ir";
import {
  anthropicAdapter,
  classifyError,
  collectStreamEvents,
  decodeAnthropicSseLine,
  decodeGeminiSseLine,
  decodeOpenAiChatSseLine,
  decodeOpenAiResponsesSseLine,
  geminiAdapter,
  openAiChatAdapter,
  openAiResponsesAdapter,
  AdapterHttpError,
} from "../src/index";

function eventsFrom<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) {
        yield item;
      }
    },
  };
}

describe("openAiChatAdapter", () => {
  const conversation: Conversation = [
    { kind: "user", id: "u1", content: [{ type: "text", text: "Hello" }] },
  ];

  it("serializes conversation to OpenAI chat messages", () => {
    const body = openAiChatAdapter.serialize({
      model: "gpt-4.1-mini",
      conversation,
      system: "You are helpful.",
      tools: [
        {
          name: "read",
          description: "Read a file",
          parameters: { type: "object", properties: {} },
        },
      ],
      parameters: { temperature: 0.5 },
    }) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      tools: unknown[];
      temperature: number;
      stream: boolean;
    };

    expect(body.model).toBe("gpt-4.1-mini");
    expect(body.stream).toBe(true);
    expect(body.temperature).toBe(0.5);
    expect(body.messages[0]).toEqual({
      role: "system",
      content: "You are helpful.",
    });
    expect(body.messages[1]).toEqual({ role: "user", content: "Hello" });
    expect(body.tools).toHaveLength(1);
  });

  it("serializes prompt_cache_key from parameters.cacheKey", () => {
    const body = openAiChatAdapter.serialize({
      model: "gpt-4.1-mini",
      conversation,
      parameters: { cacheKey: "session-abc" },
    }) as { prompt_cache_key?: string };

    expect(body.prompt_cache_key).toBe("session-abc");
  });

  it("prefers promptCacheKey over parameters.cacheKey", () => {
    const body = openAiChatAdapter.serialize({
      model: "gpt-4.1-mini",
      conversation,
      promptCacheKey: "adapter-key",
      parameters: { cacheKey: "params-key" },
    }) as { prompt_cache_key?: string };

    expect(body.prompt_cache_key).toBe("adapter-key");
  });

  it("preserves assistant provider state on serialize", () => {
    const withAssistant: Conversation = [
      {
        kind: "assistant",
        id: "a1",
        text: ["Hi"],
        reasoning: { mode: "none" },
        toolCalls: [],
        preserved: {
          rawProviderMessage: { refusal: null, audio: null },
        },
      },
    ];

    const body = openAiChatAdapter.serialize({
      model: "gpt-4.1-mini",
      conversation: withAssistant,
    }) as { messages: Array<Record<string, unknown>> };

    expect(body.messages[0]?.["refusal"]).toBe(null);
    expect(body.messages[0]?.["audio"]).toBe(null);
  });

  it("decodes text and tool call stream events", async () => {
    const chunks = [
      {
        choices: [{ delta: { content: "Hello" } }],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", function: { name: "read" } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '{"path":' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }],
            },
          },
        ],
      },
      { choices: [{ finish_reason: "tool_calls" }] },
      {
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
    ];

    const events = await collectStreamEvents(
      openAiChatAdapter.decodeStream(eventsFrom(chunks)),
    );

    expect(events.map((e) => e.type)).toEqual([
      "response.start",
      "text.start",
      "text.delta",
      "tool.start",
      "tool.arguments.delta",
      "tool.arguments.delta",
      "text.end",
      "tool.end",
      "usage",
      "response.end",
    ]);

    const state = createTurnAssembler();
    for (const event of events) {
      applyStreamEvent(state, event);
    }
    const turn = assembleAssistantTurn(state, "asst-1");
    expect(turn.text).toEqual(["Hello"]);
    expect(turn.toolCalls).toEqual([
      { id: "call_1", name: "read", arguments: '{"path":"a.ts"}' },
    ]);
  });

  it("decodes cached input tokens from usage", async () => {
    const events = await collectStreamEvents(
      openAiChatAdapter.decodeStream(
        eventsFrom([
          { choices: [{ delta: { content: "Hi" } }] },
          {
            usage: {
              prompt_tokens: 100,
              completion_tokens: 10,
              prompt_tokens_details: { cached_tokens: 80 },
            },
          },
        ]),
      ),
    );

    const usage = events.find((e) => e.type === "usage");
    expect(usage).toEqual({
      type: "usage",
      inputTokens: 100,
      outputTokens: 10,
      cachedInputTokens: 80,
    });
  });

  it("parses SSE lines", () => {
    expect(decodeOpenAiChatSseLine('data: {"id":"1"}')).toEqual({ id: "1" });
    expect(decodeOpenAiChatSseLine("data: [DONE]")).toEqual({ done: true });
    expect(decodeOpenAiChatSseLine("event: ping")).toBeNull();
  });
});

describe("anthropicAdapter", () => {
  const conversation: Conversation = [
    { kind: "user", id: "u1", content: [{ type: "text", text: "Hi" }] },
    {
      kind: "assistant",
      id: "a1",
      text: ["Sure"],
      reasoning: { mode: "exposed", text: "thinking..." },
      toolCalls: [{ id: "tu_1", name: "bash", arguments: '{"cmd":"ls"}' }],
      preserved: {},
    },
    {
      kind: "tool_result",
      id: "r1",
      callId: "tu_1",
      content: "file.txt",
      isError: false,
    },
  ];

  it("serializes to Anthropic messages API shape", () => {
    const body = anthropicAdapter.serialize({
      model: "claude-sonnet-4-20250514",
      conversation,
      system: "Be concise.",
      parameters: { maxOutputTokens: 1024 },
    }) as {
      model: string;
      system: string;
      max_tokens: number;
      messages: Array<{ role: string; content: unknown }>;
      stream: boolean;
    };

    expect(body.model).toBe("claude-sonnet-4-20250514");
    expect(body.system).toBe("Be concise.");
    expect(body.max_tokens).toBe(1024);
    expect(body.stream).toBe(true);
    expect(body.messages).toHaveLength(3);
    expect(body.messages[0]?.role).toBe("user");
    expect(body.messages[1]?.role).toBe("assistant");
    expect(body.messages[2]?.role).toBe("user");
  });

  it("decodes content_block_delta text and tool events", async () => {
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 8 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_1", name: "grep" },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"pattern":' },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '"foo"}' },
      },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", usage: { output_tokens: 4 } },
      { type: "message_stop" },
    ];

    const decoded = await collectStreamEvents(
      anthropicAdapter.decodeStream(eventsFrom(events)),
    );

    expect(decoded.some((e) => e.type === "text.delta" && e.text === "Hello")).toBe(
      true,
    );
    expect(
      decoded.some(
        (e) =>
          e.type === "tool.arguments.delta" &&
          e.id === "toolu_1" &&
          e.argumentsDelta === '{"pattern":',
      ),
    ).toBe(true);
    expect(decoded.some((e) => e.type === "response.end")).toBe(true);
  });

  it("parses SSE lines", () => {
    expect(
      decodeAnthropicSseLine('data: {"type":"message_start"}'),
    ).toEqual({ type: "message_start" });
  });
});

describe("openAiResponsesAdapter", () => {
  const conversation: Conversation = [
    { kind: "user", id: "u1", content: [{ type: "text", text: "Hello" }] },
  ];

  it("serializes conversation to Responses API input", () => {
    const body = openAiResponsesAdapter.serialize({
      model: "gpt-5",
      conversation,
      system: "Be helpful.",
      tools: [
        {
          name: "read",
          description: "Read a file",
          parameters: { type: "object", properties: {} },
        },
      ],
      parameters: { maxOutputTokens: 512 },
    }) as {
      model: string;
      instructions: string;
      input: Array<{ role: string; content: string }>;
      tools: unknown[];
      max_output_tokens: number;
      stream: boolean;
    };

    expect(body.model).toBe("gpt-5");
    expect(body.stream).toBe(true);
    expect(body.instructions).toBe("Be helpful.");
    expect(body.max_output_tokens).toBe(512);
    expect(body.input[0]).toEqual({ role: "user", content: "Hello" });
    expect(body.tools).toHaveLength(1);
  });

  it("serializes prompt_cache_key from parameters.cacheKey", () => {
    const body = openAiResponsesAdapter.serialize({
      model: "gpt-5",
      conversation,
      parameters: { cacheKey: "session-xyz" },
    }) as { prompt_cache_key?: string };

    expect(body.prompt_cache_key).toBe("session-xyz");
  });

  it("decodes text and tool stream events", async () => {
    const chunks = [
      { type: "response.created" },
      { type: "response.output_text.delta", delta: "Hello" },
      {
        type: "response.output_item.added",
        item: {
          id: "item_1",
          type: "function_call",
          call_id: "call_1",
          name: "read",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "item_1",
        delta: '{"path":',
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "item_1",
        delta: '"a.ts"}',
      },
      {
        type: "response.output_item.done",
        item: { id: "item_1", type: "function_call", call_id: "call_1" },
      },
      {
        type: "response.completed",
        response: { usage: { input_tokens: 12, output_tokens: 6 } },
      },
    ];

    const events = await collectStreamEvents(
      openAiResponsesAdapter.decodeStream(eventsFrom(chunks)),
    );

    expect(events.map((e) => e.type)).toEqual([
      "response.start",
      "text.start",
      "text.delta",
      "tool.start",
      "tool.arguments.delta",
      "tool.arguments.delta",
      "tool.end",
      "usage",
      "text.end",
      "response.end",
    ]);

    const state = createTurnAssembler();
    for (const event of events) {
      applyStreamEvent(state, event);
    }
    const turn = assembleAssistantTurn(state, "asst-1");
    expect(turn.text).toEqual(["Hello"]);
    expect(turn.toolCalls).toEqual([
      { id: "call_1", name: "read", arguments: '{"path":"a.ts"}' },
    ]);
  });

  it("parses SSE lines", () => {
    expect(decodeOpenAiResponsesSseLine('data: {"type":"response.created"}')).toEqual({
      type: "response.created",
    });
    expect(decodeOpenAiResponsesSseLine("data: [DONE]")).toEqual({ done: true });
  });
});

describe("geminiAdapter", () => {
  const conversation: Conversation = [
    { kind: "user", id: "u1", content: [{ type: "text", text: "Hi" }] },
  ];

  it("serializes to Gemini generateContent shape", () => {
    const body = geminiAdapter.serialize({
      model: "gemini-2.5-pro",
      conversation,
      system: "Be concise.",
      parameters: { temperature: 0.2 },
    }) as {
      contents: Array<{ role: string; parts: Array<{ text: string }> }>;
      systemInstruction: { parts: Array<{ text: string }> };
      generationConfig: { temperature: number };
    };

    expect(body.contents[0]?.role).toBe("user");
    expect(body.contents[0]?.parts[0]?.text).toBe("Hi");
    expect(body.systemInstruction.parts[0]?.text).toBe("Be concise.");
    expect(body.generationConfig.temperature).toBe(0.2);
  });

  it("decodes text and tool stream chunks", async () => {
    const chunks = [
      {
        candidates: [{ content: { parts: [{ text: "Hello" }] } }],
      },
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: { name: "grep", args: { pattern: "foo" } },
                },
              ],
            },
          },
        ],
      },
      {
        candidates: [{ finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
      },
    ];

    const events = await collectStreamEvents(
      geminiAdapter.decodeStream(eventsFrom(chunks)),
    );

    expect(events.some((e) => e.type === "text.delta" && e.text === "Hello")).toBe(
      true,
    );
    expect(events.some((e) => e.type === "tool.start" && e.name === "grep")).toBe(
      true,
    );
    expect(
      events.some(
        (e) =>
          e.type === "tool.arguments.delta" &&
          e.argumentsDelta === '{"pattern":"foo"}',
      ),
    ).toBe(true);
    expect(events.some((e) => e.type === "usage")).toBe(true);
    expect(events.some((e) => e.type === "response.end")).toBe(true);
  });

  it("parses SSE lines", () => {
    expect(decodeGeminiSseLine('data: {"candidates":[]}')).toEqual({
      candidates: [],
    });
    expect(decodeGeminiSseLine("data: [DONE]")).toEqual({ done: true });
  });
});

describe("classifyError", () => {
  it("classifies HTTP status codes", () => {
    expect(classifyError(new AdapterHttpError(401, "unauthorized")).class).toBe(
      "CONFIGURATION",
    );
    expect(classifyError(new AdapterHttpError(429, "rate limit")).class).toBe(
      "TRANSIENT",
    );
    expect(classifyError(new AdapterHttpError(400, "bad request")).class).toBe(
      "REQUEST",
    );
  });

  it("classifies message heuristics", () => {
    expect(classifyError(new Error("Invalid API key")).class).toBe(
      "CONFIGURATION",
    );
    expect(classifyError(new Error("Request timeout")).class).toBe("TRANSIENT");
  });
});

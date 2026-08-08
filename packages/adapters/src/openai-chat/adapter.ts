import type {
  AssistantTurn,
  ContentPart,
  ConversationRecord,
  StreamEvent,
  ToolResult,
  UserMessage,
} from "@kimi-next/ir";
import {
  resolvePromptCacheKey,
  type AdapterRequest,
  type TransportAdapter,
} from "../types";
interface OpenAiChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | OpenAiContentPart[];
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}

interface OpenAiContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAiChatRequest {
  model: string;
  messages: OpenAiChatMessage[];
  tools?: OpenAiToolDefinition[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  prompt_cache_key?: string;
  stream: true;
}

interface OpenAiToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenAiChatChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

export function decodeOpenAiChatSseLine(line: string): unknown | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) {
    return null;
  }
  const payload = trimmed.slice("data:".length).trim();
  if (payload === "[DONE]") {
    return { done: true };
  }
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
}

export const openAiChatAdapter: TransportAdapter = {
  transport: "openai-chat",
  serialize(request) {
    return serializeOpenAiChatRequest(request);
  },
  decodeStream(rawEvents) {
    return decodeOpenAiChatStream(rawEvents);
  },
};

function serializeOpenAiChatRequest(request: AdapterRequest): OpenAiChatRequest {
  const messages: OpenAiChatMessage[] = [];

  if (request.system) {
    messages.push({ role: "system", content: request.system });
  }

  for (const record of request.conversation) {
    messages.push(...serializeRecord(record));
  }

  const body: OpenAiChatRequest = {
    model: request.model,
    messages,
    stream: true,
  };

  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  if (request.parameters) {
    if (request.parameters.temperature !== undefined) {
      body.temperature = request.parameters.temperature;
    }
    if (request.parameters.topP !== undefined) {
      body.top_p = request.parameters.topP;
    }
    if (request.parameters.maxOutputTokens !== undefined) {
      body.max_tokens = request.parameters.maxOutputTokens;
    }
    if (request.parameters.stopSequences !== undefined) {
      body.stop =
        request.parameters.stopSequences.length === 1
          ? request.parameters.stopSequences[0]
          : [...request.parameters.stopSequences];
    }
  }

  const promptCacheKey = resolvePromptCacheKey(request);
  if (promptCacheKey !== undefined) {
    body.prompt_cache_key = promptCacheKey;
  }

  return body;
}

function serializeRecord(record: ConversationRecord): OpenAiChatMessage[] {
  switch (record.kind) {
    case "system":
      return [{ role: "system", content: record.text }];
    case "user":
      return [{ role: "user", content: serializeUserContent(record) }];
    case "assistant":
      return [serializeAssistant(record)];
    case "tool_result":
      return [serializeToolResult(record)];
    case "compact_checkpoint":
      return [];
    default: {
      const _exhaustive: never = record;
      throw new Error(`Unhandled record: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function serializeUserContent(
  message: UserMessage,
): string | OpenAiContentPart[] {
  const hasImage = message.content.some((part) => part.type === "image");
  if (!hasImage) {
    return message.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("");
  }

  return message.content.map((part: ContentPart) => {
    if (part.type === "text") {
      return { type: "text" as const, text: part.text };
    }
    return {
      type: "image_url" as const,
      image_url: { url: part.url },
    };
  });
}

function serializeAssistant(turn: AssistantTurn): OpenAiChatMessage {
  const text = turn.text.join("");
  const message: OpenAiChatMessage = { role: "assistant" };
  if (text) {
    message.content = text;
  }

  if (turn.toolCalls.length > 0) {
    message.tool_calls = turn.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }));
  }

  if (turn.preserved.rawProviderMessage) {
    Object.assign(message, turn.preserved.rawProviderMessage);
  }

  return message;
}

function serializeToolResult(result: ToolResult): OpenAiChatMessage {
  return {
    role: "tool",
    tool_call_id: result.callId,
    content: result.content,
  };
}

async function* decodeOpenAiChatStream(
  rawEvents: AsyncIterable<unknown>,
): AsyncIterable<StreamEvent> {
  let started = false;
  let textOpen = false;
  const openTools = new Set<string>();
  const toolIndexToId = new Map<number, string>();

  for await (const raw of rawEvents) {
    if (isDoneMarker(raw)) {
      break;
    }

    const chunk = raw as OpenAiChatChunk;

    if (chunk.usage) {
      const usage: {
        type: "usage";
        inputTokens?: number;
        outputTokens?: number;
        cachedInputTokens?: number;
      } = { type: "usage" };
      if (chunk.usage.prompt_tokens !== undefined) {
        usage.inputTokens = chunk.usage.prompt_tokens;
      }
      if (chunk.usage.completion_tokens !== undefined) {
        usage.outputTokens = chunk.usage.completion_tokens;
      }
      const cached = chunk.usage.prompt_tokens_details?.cached_tokens;
      if (cached !== undefined) {
        usage.cachedInputTokens = cached;
      }
      yield usage;
    }

    const choice = chunk.choices?.[0];
    if (!choice) {
      continue;
    }

    if (!started) {
      started = true;
      yield { type: "response.start" };
    }

    const delta = choice.delta;
    if (delta?.content) {
      if (!textOpen) {
        textOpen = true;
        yield { type: "text.start" };
      }
      yield { type: "text.delta", text: delta.content };
    }

    if (delta?.tool_calls) {
      for (const toolDelta of delta.tool_calls) {
        const index = toolDelta.index ?? 0;
        let toolId = toolIndexToId.get(index);

        if (toolDelta.id) {
          toolId = toolDelta.id;
          toolIndexToId.set(index, toolId);
        }

        if (!toolId) {
          continue;
        }

        if (toolDelta.function?.name && !openTools.has(toolId)) {
          openTools.add(toolId);
          yield {
            type: "tool.start",
            id: toolId,
            name: toolDelta.function.name,
          };
        }

        if (toolDelta.function?.arguments) {
          yield {
            type: "tool.arguments.delta",
            id: toolId,
            argumentsDelta: toolDelta.function.arguments,
          };
        }
      }
    }

    if (choice.finish_reason) {
      if (textOpen) {
        textOpen = false;
        yield { type: "text.end" };
      }
      for (const toolId of openTools) {
        yield { type: "tool.end", id: toolId };
      }
      openTools.clear();
    }
  }

  if (textOpen) {
    yield { type: "text.end" };
  }
  for (const toolId of openTools) {
    yield { type: "tool.end", id: toolId };
  }

  if (started) {
    yield { type: "response.end" };
  }
}

function isDoneMarker(raw: unknown): boolean {
  return (
    typeof raw === "object" &&
    raw !== null &&
    "done" in raw &&
    (raw as { done: boolean }).done === true
  );
}

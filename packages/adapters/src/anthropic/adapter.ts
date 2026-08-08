import type {
  AssistantTurn,
  ContentPart,
  ConversationRecord,
  StreamEvent,
  ToolResult,
  UserMessage,
} from "@kimi-next/ir";
import type { AdapterRequest, TransportAdapter } from "../types";

interface AnthropicContentBlock {
  type: "text" | "image" | "tool_use" | "tool_result" | "thinking";
  text?: string;
  source?: { type: "url"; url: string };
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
  thinking?: string;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface AnthropicRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: AnthropicMessage[];
  tools?: AnthropicToolDefinition[];
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream: true;
}

interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicStreamEvent {
  type: string;
  index?: number;
  content_block?: {
    type: string;
    id?: string;
    name?: string;
    text?: string;
  };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    thinking?: string;
  };
  message?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export function decodeAnthropicSseLine(line: string): unknown | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) {
    return null;
  }
  const payload = trimmed.slice("data:".length).trim();
  if (!payload) {
    return null;
  }
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
}

export const anthropicAdapter: TransportAdapter = {
  transport: "anthropic",
  serialize(request) {
    return serializeAnthropicRequest(request);
  },
  decodeStream(rawEvents) {
    return decodeAnthropicStream(rawEvents);
  },
};

function serializeAnthropicRequest(request: AdapterRequest): AnthropicRequest {
  const messages: AnthropicMessage[] = [];

  for (const record of request.conversation) {
    const serialized = serializeRecord(record);
    if (serialized) {
      messages.push(serialized);
    }
  }

  const maxTokens = request.parameters?.maxOutputTokens ?? 4096;

  const body: AnthropicRequest = {
    model: request.model,
    max_tokens: maxTokens,
    messages,
    stream: true,
  };

  const systemText = collectSystemText(request);
  if (systemText) {
    body.system = systemText;
  }

  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
  }

  if (request.parameters) {
    if (request.parameters.temperature !== undefined) {
      body.temperature = request.parameters.temperature;
    }
    if (request.parameters.topP !== undefined) {
      body.top_p = request.parameters.topP;
    }
    if (request.parameters.stopSequences !== undefined) {
      body.stop_sequences = [...request.parameters.stopSequences];
    }
  }

  return body;
}

function collectSystemText(request: AdapterRequest): string | undefined {
  const parts: string[] = [];
  if (request.system) {
    parts.push(request.system);
  }
  for (const record of request.conversation) {
    if (record.kind === "system") {
      parts.push(record.text);
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function serializeRecord(record: ConversationRecord): AnthropicMessage | null {
  switch (record.kind) {
    case "system":
      return null;
    case "user":
      return { role: "user", content: serializeUserContent(record) };
    case "assistant":
      return { role: "assistant", content: serializeAssistant(record) };
    case "tool_result":
      return { role: "user", content: [serializeToolResult(record)] };
    case "compact_checkpoint":
      return null;
    default: {
      const _exhaustive: never = record;
      throw new Error(`Unhandled record: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function serializeUserContent(
  message: UserMessage,
): string | AnthropicContentBlock[] {
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
      type: "image" as const,
      source: { type: "url" as const, url: part.url },
    };
  });
}

function serializeAssistant(turn: AssistantTurn): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [];

  if (turn.reasoning.mode === "exposed" && turn.reasoning.text) {
    blocks.push({ type: "thinking", thinking: turn.reasoning.text });
  }

  const text = turn.text.join("");
  if (text) {
    blocks.push({ type: "text", text });
  }

  for (const call of turn.toolCalls) {
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(call.arguments) as Record<string, unknown>;
    } catch {
      input = { _raw: call.arguments };
    }
    blocks.push({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input,
    });
  }

  if (turn.preserved.rawProviderMessage) {
    return mergePreservedBlocks(blocks, turn.preserved.rawProviderMessage);
  }

  return blocks;
}

function mergePreservedBlocks(
  blocks: AnthropicContentBlock[],
  preserved: Readonly<Record<string, unknown>>,
): AnthropicContentBlock[] {
  const preservedContent = preserved["content"];
  if (Array.isArray(preservedContent)) {
    return preservedContent as AnthropicContentBlock[];
  }
  return blocks;
}

function serializeToolResult(result: ToolResult): AnthropicContentBlock {
  return {
    type: "tool_result",
    tool_use_id: result.callId,
    content: result.content,
    is_error: result.isError,
  };
}

async function* decodeAnthropicStream(
  rawEvents: AsyncIterable<unknown>,
): AsyncIterable<StreamEvent> {
  let started = false;
  let textOpen = false;
  let reasoningOpen = false;
  const blockIndexToId = new Map<number, string>();
  const openTools = new Set<string>();

  for await (const raw of rawEvents) {
    const event = raw as AnthropicStreamEvent;

    switch (event.type) {
      case "message_start":
        if (!started) {
          started = true;
          yield { type: "response.start" };
        }
        if (event.message?.usage) {
          yield usageFromAnthropic(event.message.usage);
        }
        break;

      case "content_block_start": {
        const index = event.index ?? 0;
        const block = event.content_block;
        if (!block) {
          break;
        }
        switch (block.type) {
          case "text":
            textOpen = true;
            yield { type: "text.start" };
            break;
          case "thinking":
            reasoningOpen = true;
            yield { type: "reasoning.start" };
            break;
          case "tool_use":
            if (block.id && block.name) {
              blockIndexToId.set(index, block.id);
              openTools.add(block.id);
              yield { type: "tool.start", id: block.id, name: block.name };
            }
            break;
          default:
            break;
        }
        break;
      }

      case "content_block_delta": {
        const index = event.index ?? 0;
        const delta = event.delta;
        if (!delta) {
          break;
        }
        if (delta.type === "text_delta" && delta.text) {
          if (!textOpen) {
            textOpen = true;
            yield { type: "text.start" };
          }
          yield { type: "text.delta", text: delta.text };
        }
        if (delta.type === "thinking_delta" && delta.thinking) {
          if (!reasoningOpen) {
            reasoningOpen = true;
            yield { type: "reasoning.start" };
          }
          yield { type: "reasoning.delta", text: delta.thinking };
        }
        if (delta.type === "input_json_delta" && delta.partial_json) {
          const toolId = blockIndexToId.get(index);
          if (toolId) {
            yield {
              type: "tool.arguments.delta",
              id: toolId,
              argumentsDelta: delta.partial_json,
            };
          }
        }
        break;
      }

      case "content_block_stop": {
        const index = event.index ?? 0;
        const toolId = blockIndexToId.get(index);
        if (toolId && openTools.has(toolId)) {
          yield { type: "tool.end", id: toolId };
          openTools.delete(toolId);
        }
        break;
      }

      case "message_delta":
        if (event.usage) {
          yield usageFromAnthropic(event.usage);
        }
        break;

      case "message_stop":
        if (textOpen) {
          textOpen = false;
          yield { type: "text.end" };
        }
        if (reasoningOpen) {
          reasoningOpen = false;
          yield { type: "reasoning.end" };
        }
        for (const toolId of openTools) {
          yield { type: "tool.end", id: toolId };
        }
        openTools.clear();
        if (started) {
          yield { type: "response.end" };
        }
        break;

      default:
        break;
    }
  }

  if (textOpen) {
    yield { type: "text.end" };
  }
  if (reasoningOpen) {
    yield { type: "reasoning.end" };
  }
  for (const toolId of openTools) {
    yield { type: "tool.end", id: toolId };
  }
  if (started) {
    yield { type: "response.end" };
  }
}

function usageFromAnthropic(usage: {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
}): StreamEvent {
  const event: {
    type: "usage";
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
  } = { type: "usage" };
  if (usage.input_tokens !== undefined) {
    event.inputTokens = usage.input_tokens;
  }
  if (usage.output_tokens !== undefined) {
    event.outputTokens = usage.output_tokens;
  }
  if (usage.cache_read_input_tokens !== undefined) {
    event.cachedInputTokens = usage.cache_read_input_tokens;
  }
  return event;
}

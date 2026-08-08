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

interface OpenAiResponsesInputItem {
  role?: "user" | "assistant" | "system" | "developer";
  content?: string | OpenAiResponsesContentPart[];
  type?: "function_call" | "function_call_output";
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
}

interface OpenAiResponsesContentPart {
  type: "input_text" | "input_image";
  text?: string;
  image_url?: string;
}

interface OpenAiResponsesTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface OpenAiResponsesRequest {
  model: string;
  input: OpenAiResponsesInputItem[];
  instructions?: string;
  tools?: OpenAiResponsesTool[];
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  stop?: string | string[];
  prompt_cache_key?: string;
  stream: true;
}

interface OpenAiResponsesStreamEvent {
  type: string;
  delta?: string;
  item_id?: string;
  item?: {
    id?: string;
    type?: string;
    name?: string;
    call_id?: string;
  };
  response?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
    };
  };
}

export function decodeOpenAiResponsesSseLine(line: string): unknown | null {
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

export const openAiResponsesAdapter: TransportAdapter = {
  transport: "openai-responses",
  serialize(request) {
    return serializeOpenAiResponsesRequest(request);
  },
  decodeStream(rawEvents) {
    return decodeOpenAiResponsesStream(rawEvents);
  },
};

function serializeOpenAiResponsesRequest(
  request: AdapterRequest,
): OpenAiResponsesRequest {
  const input: OpenAiResponsesInputItem[] = [];

  for (const record of request.conversation) {
    input.push(...serializeRecord(record));
  }

  const body: OpenAiResponsesRequest = {
    model: request.model,
    input,
    stream: true,
  };

  if (request.system) {
    body.instructions = request.system;
  }

  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
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
      body.max_output_tokens = request.parameters.maxOutputTokens;
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

function serializeRecord(record: ConversationRecord): OpenAiResponsesInputItem[] {
  switch (record.kind) {
    case "system":
      return [{ role: "developer", content: record.text }];
    case "user":
      return [{ role: "user", content: serializeUserContent(record) }];
    case "assistant":
      return serializeAssistant(record);
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
): string | OpenAiResponsesContentPart[] {
  const hasImage = message.content.some((part) => part.type === "image");
  if (!hasImage) {
    return message.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("");
  }

  return message.content.map((part: ContentPart) => {
    if (part.type === "text") {
      return { type: "input_text" as const, text: part.text };
    }
    return {
      type: "input_image" as const,
      image_url: part.url,
    };
  });
}

function serializeAssistant(turn: AssistantTurn): OpenAiResponsesInputItem[] {
  const items: OpenAiResponsesInputItem[] = [];
  const text = turn.text.join("");

  if (text) {
    items.push({ role: "assistant", content: text });
  }

  for (const call of turn.toolCalls) {
    items.push({
      type: "function_call",
      call_id: call.id,
      name: call.name,
      arguments: call.arguments,
    });
  }

  if (turn.preserved.rawProviderMessage) {
    const preserved = turn.preserved.rawProviderMessage;
    if (Array.isArray(preserved["input"])) {
      return preserved["input"] as OpenAiResponsesInputItem[];
    }
  }

  return items;
}

function serializeToolResult(result: ToolResult): OpenAiResponsesInputItem {
  return {
    type: "function_call_output",
    call_id: result.callId,
    output: result.content,
  };
}

async function* decodeOpenAiResponsesStream(
  rawEvents: AsyncIterable<unknown>,
): AsyncIterable<StreamEvent> {
  let started = false;
  let ended = false;
  let textOpen = false;
  const openTools = new Set<string>();
  const itemIdToToolId = new Map<string, string>();

  for await (const raw of rawEvents) {
    if (isDoneMarker(raw)) {
      break;
    }

    const event = raw as OpenAiResponsesStreamEvent;

    switch (event.type) {
      case "response.created":
      case "response.in_progress":
        if (!started) {
          started = true;
          yield { type: "response.start" };
        }
        break;

      case "response.output_item.added": {
        const item = event.item;
        if (item?.type === "function_call" && item.id && item.name) {
          const toolId = item.call_id ?? item.id;
          itemIdToToolId.set(item.id, toolId);
          openTools.add(toolId);
          yield { type: "tool.start", id: toolId, name: item.name };
        }
        break;
      }

      case "response.output_text.delta":
        if (!started) {
          started = true;
          yield { type: "response.start" };
        }
        if (event.delta) {
          if (!textOpen) {
            textOpen = true;
            yield { type: "text.start" };
          }
          yield { type: "text.delta", text: event.delta };
        }
        break;

      case "response.function_call_arguments.delta": {
        const itemId = event.item_id;
        const toolId = itemId ? itemIdToToolId.get(itemId) ?? itemId : undefined;
        if (toolId && event.delta) {
          yield {
            type: "tool.arguments.delta",
            id: toolId,
            argumentsDelta: event.delta,
          };
        }
        break;
      }

      case "response.output_item.done": {
        const item = event.item;
        if (item?.type === "function_call" && item.id) {
          const toolId = itemIdToToolId.get(item.id) ?? item.call_id ?? item.id;
          if (openTools.has(toolId)) {
            yield { type: "tool.end", id: toolId };
            openTools.delete(toolId);
          }
        }
        break;
      }

      case "response.completed":
        if (event.response?.usage) {
          yield usageFromResponses(event.response.usage);
        }
        if (textOpen) {
          textOpen = false;
          yield { type: "text.end" };
        }
        for (const toolId of openTools) {
          yield { type: "tool.end", id: toolId };
        }
        openTools.clear();
        if (started && !ended) {
          ended = true;
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
  for (const toolId of openTools) {
    yield { type: "tool.end", id: toolId };
  }
  if (started && !ended) {
    yield { type: "response.end" };
  }
}

function usageFromResponses(usage: {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
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
  const cached = usage.input_tokens_details?.cached_tokens;
  if (cached !== undefined) {
    event.cachedInputTokens = cached;
  }
  return event;
}

function isDoneMarker(raw: unknown): boolean {
  return (
    typeof raw === "object" &&
    raw !== null &&
    "done" in raw &&
    (raw as { done: boolean }).done === true
  );
}

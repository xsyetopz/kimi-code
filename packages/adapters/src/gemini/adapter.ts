import type {
  AssistantTurn,
  ContentPart,
  ConversationRecord,
  StreamEvent,
  ToolResult,
  UserMessage,
} from "@kimi-next/ir";
import type { AdapterRequest, TransportAdapter } from "../types";

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: Array<{ text: string }> };
  tools?: Array<{ functionDeclarations: GeminiFunctionDeclaration[] }>;
  generationConfig?: {
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
  };
}

interface GeminiStreamChunk {
  candidates?: Array<{
    content?: {
      role?: string;
      parts?: GeminiPart[];
    };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
  };
}

export function decodeGeminiSseLine(line: string): unknown | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) {
    return null;
  }
  const payload = trimmed.slice("data:".length).trim();
  if (!payload || payload === "[DONE]") {
    return payload === "[DONE]" ? { done: true } : null;
  }
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
}

export const geminiAdapter: TransportAdapter = {
  transport: "gemini",
  serialize(request) {
    return serializeGeminiRequest(request);
  },
  decodeStream(rawEvents) {
    return decodeGeminiStream(rawEvents);
  },
};

function serializeGeminiRequest(request: AdapterRequest): GeminiRequest {
  const contents: GeminiContent[] = [];

  for (const record of request.conversation) {
    const serialized = serializeRecord(record);
    if (serialized) {
      contents.push(serialized);
    }
  }

  const body: GeminiRequest = { contents };

  const systemText = collectSystemText(request);
  if (systemText) {
    body.systemInstruction = { parts: [{ text: systemText }] };
  }

  if (request.tools && request.tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
      },
    ];
  }

  if (request.parameters) {
    const generationConfig: NonNullable<GeminiRequest["generationConfig"]> = {};
    let hasConfig = false;

    if (request.parameters.temperature !== undefined) {
      generationConfig.temperature = request.parameters.temperature;
      hasConfig = true;
    }
    if (request.parameters.topP !== undefined) {
      generationConfig.topP = request.parameters.topP;
      hasConfig = true;
    }
    if (request.parameters.maxOutputTokens !== undefined) {
      generationConfig.maxOutputTokens = request.parameters.maxOutputTokens;
      hasConfig = true;
    }
    if (request.parameters.stopSequences !== undefined) {
      generationConfig.stopSequences = [...request.parameters.stopSequences];
      hasConfig = true;
    }

    if (hasConfig) {
      body.generationConfig = generationConfig;
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

function serializeRecord(record: ConversationRecord): GeminiContent | null {
  switch (record.kind) {
    case "system":
      return null;
    case "user":
      return { role: "user", parts: serializeUserParts(record) };
    case "assistant":
      return { role: "model", parts: serializeAssistantParts(record) };
    case "tool_result":
      return serializeToolResult(record);
    case "compact_checkpoint":
      return null;
    default: {
      const _exhaustive: never = record;
      throw new Error(`Unhandled record: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function serializeUserParts(message: UserMessage): GeminiPart[] {
  return message.content.map((part: ContentPart) => {
    if (part.type === "text") {
      return { text: part.text };
    }
    return {
      inlineData: {
        mimeType: "image/jpeg",
        data: part.url,
      },
    };
  });
}

function serializeAssistantParts(turn: AssistantTurn): GeminiPart[] {
  const parts: GeminiPart[] = [];

  if (turn.reasoning.mode === "exposed" && turn.reasoning.text) {
    parts.push({ text: turn.reasoning.text });
  }

  const text = turn.text.join("");
  if (text) {
    parts.push({ text });
  }

  for (const call of turn.toolCalls) {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.arguments) as Record<string, unknown>;
    } catch {
      args = { _raw: call.arguments };
    }
    parts.push({
      functionCall: {
        name: call.name,
        args,
      },
    });
  }

  if (turn.preserved.rawProviderMessage) {
    const preservedParts = turn.preserved.rawProviderMessage["parts"];
    if (Array.isArray(preservedParts)) {
      return preservedParts as GeminiPart[];
    }
  }

  return parts;
}

function serializeToolResult(result: ToolResult): GeminiContent {
  let response: Record<string, unknown> = { output: result.content };
  try {
    response = JSON.parse(result.content) as Record<string, unknown>;
  } catch {
    response = { output: result.content };
  }

  return {
    role: "user",
    parts: [
      {
        functionResponse: {
          name: result.callId,
          response,
        },
      },
    ],
  };
}

async function* decodeGeminiStream(
  rawEvents: AsyncIterable<unknown>,
): AsyncIterable<StreamEvent> {
  let started = false;
  let textOpen = false;
  const openTools = new Map<string, string>();
  let toolCounter = 0;

  for await (const raw of rawEvents) {
    if (isDoneMarker(raw)) {
      break;
    }

    const chunk = raw as GeminiStreamChunk;
    const candidate = chunk.candidates?.[0];

    if (chunk.usageMetadata) {
      yield usageFromGemini(chunk.usageMetadata);
    }

    if (!candidate) {
      continue;
    }

    if (!started) {
      started = true;
      yield { type: "response.start" };
    }

    for (const part of candidate.content?.parts ?? []) {
      if (part.text) {
        if (!textOpen) {
          textOpen = true;
          yield { type: "text.start" };
        }
        yield { type: "text.delta", text: part.text };
      }

      if (part.functionCall?.name) {
        toolCounter += 1;
        const toolId = `gemini_call_${toolCounter}`;
        openTools.set(toolId, part.functionCall.name);
        yield {
          type: "tool.start",
          id: toolId,
          name: part.functionCall.name,
        };

        if (part.functionCall.args) {
          yield {
            type: "tool.arguments.delta",
            id: toolId,
            argumentsDelta: JSON.stringify(part.functionCall.args),
          };
        }
        yield { type: "tool.end", id: toolId };
        openTools.delete(toolId);
      }
    }

    if (candidate.finishReason) {
      if (textOpen) {
        textOpen = false;
        yield { type: "text.end" };
      }
      for (const toolId of openTools.keys()) {
        yield { type: "tool.end", id: toolId };
      }
      openTools.clear();
      yield { type: "response.end" };
    }
  }

  if (textOpen) {
    yield { type: "text.end" };
  }
  for (const toolId of openTools.keys()) {
    yield { type: "tool.end", id: toolId };
  }
  if (started) {
    yield { type: "response.end" };
  }
}

function usageFromGemini(usage: {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
}): StreamEvent {
  const event: {
    type: "usage";
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
  } = { type: "usage" };
  if (usage.promptTokenCount !== undefined) {
    event.inputTokens = usage.promptTokenCount;
  }
  if (usage.candidatesTokenCount !== undefined) {
    event.outputTokens = usage.candidatesTokenCount;
  }
  if (usage.cachedContentTokenCount !== undefined) {
    event.cachedInputTokens = usage.cachedContentTokenCount;
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

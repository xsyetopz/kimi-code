/**
 * `kosong/provider` domain — OpenAI Chat Completions message conversion.
 *
 * Hook-aware history conversion, tool shaping, and generation-kwargs helpers
 * for the Chat Completions wire base.
 */

import OpenAI from "openai";

import { parseTraceId, type ChatProviderError } from "#/kosong/contract/errors";
import type {
  ContentPart,
  Message,
  StreamedMessagePart,
  ToolCall,
  VideoURLPart,
} from "#/kosong/contract/message";
import { isToolDeclarationOnlyMessage } from "#/kosong/contract/message";
import type {
  FinishReason,
  GenerateOptions,
  ProviderRequestAuth,
  ResponseFormat,
  StreamedMessage,
  ThinkingEffort,
  ToolCallIdPolicy,
  VideoUploadInput,
} from "#/kosong/contract/provider";
import type { Tool } from "#/kosong/contract/tool";
import type { TokenUsage } from "#/kosong/contract/usage";

import {
  convertContentPart,
  convertOpenAIError,
  convertToolMessageContent,
  extractUsage,
  hasModelPrefix,
  isFunctionToolCall,
  isOpenAIReasoningModel,
  normalizeOpenAIFinishReason,
  OPENAI_REASONING_CAPABILITY,
  OPENAI_TEXT_TOOL_CAPABILITY,
  OPENAI_VISION_TOOL_CAPABILITY,
  OPENAI_VISION_TOOL_PREFIXES,
  type OpenAIContentPart,
  TOOL_RESULT_MEDIA_PLACEHOLDER,
  TOOL_RESULT_MEDIA_PROMPT,
  type ToolMessageConversion,
  toolToOpenAI,
} from "./openai-common";
import { ReasoningKeyDialect } from "./reasoning-key";
import {
  mergeRequestHeaders,
  requireProviderApiKey,
  resolveAuthBackedClient,
} from "../request-auth";
import {
  normalizeToolCallIdsForProvider,
  sanitizeToolCallId,
} from "../tool-call-id";

const CHAT_COMPLETIONS_MAX_OUTPUT_TOKENS_CEILING = 128 * 1024;

export const OPENAI_CHAT_TOOL_CALL_ID_POLICY: ToolCallIdPolicy = {
  normalize: (id) => sanitizeToolCallId(id, 64),
  maxLength: 64,
};

export interface OpenAIChatCompletionsHooks {
  convertTool?: (tool: Tool) => Record<string, unknown> | undefined;
  convertError?: (error: unknown) => ChatProviderError | undefined;
  convertMessage?: (
    message: Message,
    converted: Record<string, unknown>,
  ) => Record<string, unknown> | null;
  mergeHistory?: (
    messages: readonly Record<string, unknown>[],
  ) => Record<string, unknown>[] | undefined;
  buildParams?: (
    params: Record<string, unknown>,
  ) => Record<string, unknown> | undefined;
  toolCallIdPolicy?: () => ToolCallIdPolicy | undefined;
  withThinking?: (
    effort: ThinkingEffort,
    options: { readonly keep?: string },
    generationKwargs: OpenAILegacyGenerationKwargs,
  ) => OpenAILegacyGenerationKwargs | undefined;
  preserveThinking?: (
    generationKwargs: Record<string, unknown>,
  ) => boolean | undefined;
  withMaxCompletionTokens?: (
    maxCompletionTokens: number,
  ) => Record<string, unknown> | undefined;
  cacheKey?: (key: string) => Record<string, unknown> | undefined;
  extractUsage?: (
    chunk: Record<string, unknown>,
  ) => Record<string, unknown> | null | undefined;
  reasoningKey?: () => string | undefined;
  uploadVideo?: (
    input: string | VideoUploadInput,
    options?: GenerateOptions,
  ) => Promise<VideoURLPart>;
}

export interface OpenAILegacyOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model: string;
  stream?: boolean | undefined;
  maxTokens?: number | undefined;
  reasoningKey?: string | undefined;
  offEffort?: string | undefined;
  thinkingEffort?: ThinkingEffort | undefined;
  httpClient?: unknown;
  defaultHeaders?: Record<string, string>;
  toolMessageConversion?: ToolMessageConversion | undefined;
  clientFactory?: (auth: ProviderRequestAuth) => OpenAI;
  hooks?: OpenAIChatCompletionsHooks | undefined;
}

export interface OpenAILegacyGenerationKwargs {
  max_tokens?: number | undefined;
  max_completion_tokens?: number | undefined;
  temperature?: number | undefined;
  top_p?: number | undefined;
  n?: number | undefined;
  presence_penalty?: number | undefined;
  frequency_penalty?: number | undefined;
  stop?: string | string[] | undefined;
  [key: string]: unknown;
}

interface OpenAIMessage {
  role: string;
  content?: string | OpenAIContentPart[] | undefined;
  tool_calls?: OpenAIToolCallOut[] | undefined;
  tool_call_id?: string | undefined;
  name?: string | undefined;
  [key: string]: unknown;
}

interface OpenAIToolCallOut {
  type: string;
  id: string;
  function: { name: string; arguments: string | null };
}

export function usesMaxCompletionTokens(model: string): boolean {
  const normalized = model.toLowerCase();
  return (
    /^o\d(?:$|[-.])/.test(normalized) || /^gpt-5(?:$|[-.])/.test(normalized)
  );
}

export function completionTokenKwargs(
  model: string,
  maxCompletionTokens: number,
): OpenAILegacyGenerationKwargs {
  return usesMaxCompletionTokens(model)
    ? { max_completion_tokens: maxCompletionTokens }
    : { max_tokens: maxCompletionTokens };
}

export function normalizeGenerationKwargs(
  model: string,
  source: OpenAILegacyGenerationKwargs,
): OpenAILegacyGenerationKwargs {
  const kwargs = { ...source };
  if (usesMaxCompletionTokens(model)) {
    if (
      kwargs.max_completion_tokens === undefined &&
      kwargs.max_tokens !== undefined
    ) {
      kwargs.max_completion_tokens = kwargs.max_tokens;
    }
    delete kwargs.max_tokens;
  }
  return kwargs;
}

export function responseFormatToOpenAI(
  format: ResponseFormat,
): Record<string, unknown> {
  if (format.type === "json_object") {
    return { type: "json_object" };
  }
  return {
    type: "json_schema",
    json_schema: {
      name: format.jsonSchema.name,
      schema: format.jsonSchema.schema,
      strict: format.jsonSchema.strict,
      description: format.jsonSchema.description,
    },
  };
}

export function convertMessage(
  message: Message,
  reasoningKey: string,
  toolMessageConversion: ToolMessageConversion,
  preserveThinking: boolean,
  allowToolResultExtraction: boolean,
): OpenAIMessage {
  let reasoningContent = "";
  let hasReasoningPart = false;
  const nonThinkParts: ContentPart[] = [];

  for (const part of message.content) {
    if (part.type === "think") {
      hasReasoningPart = true;
      reasoningContent += part.think;
    } else {
      nonThinkParts.push(part);
    }
  }

  const result: OpenAIMessage = { role: message.role };

  if (message.role === "tool") {
    const hasNonTextPart = message.content.some(
      (p) => p.type !== "text" && p.type !== "think",
    );
    const effectiveConversion: ToolMessageConversion =
      allowToolResultExtraction && hasNonTextPart
        ? "extract_text"
        : toolMessageConversion;

    if (effectiveConversion !== null) {
      result.content = convertToolMessageContentForChat(
        message,
        effectiveConversion,
      );
    } else {
      const firstPart = nonThinkParts[0];
      if (nonThinkParts.length === 1 && firstPart?.type === "text") {
        result.content = firstPart.text;
      } else if (nonThinkParts.length > 0) {
        result.content = nonThinkParts
          .map((p) => convertContentPart(p))
          .filter((p): p is OpenAIContentPart => p !== null);
      }
    }
  } else {
    const firstPart = nonThinkParts[0];
    if (nonThinkParts.length === 1 && firstPart?.type === "text") {
      result.content = firstPart.text;
    } else if (nonThinkParts.length > 0) {
      result.content = nonThinkParts
        .map((p) => convertContentPart(p))
        .filter((p): p is OpenAIContentPart => p !== null);
    }
  }

  if (message.name !== undefined) {
    result.name = message.name;
  }

  if (message.toolCalls.length > 0) {
    result.tool_calls = message.toolCalls.map((tc) => ({
      type: tc.type,
      id: tc.id,
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }

  if (message.toolCallId !== undefined) {
    result.tool_call_id = message.toolCallId;
  }

  if (hasReasoningPart || (preserveThinking && message.role === "assistant")) {
    result[reasoningKey] = reasoningContent;
  }

  return result;
}

const OMITTED_AUDIO_PLACEHOLDER =
  "(audio omitted: not supported by this provider)";
const OMITTED_VIDEO_PLACEHOLDER =
  "(video omitted: not supported by this provider)";

export function convertToolMessageContentForChat(
  message: Message,
  conversion: ToolMessageConversion,
): string | OpenAIContentPart[] {
  const content = convertToolMessageContent(message, conversion);
  if (typeof content !== "string") {
    return content;
  }
  const lines: string[] = content.length > 0 ? [content] : [];
  if (message.content.some((part) => part.type === "audio_url")) {
    lines.push(OMITTED_AUDIO_PLACEHOLDER);
  }
  if (message.content.some((part) => part.type === "video_url")) {
    lines.push(OMITTED_VIDEO_PLACEHOLDER);
  }
  if (
    lines.length === 0 &&
    message.content.some((part) => part.type === "image_url")
  ) {
    return TOOL_RESULT_MEDIA_PLACEHOLDER;
  }
  return lines.join("\n");
}

export function toolResultImageParts(message: Message): OpenAIContentPart[] {
  const images: OpenAIContentPart[] = [];
  for (const part of message.content) {
    if (part.type !== "image_url") continue;
    const converted = convertContentPart(part);
    if (converted !== null) {
      images.push(converted);
    }
  }
  return images;
}

export function appendToolResultMediaMessage(
  messages: OpenAIMessage[],
  pendingToolResultMedia: OpenAIContentPart[],
): void {
  if (pendingToolResultMedia.length === 0) return;
  messages.push({
    role: "user",
    content: [
      { type: "text", text: TOOL_RESULT_MEDIA_PROMPT },
      ...pendingToolResultMedia,
    ],
  });
  pendingToolResultMedia.length = 0;
}

export function convertHistoryMessages(
  history: readonly Message[],
  reasoningKey: string,
  toolMessageConversion: ToolMessageConversion,
  preserveThinking: boolean,
): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];
  const pendingToolResultMedia: OpenAIContentPart[] = [];

  for (const msg of history) {
    if (isToolDeclarationOnlyMessage(msg)) continue;
    if (msg.role !== "tool") {
      appendToolResultMediaMessage(messages, pendingToolResultMedia);
    }
    messages.push(
      convertMessage(
        msg,
        reasoningKey,
        toolMessageConversion,
        preserveThinking,
        true,
      ),
    );
    if (msg.role === "tool") {
      pendingToolResultMedia.push(...toolResultImageParts(msg));
    }
  }

  appendToolResultMediaMessage(messages, pendingToolResultMedia);
  return messages;
}

/**
 * `kosong/provider` domain — Anthropic message conversion and error mapping.
 */

import {
  APIConnectionError,
  APITimeoutError,
  ChatProviderError,
  classifyBaseApiError,
  normalizeAPIStatusError,
  parseRetryAfterMs,
  throwIfAbortError,
} from "#/kosong/contract/errors";
import type { ContentPart, Message } from "#/kosong/contract/message";
import type {
  FinishReason,
  ProviderRequestAuth,
  ResponseFormat,
  ThinkingEffort,
  ToolCallIdPolicy,
} from "#/kosong/contract/provider";
import type { Tool } from "#/kosong/contract/tool";
import Anthropic, {
  APIError as AnthropicAPIError,
  APIConnectionError as AnthropicConnectionError,
  AnthropicError,
  APIConnectionTimeoutError as AnthropicTimeoutError,
} from "@anthropic-ai/sdk";
import type {
  Tool as AnthropicTool,
  ContentBlockParam,
  MessageCreateParams,
  MessageParam,
  TextBlockParam,
  ThinkingBlockParam,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from "@anthropic-ai/sdk/resources/messages/messages.js";

import {
  BUDGET_THINKING_EFFORTS,
  inferAnthropicModelProfile,
  matchKnownAnthropicModelProfile,
  parseAnthropicModelVersion,
  type AnthropicModelProfile,
  type AnthropicModelVersion,
} from "./anthropic-profile";
import {
  sanitizeToolCallId,
} from "../tool-call-id";

export function normalizeAnthropicStopReason(raw: string | null | undefined): {
  finishReason: FinishReason | null;
  rawFinishReason: string | null;
} {
  if (raw === null || raw === undefined) {
    return { finishReason: null, rawFinishReason: null };
  }
  switch (raw) {
    case "end_turn":
    case "stop_sequence":
      return { finishReason: "completed", rawFinishReason: raw };
    case "max_tokens":
      return { finishReason: "truncated", rawFinishReason: raw };
    case "tool_use":
      return { finishReason: "tool_calls", rawFinishReason: raw };
    case "pause_turn":
      return { finishReason: "paused", rawFinishReason: raw };
    case "refusal":
      return { finishReason: "filtered", rawFinishReason: raw };
    default:
      return { finishReason: "other", rawFinishReason: raw };
  }
}

export interface AnthropicGenerationKwargs {
  max_tokens?: number | undefined;
  temperature?: number | undefined;
  top_k?: number | undefined;
  top_p?: number | undefined;
  thinking?: MessageCreateParams["thinking"] | undefined;
  output_config?: MessageCreateParams["output_config"] | undefined;
  betaFeatures?: string[] | undefined;
  contextManagement?: AnthropicContextManagement;
}

interface AnthropicContextManagement {
  edits: Array<{ type: string; keep?: unknown }>;
}

export interface AnthropicHooks {
  withThinking?(
    effort: ThinkingEffort,
    options: { readonly keep?: string },
    generationKwargs: AnthropicGenerationKwargs,
  ): AnthropicGenerationKwargs | undefined;
  convertError?: (error: unknown) => ChatProviderError | undefined;
}

export interface AnthropicOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model: string;
  defaultMaxTokens?: number | undefined;
  betaFeatures?: string[] | undefined;
  defaultHeaders?: Record<string, string>;
  metadata?: Record<string, string> | undefined;
  stream?: boolean | undefined;
  adaptiveThinking?: boolean | undefined;
  supportEfforts?: readonly string[] | undefined;
  betaApi?: boolean | undefined;
  thinkingEffort?: ThinkingEffort | undefined;
  clientFactory?: (auth: ProviderRequestAuth) => Anthropic;
  hooks?: AnthropicHooks | undefined;
}

const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";
const CONTEXT_MANAGEMENT_BETA = "context-management-2025-06-27";
const CLEAR_THINKING_EDIT = "clear_thinking_20251015";
const ANTHROPIC_TOOL_CALL_ID_POLICY: ToolCallIdPolicy = {
  normalize: (id) => sanitizeToolCallId(id, 64),
  maxLength: 64,
};

export function applyResponseFormat(
  kwargs: Record<string, unknown>,
  format: ResponseFormat | undefined,
): void {
  if (format === undefined) return;
  if (format.type === "json_object") {
    throw new ChatProviderError(
      "Anthropic provider requires a JSON schema for structured response output.",
    );
  }
  const outputConfig =
    kwargs["output_config"] !== undefined && kwargs["output_config"] !== null
      ? { ...(kwargs["output_config"] as Record<string, unknown>) }
      : {};
  outputConfig["format"] = {
    type: "json_schema",
    schema: format.jsonSchema.schema,
  };
  kwargs["output_config"] = outputConfig;
}

const CEILING_BY_FAMILY_VERSION: Readonly<Record<string, number>> = {
  "fable-5": 128000,
  "mythos-5": 128000,
  "opus-4-8": 128000,
  "opus-4-7": 128000,
  "opus-4-6": 128000,
  "opus-4-5": 64000,
  "opus-4-1": 32000,
  "opus-4-0": 32000,
  "opus-4": 32000,
  "sonnet-5": 128000,
  "sonnet-4-6": 128000,
  "sonnet-4-5": 64000,
  "sonnet-4-0": 64000,
  "sonnet-4": 64000,
  "haiku-4-5": 64000,
  "haiku-4": 64000,
  "opus-3-5": 8192,
  "sonnet-3-5": 8192,
  "sonnet-3-7": 8192,
  "haiku-3-5": 8192,
  "opus-3": 4096,
  "sonnet-3": 4096,
  "haiku-3": 4096,
};

const FALLBACK_MAX_TOKENS = 128000;

export function lookupClaudeCeiling(
  version: AnthropicModelVersion,
): number | undefined {
  const { family, major, minor } = version;
  if (minor !== null) {
    for (let candidate = minor; candidate >= 0; candidate--) {
      const ceiling =
        CEILING_BY_FAMILY_VERSION[`${family}-${major}-${candidate}`];
      if (ceiling !== undefined) return ceiling;
    }
  }
  return CEILING_BY_FAMILY_VERSION[`${family}-${major}`];
}

export function resolveDefaultMaxTokens(
  model: string,
  override?: number,
): number {
  const parsed = parseAnthropicModelVersion(model, true);
  const ceiling = parsed === null ? undefined : lookupClaudeCeiling(parsed);
  if (ceiling === undefined) {
    return override ?? FALLBACK_MAX_TOKENS;
  }
  return override === undefined ? ceiling : Math.min(override, ceiling);
}

export function requiresAdaptiveThinking(efforts: readonly string[]): boolean {
  return efforts.some(
    (effort) => effort !== "low" && effort !== "medium" && effort !== "high",
  );
}

export function resolveThinkingProfile(
  model: string,
  supportEfforts: readonly string[] | undefined,
  adaptiveThinking: boolean | undefined,
): AnthropicModelProfile {
  const inferred = inferAnthropicModelProfile(model);
  if (adaptiveThinking === false) {
    return {
      ...inferred,
      mode: "budget",
      efforts: supportEfforts ?? BUDGET_THINKING_EFFORTS,
      supportsEffortParam: false,
    };
  }

  if (adaptiveThinking === true) {
    return {
      ...inferred,
      mode: "adaptive",
      efforts: supportEfforts ?? inferred.efforts,
      supportsEffortParam: true,
    };
  }

  if (supportEfforts === undefined) {
    return inferred;
  }
  return {
    ...inferred,
    mode: requiresAdaptiveThinking(supportEfforts) ? "adaptive" : inferred.mode,
    efforts: supportEfforts,
    supportsEffortParam:
      requiresAdaptiveThinking(supportEfforts) || inferred.supportsEffortParam,
  };
}

export function budgetTokensForEffort(effort: ThinkingEffort): number | undefined {
  if (effort === "low") return 1024;
  if (effort === "medium") return 4096;
  if (effort === "on" || effort === "high") return 32_000;
  return undefined;
}

const CACHE_CONTROL = { type: "ephemeral" as const };

type CacheableBlock = ContentBlockParam & {
  cache_control?: { type: "ephemeral" };
};

export function shouldPreserveUnsignedThinking(model: string): boolean {
  return (
    parseAnthropicModelVersion(model) === null &&
    matchKnownAnthropicModelProfile(model) === undefined
  );
}

const CACHEABLE_TYPES = new Set([
  "text",
  "image",
  "document",
  "search_result",
  "tool_use",
  "tool_result",
  "server_tool_use",
  "web_search_tool_result",
]);

export function injectCacheControlOnLastBlock(messages: MessageParam[]): void {
  const lastMessage = messages.at(-1);
  if (lastMessage === undefined) return;
  const content = lastMessage.content;
  if (!Array.isArray(content) || content.length === 0) return;
  const lastBlock = content.at(-1) as CacheableBlock | undefined;
  if (lastBlock === undefined) return;
  if (CACHEABLE_TYPES.has(lastBlock.type)) {
    lastBlock.cache_control = CACHE_CONTROL;
  }
}

export function isToolResultOnly(message: MessageParam): boolean {
  if (message.role !== "user") return false;
  const content = message.content;
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every((block) => block.type === "tool_result");
}

interface AnthropicImageBlock {
  type: "image";
  source:
    | { type: "base64"; data: string; media_type: string }
    | { type: "url"; url: string };
  cache_control?: { type: "ephemeral" };
}

interface AnthropicVideoBlock {
  type: "video";
  source:
    | { type: "base64"; media_type: string; data: string }
    | { type: "url"; url: string };
}

const OMITTED_MEDIA_PLACEHOLDER = {
  audio_url: "(audio omitted: not supported by this provider)",
} as const;

const SUPPORTED_B64_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

const SUPPORTED_B64_VIDEO_TYPES = new Set([
  "video/mp4",
  "video/mpeg",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
  "video/x-msvideo",
  "video/x-flv",
  "video/3gpp",
]);

export function imageUrlPartToAnthropic(url: string): AnthropicImageBlock {
  if (url.startsWith("data:")) {
    const withoutScheme = url.slice(5);
    const parts = withoutScheme.split(";base64,", 2);
    if (
      parts.length !== 2 ||
      parts[0] === undefined ||
      parts[1] === undefined
    ) {
      throw new ChatProviderError(`Invalid data URL for image: ${url}`);
    }
    const mediaType = parts[0];
    const data = parts[1];
    if (!SUPPORTED_B64_MEDIA_TYPES.has(mediaType)) {
      throw new ChatProviderError(
        `Unsupported media type for base64 image: ${mediaType}, url: ${url}`,
      );
    }
    return {
      type: "image",
      source: { type: "base64", data, media_type: mediaType },
    };
  }
  return {
    type: "image",
    source: { type: "url", url },
  };
}

export function videoUrlPartToAnthropic(url: string): AnthropicVideoBlock {
  if (url.startsWith("data:")) {
    const withoutScheme = url.slice(5);
    const parts = withoutScheme.split(";base64,", 2);
    if (
      parts.length !== 2 ||
      parts[0] === undefined ||
      parts[1] === undefined
    ) {
      throw new ChatProviderError(`Invalid data URL for video: ${url}`);
    }
    const mediaType = parts[0];
    const data = parts[1];
    if (!SUPPORTED_B64_VIDEO_TYPES.has(mediaType)) {
      throw new ChatProviderError(
        `Unsupported media type for base64 video: ${mediaType}, url: ${url}`,
      );
    }
    return {
      type: "video",
      source: { type: "base64", media_type: mediaType, data },
    };
  }

  return {
    type: "video",
    source: { type: "url", url },
  };
}

interface AnthropicToolParam extends AnthropicTool {
  cache_control?: { type: "ephemeral" } | null;
}

export function convertTool(tool: Tool): AnthropicToolParam {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as AnthropicTool["input_schema"],
  };
}

export function toolResultToBlock(
  toolCallId: string,
  content: ContentPart[],
): ToolResultBlockParam {
  const blocks: Array<
    TextBlockParam | AnthropicImageBlock | AnthropicVideoBlock
  > = [];
  for (const part of content) {
    if (part.type === "text") {
      if (part.text) {
        blocks.push({ type: "text", text: part.text });
      }
    } else if (part.type === "image_url") {
      blocks.push(imageUrlPartToAnthropic(part.imageUrl.url));
    } else if (part.type === "video_url") {
      blocks.push(videoUrlPartToAnthropic(part.videoUrl.url));
    } else if (part.type === "audio_url") {
      const placeholder = OMITTED_MEDIA_PLACEHOLDER[part.type];
      const last = blocks.at(-1);
      if (!(last?.type === "text" && last.text === placeholder)) {
        blocks.push({ type: "text", text: placeholder });
      }
    }
  }
  return {
    type: "tool_result",
    tool_use_id: toolCallId,
    content: blocks,
  } as ToolResultBlockParam;
}

export function convertMessage(message: Message, model: string): MessageParam {
  const role = message.role;

  if (role === "system") {
    const text = message.content
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    return {
      role: "user",
      content: [{ type: "text", text: `<system>${text}</system>` }],
    };
  }

  if (role === "tool") {
    if (message.toolCallId === undefined) {
      throw new ChatProviderError("Tool message missing `toolCallId`.");
    }
    const block = toolResultToBlock(message.toolCallId, message.content);
    return { role: "user", content: [block as ContentBlockParam] };
  }

  const blocks: ContentBlockParam[] = [];
  for (const part of message.content) {
    if (part.type === "text") {
      blocks.push({ type: "text", text: part.text } satisfies TextBlockParam);
    } else if (part.type === "image_url") {
      blocks.push(
        imageUrlPartToAnthropic(
          part.imageUrl.url,
        ) as unknown as ContentBlockParam,
      );
    } else if (part.type === "think") {
      if (part.encrypted !== undefined) {
        blocks.push({
          type: "thinking",
          thinking: part.think,
          signature: part.encrypted,
        } satisfies ThinkingBlockParam);
      } else if (shouldPreserveUnsignedThinking(model)) {
        blocks.push({
          type: "thinking",
          thinking: part.think,
        } as unknown as ThinkingBlockParam);
      }
    } else if (part.type === "video_url") {
      blocks.push(
        videoUrlPartToAnthropic(
          part.videoUrl.url,
        ) as unknown as ContentBlockParam,
      );
    } else if (part.type === "audio_url") {
      const placeholder = OMITTED_MEDIA_PLACEHOLDER[part.type];
      const last = blocks.at(-1);
      if (!(last?.type === "text" && last.text === placeholder)) {
        blocks.push({
          type: "text",
          text: placeholder,
        } satisfies TextBlockParam);
      }
    }
  }

  if (message.toolCalls.length > 0) {
    for (const tc of message.toolCalls) {
      let toolInput: Record<string, unknown> = {};
      if (tc.arguments) {
        try {
          const parsed: unknown = JSON.parse(tc.arguments);
          if (
            typeof parsed === "object" &&
            parsed !== null &&
            !Array.isArray(parsed)
          ) {
            toolInput = parsed as Record<string, unknown>;
          } else {
            throw new ChatProviderError(
              "Tool call arguments must be a JSON object.",
            );
          }
        } catch (error) {
          if (error instanceof ChatProviderError) throw error;
          throw new ChatProviderError(
            "Tool call arguments must be valid JSON.",
          );
        }
      }
      blocks.push({
        type: "tool_use",
        id: tc.id,
        name: tc.name,
        input: toolInput,
      } satisfies ToolUseBlockParam);
    }
  }

  return { role: role, content: blocks };
}

export function shouldKeepConvertedMessage(message: MessageParam): boolean {
  return message.role !== "assistant" || message.content.length > 0;
}

export function convertAnthropicError(
  error: unknown,
  convertErrorHook?: (error: unknown) => ChatProviderError | undefined,
): ChatProviderError {
  throwIfAbortError(error);
  if (error instanceof ChatProviderError) {
    return error;
  }
  const hooked = convertErrorHook?.(error);
  if (hooked !== undefined) {
    return hooked;
  }
  if (error instanceof AnthropicTimeoutError) {
    return new APITimeoutError(error.message);
  }
  if (error instanceof AnthropicConnectionError) {
    return new APIConnectionError(error.message);
  }
  if (error instanceof AnthropicAPIError && typeof error.status === "number") {
    const reqId = error.requestID ?? null;
    return normalizeAPIStatusError(
      error.status,
      error.message,
      reqId,
      parseRetryAfterMs(error.headers),
    );
  }
  if (error instanceof AnthropicError) {
    return new ChatProviderError(`Anthropic error: ${error.message}`);
  }
  if (error instanceof Error) {
    return classifyBaseApiError(error.message);
  }
  return new ChatProviderError(`Error: ${String(error)}`);
}

export function applyThinkingKeep(
  kwargs: AnthropicGenerationKwargs,
  keep: string,
): AnthropicGenerationKwargs {
  const current = kwargs.betaFeatures ?? [];
  const betaFeatures = current.includes(CONTEXT_MANAGEMENT_BETA)
    ? current
    : [...current, CONTEXT_MANAGEMENT_BETA];
  const existingEdits = kwargs.contextManagement?.edits ?? [];
  const edits = [
    { type: CLEAR_THINKING_EDIT, keep },
    ...existingEdits.filter((edit) => edit.type !== CLEAR_THINKING_EDIT),
  ];
  return {
    contextManagement: { edits },
    betaFeatures,
  };
}

const CLAUDE_VISION_TOOL_PREFIXES = [
  "claude-3-",
  "claude-3.5-",
  "claude-3.7-",
] as const;

const CLAUDE_THINKING_VISION_TOOL_PREFIXES = [
  "claude-opus-4",
  "claude-sonnet-4",
  "claude-haiku-4",
  "claude-fable",
] as const;

const ANTHROPIC_VISION_TOOL_CAPABILITY = Object.freeze({
  image_in: true,
  video_in: false,
  audio_in: false,
  thinking: false,
  tool_use: true,
  max_context_tokens: 0,
});

const ANTHROPIC_THINKING_VISION_TOOL_CAPABILITY = Object.freeze({
  image_in: true,
  video_in: false,
  audio_in: false,
  thinking: true,
  tool_use: true,
  max_context_tokens: 0,
});

export function getAnthropicModelCapability(modelName: string) {
  const normalized = modelName.toLowerCase();
  if (
    CLAUDE_VISION_TOOL_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  ) {
    return ANTHROPIC_VISION_TOOL_CAPABILITY;
  }
  if (
    CLAUDE_THINKING_VISION_TOOL_PREFIXES.some((prefix) =>
      normalized.startsWith(prefix),
    )
  ) {
    return ANTHROPIC_THINKING_VISION_TOOL_CAPABILITY;
  }
  return undefined;
}


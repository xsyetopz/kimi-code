/**
 * `kosong/provider` domain — OpenAI Responses API decode helpers.
 */

import OpenAI from "openai";

import { Error2 } from "#/_base/errors/errors";
import {
  APIContextOverflowError,
  APIProviderQuotaExhaustedError,
  APIProviderRateLimitError,
  ChatProviderError,
  isContextOverflowErrorCode,
} from "#/kosong/contract/errors";
import type {
  ContentPart,
  Message,
  StreamedMessagePart,
  ToolCall,
} from "#/kosong/contract/message";
import {
  extractText,
  isToolDeclarationOnlyMessage,
} from "#/kosong/contract/message";
import type {
  ChatProvider,
  FinishReason,
  GenerateOptions,
  ProviderRequestAuth,
  ResponseFormat,
  StreamedMessage,
  ThinkingEffort,
  ToolCallIdPolicy,
} from "#/kosong/contract/provider";
import type { Tool } from "#/kosong/contract/tool";
import type { TokenUsage } from "#/kosong/contract/usage";
import { ProtocolErrors } from "#/kosong/protocol/errors";

import {
  convertOpenAIError,
  hasModelPrefix,
  isMediaPart,
  isOpenAIInsufficientQuotaCode,
  isOpenAIReasoningModel,
  OPENAI_REASONING_CAPABILITY,
  OPENAI_VISION_TOOL_CAPABILITY,
  OPENAI_VISION_TOOL_PREFIXES,
  TOOL_RESULT_MEDIA_PLACEHOLDER,
  TOOL_RESULT_MEDIA_PROMPT,
  type ToolMessageConversion,
} from "./openai-common";
import {
  mergeRequestHeaders,
  requireProviderApiKey,
  resolveAuthBackedClient,
} from "../request-auth";
import {
  normalizeToolCallIdsForProvider,
  sanitizeOpenAIResponsesCallId,
} from "../tool-call-id";
export function normalizeResponsesFinishReason(
  status: string | null | undefined,
  incompleteReason: string | null | undefined,
): { finishReason: FinishReason | null; rawFinishReason: string | null } {
  if (status === null || status === undefined) {
    return { finishReason: null, rawFinishReason: null };
  }
  if (status === "completed") {
    return { finishReason: "completed", rawFinishReason: "completed" };
  }
  if (status === "incomplete") {
    if (incompleteReason === "max_output_tokens") {
      return {
        finishReason: "truncated",
        rawFinishReason: "max_output_tokens",
      };
    }
    if (incompleteReason === "content_filter") {
      return { finishReason: "filtered", rawFinishReason: "content_filter" };
    }
    return {
      finishReason: "other",
      rawFinishReason: incompleteReason ?? "incomplete",
    };
  }
  if (status === "failed") {
    return { finishReason: "other", rawFinishReason: "failed" };
  }
  return { finishReason: null, rawFinishReason: null };
}

type RawObject = Record<string, unknown>;
export const OPENAI_RESPONSES_TOOL_CALL_ID_POLICY: ToolCallIdPolicy = {
  normalize: (id) => sanitizeOpenAIResponsesCallId(id, 64),
  maxLength: 64,
};

type ResponseOutputItemView =
  | {
      type: "message";
      content: RawObject[];
    }
  | {
      type: "function_call";
      itemId?: string;
      callId?: string;
      name?: string;
      arguments?: string | null;
    }
  | {
      type: "reasoning";
      encryptedContent?: string;
      summary: RawObject[];
    }
  | {
      type: "other";
    };

export function asRawObject(value: unknown): RawObject | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as RawObject;
}

export function readStringField(
  object: RawObject,
  key: string,
): string | undefined {
  const value = object[key];
  return typeof value === "string" ? value : undefined;
}

export function hasOwn(object: RawObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

export function readNullableStringField(
  object: RawObject,
  key: string,
): string | null | undefined {
  const value = object[key];
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

export function readNumberField(
  object: RawObject,
  key: string,
): number | undefined {
  const value = object[key];
  return typeof value === "number" ? value : undefined;
}

export function readObjectField(
  object: RawObject,
  key: string,
): RawObject | undefined {
  return asRawObject(object[key]) ?? undefined;
}

export function readObjectArrayField(
  object: RawObject,
  key: string,
): RawObject[] | undefined {
  const value = object[key];
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item) => {
    const objectItem = asRawObject(item);
    return objectItem === null ? [] : [objectItem];
  });
}

export function failResponsesDecode(context: string, detail: string): never {
  throw new ChatProviderError(
    `OpenAI Responses decode error: ${context} ${detail}`,
  );
}

export function requireStringField(
  object: RawObject,
  key: string,
  context: string,
): string {
  const value = readStringField(object, key);
  if (value === undefined) {
    failResponsesDecode(`${context}.${key}`, "must be a string.");
  }
  return value;
}

export function requireObjectField(
  object: RawObject,
  key: string,
  context: string,
): RawObject {
  const value = readObjectField(object, key);
  if (value === undefined) {
    failResponsesDecode(`${context}.${key}`, "must be an object.");
  }
  return value;
}

export function readResponseOutputItem(
  value: unknown,
  context: string,
): ResponseOutputItemView {
  const item = asRawObject(value);
  if (item === null) {
    failResponsesDecode(context, "must be an object.");
  }

  const type = requireStringField(item, "type", context);

  if (type === "message") {
    return {
      type,
      content: readObjectArrayField(item, "content") ?? [],
    };
  }

  if (type === "function_call") {
    return {
      type,
      itemId: readStringField(item, "id"),
      callId: readStringField(item, "call_id"),
      name: readStringField(item, "name"),
      arguments: readNullableStringField(item, "arguments"),
    };
  }

  if (type === "reasoning") {
    return {
      type,
      encryptedContent: readStringField(item, "encrypted_content"),
      summary: readObjectArrayField(item, "summary") ?? [],
    };
  }

  return { type: "other" };
}

export function responseStreamIndex(
  itemId: string | undefined,
  outputIndex: number | undefined,
): string | number | undefined {
  return itemId ?? outputIndex;
}

export function formatResponseStreamIndex(
  streamIndex: string | number | undefined,
): string {
  return streamIndex === undefined ? "<unindexed>" : String(streamIndex);
}

export function requireFunctionCallName(item: { name?: string }): string {
  if (item.name === undefined) {
    throw new ChatProviderError(
      "OpenAI Responses function_call item is missing a name.",
    );
  }
  return item.name;
}

export function functionCallId(callId: string | undefined): string {
  return callId === undefined || callId.length === 0
    ? crypto.randomUUID()
    : callId;
}

export function formatResponsesErrorEvent(
  code: string | null,
  message: string,
  param: string | null,
): string {
  const codeText = code ?? "unknown";
  const paramText = param === null ? "" : ` (param: ${param})`;
  return `${codeText}: ${message}${paramText}`;
}

const EMBEDDED_STATUS_CODE_RE = /\bstatus_code\s*[:=]\s*(\d{3})\b/;

export function readEmbeddedStatusCode(message: string): number | undefined {
  const match = EMBEDDED_STATUS_CODE_RE.exec(message);
  return match === null ? undefined : Number(match[1]);
}

export function errorFromOpenAIResponsesEvent(
  prefix: string,
  code: string | null,
  message: string,
  param: string | null,
  options?: {
    readonly rawEvent?: unknown;
    readonly convertErrorHook?: (
      error: unknown,
    ) => ChatProviderError | undefined;
  },
): ChatProviderError {
  const formatted = formatResponsesErrorEvent(code, message, param);
  const fullMessage = `${prefix}: ${formatted}`;
  const hooked = options?.convertErrorHook?.(
    options.rawEvent ?? { code, message, param },
  );
  if (hooked !== undefined) {
    return hooked;
  }
  if (isContextOverflowErrorCode(code)) {
    return new APIContextOverflowError(400, fullMessage);
  }
  if (isOpenAIInsufficientQuotaCode(code)) {
    return new APIProviderQuotaExhaustedError(fullMessage);
  }
  if (
    code === "rate_limit_exceeded" ||
    readEmbeddedStatusCode(message) === 429
  ) {
    return new APIProviderRateLimitError(fullMessage);
  }
  return new ChatProviderError(fullMessage);
}

export function parseNestedGatewayStreamError(message: string):
  | {
      code: string | null;
      message: string;
      param: string | null;
    }
  | undefined {
  const marker = "received error while streaming:";
  const markerIndex = message.indexOf(marker);
  if (markerIndex === -1) return undefined;

  const jsonText = message.slice(markerIndex + marker.length).trim();
  if (jsonText.length === 0) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return undefined;
  }

  const error = asRawObject(parsed);
  if (error === null) return undefined;

  const nestedMessage = readStringField(error, "message");
  if (nestedMessage === undefined) return undefined;

  return {
    code: readNullableStringField(error, "code") ?? null,
    message: nestedMessage,
    param: readNullableStringField(error, "param") ?? null,
  };
}

export function malformedStreamErrorEvent(
  message: string,
  convertErrorHook?: (error: unknown) => ChatProviderError | undefined,
): ChatProviderError {
  const nested = parseNestedGatewayStreamError(message);
  if (nested !== undefined) {
    return errorFromOpenAIResponsesEvent(
      "OpenAI Responses malformed stream error",
      nested.code,
      nested.message,
      nested.param,
      { convertErrorHook },
    );
  }

  return errorFromOpenAIResponsesEvent(
    "OpenAI Responses malformed stream error",
    null,
    message,
    null,
    { convertErrorHook },
  );
}

export function readResponsesFailedResponseError(response: RawObject):
  | {
      code: string | null;
      message: string;
    }
  | undefined {
  const error = readObjectField(response, "error");
  if (error !== undefined) {
    const code = readNullableStringField(error, "code") ?? "unknown";
    const message = readStringField(error, "message") ?? "no message";
    return { code, message };
  }
  return undefined;
}

export function formatResponsesFailedResponse(response: RawObject): string {
  const error = readResponsesFailedResponseError(response);
  if (error !== undefined) {
    return formatResponsesErrorEvent(error.code, error.message, null);
  }

  const incompleteDetails = readObjectField(response, "incomplete_details");
  const reason =
    incompleteDetails === undefined
      ? undefined
      : readStringField(incompleteDetails, "reason");
  return reason === undefined
    ? "Unknown error (no error details in response)"
    : `incomplete: ${reason}`;
}

export interface OpenAIResponsesOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model: string;
  maxOutputTokens?: number | undefined;
  offEffort?: string | undefined;
  thinkingEffort?: ThinkingEffort | undefined;
  httpClient?: unknown;
  defaultHeaders?: Record<string, string>;
  toolMessageConversion?: ToolMessageConversion | undefined;
  clientFactory?: (auth: ProviderRequestAuth) => OpenAI;
  convertError?: (error: unknown) => ChatProviderError | undefined;
}

export interface OpenAIResponsesGenerationKwargs {
  max_output_tokens?: number | undefined;
  temperature?: number | undefined;
  top_p?: number | undefined;
  reasoning_effort?: string | undefined;
  [key: string]: unknown;
}

interface ResponseInputItem {
  [key: string]: unknown;
}

interface ResponseToolParam {
  type: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: boolean;
}

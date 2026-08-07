/**
 * `kosong/provider` domain — OpenAI Responses API wire base.
 *
 * Speaks the Responses wire format: `input` items, `instructions`,
 * `reasoning` blocks with encrypted content, and the native
 * `prompt_cache_key` field (a cache key is encoded directly — no hook
 * needed). Per-turn intents are encoded inline in the fixed contract order;
 * the base's only hook surface is the trait-composed `convertError` option,
 * consulted with each raw failure exactly once — the SDK error on HTTP
 * paths, the raw event on in-stream error paths — before the base's own
 * classification (already-converted errors crossing an outer catch pass
 * through without re-consulting). The developer-role model detection lives
 * here.
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
import * as decode from "./openai-responses.decode";
import { OPENAI_RESPONSES_TOOL_CALL_ID_POLICY } from "./openai-responses.decode";
import * as convert from "./openai-responses.convert";

export class OpenAIResponsesStreamedMessage implements StreamedMessage {
  private _id: string | null = null;
  private _usage: TokenUsage | null = null;
  private _finishReason: FinishReason | null = null;
  private _rawFinishReason: string | null = null;
  private readonly _iter: AsyncGenerator<StreamedMessagePart>;

  constructor(
    response: unknown,
    isStream: boolean,
    private readonly _convertErrorHook?:
      | ((error: unknown) => ChatProviderError | undefined)
      | undefined,
  ) {
    if (isStream) {
      this._iter = this._convertStreamResponse(
        response as AsyncIterable<RawObject>,
      );
    } else {
      this._iter = this._convertNonStreamResponse(response as RawObject);
    }
  }

  get id(): string | null {
    return this._id;
  }

  get usage(): TokenUsage | null {
    return this._usage;
  }

  get finishReason(): FinishReason | null {
    return this._finishReason;
  }

  get rawFinishReason(): string | null {
    return this._rawFinishReason;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
    yield* this._iter;
  }

  private _captureFinishReasonFromResponse(response: RawObject): void {
    const status = decode.readNullableStringField(response, "status");
    const incomplete = decode.readObjectField(response, "incomplete_details");
    const incompleteReason = incomplete
      ? decode.readStringField(incomplete, "reason")
      : null;
    const normalized = decode.normalizeResponsesFinishReason(
      status,
      incompleteReason,
    );
    this._finishReason = normalized.finishReason;
    this._rawFinishReason = normalized.rawFinishReason;
  }

  private _extractUsage(usage: RawObject): void {
    const inputTokens = decode.readNumberField(usage, "input_tokens") ?? 0;
    const outputTokens = decode.readNumberField(usage, "output_tokens") ?? 0;
    const details = decode.readObjectField(usage, "input_tokens_details");
    const cached = details
      ? (decode.readNumberField(details, "cached_tokens") ?? 0)
      : 0;
    this._usage = {
      inputOther: inputTokens - cached,
      output: outputTokens,
      inputCacheRead: cached,
      inputCacheCreation: 0,
    };
  }

  private async *_convertNonStreamResponse(
    response: RawObject,
  ): AsyncGenerator<StreamedMessagePart> {
    this._id = decode.readStringField(response, "id") ?? null;
    const usage = decode.readObjectField(response, "usage");
    if (usage !== undefined) {
      this._extractUsage(usage);
    }
    this._captureFinishReasonFromResponse(response);

    const output = decode.readObjectArrayField(response, "output");
    if (output === undefined) return;

    for (const item of output) {
      const outputItem = decode.readResponseOutputItem(
        item,
        "response.output item",
      );

      if (outputItem.type === "message") {
        for (const contentItem of outputItem.content) {
          if (contentItem["type"] === "output_text") {
            const text = decode.readStringField(contentItem, "text");
            if (text !== undefined) {
              yield { type: "text", text };
            }
          }
        }
      } else if (outputItem.type === "function_call") {
        yield {
          type: "function",
          id: decode.functionCallId(outputItem.callId),
          name: decode.requireFunctionCallName(outputItem),
          arguments: outputItem.arguments ?? null,
        } satisfies ToolCall;
      } else if (outputItem.type === "reasoning") {
        let hasReasoningSummary = false;
        for (const summary of outputItem.summary) {
          const text = decode.readStringField(summary, "text");
          if (text === undefined) continue;
          hasReasoningSummary = true;
          const thinkPart: StreamedMessagePart = {
            type: "think",
            think: text,
          };
          if (outputItem.encryptedContent !== undefined) {
            (thinkPart as { encrypted: string }).encrypted =
              outputItem.encryptedContent;
          }
          yield thinkPart;
        }
        if (!hasReasoningSummary) {
          const thinkPart: StreamedMessagePart = { type: "think", think: "" };
          if (outputItem.encryptedContent !== undefined) {
            (thinkPart as { encrypted: string }).encrypted =
              outputItem.encryptedContent;
          }
          yield thinkPart;
        }
      }
    }
  }

  private async *_convertStreamResponse(
    response: AsyncIterable<RawObject>,
  ): AsyncGenerator<StreamedMessagePart> {
    const functionCallArgumentsByIndex = new Map<number | string, string>();
    let unindexedFunctionCallArguments: string | undefined;

    const hasFunctionCallArguments = (
      streamIndex: number | string | undefined,
    ): boolean =>
      streamIndex === undefined
        ? unindexedFunctionCallArguments !== undefined
        : functionCallArgumentsByIndex.has(streamIndex);

    const getFunctionCallArguments = (
      streamIndex: number | string | undefined,
    ): string =>
      streamIndex === undefined
        ? (unindexedFunctionCallArguments as string)
        : functionCallArgumentsByIndex.get(streamIndex)!;

    const setFunctionCallArguments = (
      streamIndex: number | string | undefined,
      argumentsValue: string,
    ): void => {
      if (streamIndex === undefined) {
        unindexedFunctionCallArguments = argumentsValue;
      } else {
        functionCallArgumentsByIndex.set(streamIndex, argumentsValue);
      }
    };

    const appendFunctionCallArguments = (
      streamIndex: number | string | undefined,
      argumentsPart: string,
      context: string,
    ): void => {
      if (!hasFunctionCallArguments(streamIndex)) {
        decode.failResponsesDecode(
          context,
          `received function-call arguments for unknown stream index ${decode.formatResponseStreamIndex(streamIndex)}.`,
        );
      }
      setFunctionCallArguments(
        streamIndex,
        getFunctionCallArguments(streamIndex) + argumentsPart,
      );
    };

    const yieldFinalArgumentsSuffix = function* (
      streamIndex: number | string | undefined,
      finalArguments: string,
      context: string,
    ): Generator<StreamedMessagePart> {
      if (!hasFunctionCallArguments(streamIndex)) {
        decode.failResponsesDecode(
          context,
          `received final function-call arguments for unknown stream index ${decode.formatResponseStreamIndex(streamIndex)}.`,
        );
      }

      const accumulatedArguments = getFunctionCallArguments(streamIndex);
      if (finalArguments === accumulatedArguments) {
        return;
      }

      if (!finalArguments.startsWith(accumulatedArguments)) {
        throw new ChatProviderError(
          `OpenAI Responses final function-call arguments for stream index ${decode.formatResponseStreamIndex(
            streamIndex,
          )} do not match the streamed argument deltas.`,
        );
      }

      const suffix = finalArguments.slice(accumulatedArguments.length);
      setFunctionCallArguments(streamIndex, finalArguments);
      if (suffix.length === 0) {
        return;
      }

      const part: StreamedMessagePart = {
        type: "tool_call_part",
        argumentsPart: suffix,
      };
      if (streamIndex !== undefined) {
        (part as { index: number | string }).index = streamIndex;
      }
      yield part;
    };

    try {
      for await (const chunk of response) {
        const type = decode.readStringField(chunk, "type");
        if (type === undefined) {
          if (!decode.hasOwn(chunk, "type")) {
            const message = decode.readStringField(chunk, "message");
            if (message !== undefined) {
              throw decode.malformedStreamErrorEvent(
                message,
                this._convertErrorHook,
              );
            }
          }
          decode.failResponsesDecode("stream event.type", "must be a string.");
        }

        switch (type) {
          case "response.output_text.delta":
            yield {
              type: "text",
              text: decode.requireStringField(chunk, "delta", type),
            };
            break;
          case "response.created":
          case "response.in_progress": {
            const responseObject = decode.requireObjectField(
              chunk,
              "response",
              type,
            );
            const respId = decode.readStringField(responseObject, "id");
            if (respId !== undefined) {
              this._id = respId;
            }
            break;
          }
          case "response.output_item.added": {
            const item = decode.readResponseOutputItem(
              chunk["item"],
              `${type}.item`,
            );
            const outputIndex = decode.readNumberField(chunk, "output_index");
            if (item.type === "function_call") {
              const streamIndex = decode.responseStreamIndex(
                item.itemId,
                outputIndex,
              );
              setFunctionCallArguments(streamIndex, item.arguments ?? "");
              const tc: ToolCall = {
                type: "function",
                id: decode.functionCallId(item.callId),
                name: decode.requireFunctionCallName(item),
                arguments: item.arguments ?? null,
              };
              if (streamIndex !== undefined) {
                tc._streamIndex = streamIndex;
              }
              yield tc;
            }
            break;
          }
          case "response.output_item.done": {
            const item = decode.readResponseOutputItem(
              chunk["item"],
              `${type}.item`,
            );
            const outputIndex = decode.readNumberField(chunk, "output_index");
            if (item.type === "reasoning") {
              const thinkPart: StreamedMessagePart = {
                type: "think",
                think: "",
              };
              if (item.encryptedContent !== undefined) {
                (thinkPart as { encrypted: string }).encrypted =
                  item.encryptedContent;
              }
              yield thinkPart;
            } else if (
              item.type === "function_call" &&
              typeof item.arguments === "string"
            ) {
              const streamIndex = decode.responseStreamIndex(
                item.itemId,
                outputIndex,
              );
              yield* yieldFinalArgumentsSuffix(
                streamIndex,
                item.arguments,
                type,
              );
            }
            break;
          }
          case "response.function_call_arguments.delta": {
            const streamIndex = decode.responseStreamIndex(
              decode.readStringField(chunk, "item_id"),
              decode.readNumberField(chunk, "output_index"),
            );
            const argumentsPart = decode.requireStringField(
              chunk,
              "delta",
              type,
            );
            const part: StreamedMessagePart = {
              type: "tool_call_part",
              argumentsPart,
            };
            appendFunctionCallArguments(streamIndex, argumentsPart, type);
            if (streamIndex !== undefined) {
              (part as { index: number | string }).index = streamIndex;
            }
            yield part;
            break;
          }
          case "response.function_call_arguments.done": {
            const functionArguments = decode.requireStringField(
              chunk,
              "arguments",
              type,
            );
            const streamIndex = decode.responseStreamIndex(
              decode.readStringField(chunk, "item_id"),
              decode.readNumberField(chunk, "output_index"),
            );
            yield* yieldFinalArgumentsSuffix(
              streamIndex,
              functionArguments,
              type,
            );
            break;
          }
          case "response.reasoning_summary_part.added":
            yield { type: "think", think: "" };
            break;
          case "response.reasoning_summary_text.delta":
            yield {
              type: "think",
              think: decode.requireStringField(chunk, "delta", type),
            };
            break;
          case "response.completed":
          case "response.incomplete": {
            const responseObject = decode.requireObjectField(
              chunk,
              "response",
              type,
            );
            const respId = decode.readStringField(responseObject, "id");
            if (respId !== undefined) {
              this._id = respId;
            }
            const usage = decode.readObjectField(responseObject, "usage");
            if (usage !== undefined) {
              this._extractUsage(usage);
            }
            this._captureFinishReasonFromResponse(responseObject);
            break;
          }
          case "error": {
            const message = decode.requireStringField(chunk, "message", type);
            throw decode.errorFromOpenAIResponsesEvent(
              "OpenAI Responses stream error",
              decode.readNullableStringField(chunk, "code") ?? null,
              message,
              decode.readNullableStringField(chunk, "param") ?? null,
              { rawEvent: chunk, convertErrorHook: this._convertErrorHook },
            );
          }
          case "response.failed": {
            const responseObject = decode.requireObjectField(
              chunk,
              "response",
              type,
            );
            const error =
              decode.readResponsesFailedResponseError(responseObject);
            if (error !== undefined) {
              throw decode.errorFromOpenAIResponsesEvent(
                "OpenAI Responses response.failed",
                error.code,
                error.message,
                null,
                { rawEvent: chunk, convertErrorHook: this._convertErrorHook },
              );
            }
            throw new ChatProviderError(
              `OpenAI Responses response.failed: ${decode.formatResponsesFailedResponse(responseObject)}`,
            );
          }
          default:
            break;
        }
      }
    } catch (error: unknown) {
      throw convertOpenAIError(error, this._convertErrorHook);
    }
  }
}

export class OpenAIResponsesChatProvider implements ChatProvider {
  readonly name: string = "openai-responses";

  private readonly _model: string;
  private readonly _stream: boolean;
  private readonly _apiKey: string | undefined;
  private readonly _baseUrl: string | undefined;
  private readonly _defaultHeaders: Record<string, string> | undefined;
  private readonly _thinkingEffort: ThinkingEffort | undefined;
  private readonly _offEffort: string | undefined;
  private readonly _generationKwargs: OpenAIResponsesGenerationKwargs;
  private readonly _toolMessageConversion: ToolMessageConversion;
  private readonly _client: OpenAI | undefined;
  private readonly _httpClient: unknown;
  private readonly _clientFactory:
    | ((auth: ProviderRequestAuth) => OpenAI)
    | undefined;
  private readonly _convertErrorHook:
    | ((error: unknown) => ChatProviderError | undefined)
    | undefined;

  constructor(options: OpenAIResponsesOptions) {
    const apiKey = options.apiKey ?? process.env["OPENAI_API_KEY"];
    this._apiKey =
      apiKey === undefined || apiKey.length === 0 ? undefined : apiKey;
    this._baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
    this._defaultHeaders = options.defaultHeaders;
    this._model = options.model;
    this._stream = true;
    this._thinkingEffort = options.thinkingEffort;
    this._offEffort = options.offEffort;
    this._generationKwargs = {};
    this._toolMessageConversion = options.toolMessageConversion ?? null;
    this._httpClient = options.httpClient;
    this._clientFactory = options.clientFactory;
    this._convertErrorHook = options.convertError;

    if (options.maxOutputTokens !== undefined) {
      this._generationKwargs.max_output_tokens = options.maxOutputTokens;
    }

    this._client =
      this._apiKey === undefined ? undefined : this._buildClient(this._apiKey);
  }

  get modelName(): string {
    return this._model;
  }

  get thinkingEffort(): ThinkingEffort | null {
    return this._thinkingEffort ?? null;
  }

  get maxCompletionTokens(): number | undefined {
    return this._generationKwargs.max_output_tokens;
  }

  async generate(
    systemPrompt: string,
    tools: Tool[],
    history: Message[],
    options?: GenerateOptions,
  ): Promise<StreamedMessage> {
    const input: unknown[] = [];

    const normalizedHistory = normalizeToolCallIdsForProvider(
      history,
      OPENAI_RESPONSES_TOOL_CALL_ID_POLICY,
    );
    input.push(
      ...convert.convertHistoryMessages(
        normalizedHistory,
        this._model,
        this._toolMessageConversion,
      ),
    );

    let kwargs: Record<string, unknown> = { ...this._generationKwargs };

    if (options?.cacheKey !== undefined) {
      kwargs = { ...kwargs, prompt_cache_key: options.cacheKey };
    }
    if (options?.sampling?.temperature !== undefined) {
      kwargs = { ...kwargs, temperature: options.sampling.temperature };
    }
    if (options?.sampling?.topP !== undefined) {
      kwargs = { ...kwargs, top_p: options.sampling.topP };
    }

    const thinking =
      options?.thinking ??
      (this._thinkingEffort !== undefined
        ? { effort: this._thinkingEffort }
        : undefined);
    if (thinking !== undefined) {
      const effort =
        thinking.effort === "off"
          ? this._offEffort
          : thinking.effort === "on"
            ? undefined
            : thinking.effort;
      kwargs = { ...kwargs, reasoning_effort: effort };
    }

    if (options?.maxCompletionTokens !== undefined) {
      let cap = options.maxCompletionTokens;
      if (
        options.usedContextTokens !== undefined &&
        options.maxContextTokens !== undefined &&
        options.maxContextTokens > 0
      ) {
        cap = Math.min(
          cap,
          options.maxContextTokens - options.usedContextTokens,
        );
      }
      kwargs = { ...kwargs, max_output_tokens: Math.max(1, cap) };
    }

    const reasoningEffort = kwargs["reasoning_effort"] as string | undefined;
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete kwargs["reasoning_effort"];

    if (reasoningEffort !== undefined) {
      kwargs["reasoning"] = {
        effort: reasoningEffort,
        summary: "auto",
      };
      kwargs["include"] = ["reasoning.encrypted_content"];
    }

    for (const key of Object.keys(kwargs)) {
      if (kwargs[key] === undefined) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete kwargs[key];
      }
    }

    try {
      const client = this._createClient(options?.auth);
      const createParams: Record<string, unknown> = {
        model: this._model,
        input,
        tools: tools.map((t) => convert.convertTool(t)),
        store: false,
        stream: this._stream,
        ...kwargs,
      };
      if (systemPrompt) {
        createParams["instructions"] = systemPrompt;
      }
      if (options?.responseFormat !== undefined) {
        createParams["text"] = {
          ...decode.asRawObject(createParams["text"]),
          ...convert.responseFormatToResponsesText(options.responseFormat),
        };
      }

      if (
        !("responses" in client) ||
        typeof (client as { responses?: { create?: unknown } }).responses
          ?.create !== "function"
      ) {
        throw new Error2(
          ProtocolErrors.codes.PROVIDER_API_ERROR,
          "OpenAI SDK version does not support Responses API. Upgrade to >=4.x with responses support.",
        );
      }

      options?.onRequestSent?.();
      const response = await (
        client.responses as {
          create(params: unknown, opts?: unknown): Promise<unknown>;
        }
      ).create(
        createParams,
        options?.signal ? { signal: options.signal } : undefined,
      );
      return new OpenAIResponsesStreamedMessage(
        response,
        this._stream,
        this._convertErrorHook,
      );
    } catch (error: unknown) {
      throw convertOpenAIError(error, this._convertErrorHook);
    }
  }

  private _createClient(auth: ProviderRequestAuth | undefined): OpenAI {
    return resolveAuthBackedClient(
      { cachedClient: this._client, clientFactory: this._clientFactory },
      auth,
      (a) =>
        this._buildClient(
          requireProviderApiKey("OpenAIResponsesChatProvider", a, this._apiKey),
          a,
        ),
    );
  }

  private _buildClient(apiKey: string, auth?: ProviderRequestAuth): OpenAI {
    const clientOpts: Record<string, unknown> = {
      apiKey,
      baseURL: this._baseUrl,
    };
    const defaultHeaders = mergeRequestHeaders(
      this._defaultHeaders,
      auth?.headers,
    );
    if (defaultHeaders !== undefined) {
      clientOpts["defaultHeaders"] = defaultHeaders;
    }
    if (this._httpClient !== undefined) {
      clientOpts["httpClient"] = this._httpClient;
    }
    return new OpenAI(clientOpts as ConstructorParameters<typeof OpenAI>[0]);
  }
}

export function getOpenAIResponsesModelCapability(modelName: string) {
  const normalized = modelName.toLowerCase();
  if (isOpenAIReasoningModel(normalized)) {
    return OPENAI_REASONING_CAPABILITY;
  }
  if (hasModelPrefix(normalized, OPENAI_VISION_TOOL_PREFIXES)) {
    return OPENAI_VISION_TOOL_CAPABILITY;
  }
  return undefined;
}

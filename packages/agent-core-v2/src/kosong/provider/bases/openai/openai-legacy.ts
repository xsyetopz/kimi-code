/**
 * `kosong/provider` domain — OpenAI Chat Completions wire base.
 *
 * The base that actually speaks the Chat Completions wire format — and the
 * vendor host with the widest hook surface. It knows NOTHING about vendors:
 * every vendor deviation arrives as a composed `OpenAIChatCompletionsHooks`
 * set baked into `options.hooks` at construction. The hook consumption style
 * is uniform — "hook first, `undefined` falls back to the base default".
 *
 * Per-turn intent assembly (`_resolveRequestKwargs`) applies overlays in the
 * fixed contract order: cacheKey → sampling → thinking → maxCompletionTokens.
 * The context-window clamp on the completion budget (floor 1) runs BEFORE any
 * hook and cannot be skipped; the 128k ceiling clamp can be taken over by the
 * `withMaxCompletionTokens` hook.
 *
 * Two load-bearing behaviors:
 *
 *  - When `hooks.withThinking` EXISTS, the history-scanning auto-enable of
 *    `reasoning_effort` (issue #1616) is disabled entirely — once a trait
 *    takes over thinking encoding the base must not interfere.
 *  - When `hooks.convertMessage` EXISTS ("trait mode"), the base's
 *    tool-result `extract_text` fallback and tool-declaration-only skip are
 *    handed over to the trait wholesale: every history message is
 *    base-converted, post-processed by the hook, and dropped on `null`.
 */

import OpenAI from "openai";

import type { Message } from "#/kosong/contract/message";
import type {
  ChatProvider,
  GenerateOptions,
  ProviderRequestAuth,
  StreamedMessage,
  ThinkingEffort,
} from "#/kosong/contract/provider";
import type { Tool } from "#/kosong/contract/tool";

import {
  convertOpenAIError,
  extractUsage,
  hasModelPrefix,
  isOpenAIReasoningModel,
  OPENAI_REASONING_CAPABILITY,
  OPENAI_TEXT_TOOL_CAPABILITY,
  OPENAI_VISION_TOOL_CAPABILITY,
  OPENAI_VISION_TOOL_PREFIXES,
} from "./openai-common";
import { ReasoningKeyDialect } from "./reasoning-key";
import {
  mergeRequestHeaders,
  requireProviderApiKey,
  resolveAuthBackedClient,
} from "../request-auth";
import {
  normalizeToolCallIdsForProvider,
} from "../tool-call-id";

import {
  completionTokenKwargs,
  convertHistoryMessages,
  normalizeGenerationKwargs,
  responseFormatToOpenAI,
  usesMaxCompletionTokens,
  type OpenAIChatCompletionsHooks,
  type OpenAILegacyGenerationKwargs,
  type OpenAILegacyOptions,
  OPENAI_CHAT_TOOL_CALL_ID_POLICY,
} from "./openai-legacy-convert";
import { OpenAILegacyStreamedMessage } from "./openai-legacy-stream";

export type {
  OpenAIChatCompletionsHooks,
  OpenAILegacyGenerationKwargs,
  OpenAILegacyOptions,
} from "./openai-legacy-convert";
export { OPENAI_CHAT_TOOL_CALL_ID_POLICY } from "./openai-legacy-convert";

export class OpenAILegacyChatProvider implements ChatProvider {
  readonly name: string = "openai";

  private readonly _model: string;
  private readonly _stream: boolean;
  private readonly _apiKey: string | undefined;
  private readonly _baseUrl: string | undefined;
  private readonly _defaultHeaders: Record<string, string> | undefined;
  private readonly _reasoningKeyDialect: ReasoningKeyDialect;
  private readonly _offEffort: string | undefined;
  private readonly _thinkingEffort: ThinkingEffort | undefined;
  private readonly _generationKwargs: OpenAILegacyGenerationKwargs;
  private readonly _toolMessageConversion: ToolMessageConversion;
  private readonly _client: OpenAI | undefined;
  private readonly _httpClient: unknown;
  private readonly _clientFactory:
    | ((auth: ProviderRequestAuth) => OpenAI)
    | undefined;
  private readonly _hooks: OpenAIChatCompletionsHooks | undefined;

  readonly uploadVideo?: (
    input: string | VideoUploadInput,
    options?: GenerateOptions,
  ) => Promise<VideoURLPart>;

  constructor(options: OpenAILegacyOptions) {
    const apiKey = options.apiKey ?? process.env["OPENAI_API_KEY"];
    this._apiKey =
      apiKey === undefined || apiKey.length === 0 ? undefined : apiKey;
    this._baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
    this._defaultHeaders = options.defaultHeaders;
    this._model = options.model;
    this._stream = options.stream ?? true;
    this._hooks = options.hooks;
    const normalizedReasoningKey = options.reasoningKey?.trim();
    this._reasoningKeyDialect = new ReasoningKeyDialect(
      normalizedReasoningKey !== undefined && normalizedReasoningKey.length > 0
        ? normalizedReasoningKey
        : this._hooks?.reasoningKey?.(),
    );
    this._thinkingEffort = options.thinkingEffort;
    this._offEffort = options.offEffort;
    this._generationKwargs = normalizeGenerationKwargs(
      this._model,
      options.maxTokens !== undefined
        ? completionTokenKwargs(this._model, options.maxTokens)
        : {},
    );
    this._toolMessageConversion = options.toolMessageConversion ?? null;
    this._httpClient = options.httpClient;
    this._clientFactory = options.clientFactory;

    this._client =
      this._apiKey === undefined ? undefined : this._buildClient(this._apiKey);

    const uploadVideo = this._hooks?.uploadVideo;
    if (uploadVideo !== undefined) {
      this.uploadVideo = (input, generateOptions) =>
        uploadVideo(input, generateOptions);
    }
  }

  get modelName(): string {
    return this._model;
  }

  get thinkingEffort(): ThinkingEffort | null {
    return this._thinkingEffort ?? null;
  }

  get maxCompletionTokens(): number | undefined {
    return (
      this._generationKwargs.max_completion_tokens ??
      this._generationKwargs.max_tokens
    );
  }

  async generate(
    systemPrompt: string,
    tools: Tool[],
    history: Message[],
    options?: GenerateOptions,
  ): Promise<StreamedMessage> {
    const { kwargs, reasoningEffort } = this._resolveRequestKwargs(
      history,
      options,
    );

    const preserveThinking = this._hooks?.preserveThinking?.(kwargs) ?? false;
    const reasoningKey = this._reasoningKeyDialect.outboundKey();

    const messages: Record<string, unknown>[] = [];
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }

    const policy =
      this._hooks?.toolCallIdPolicy?.() ?? OPENAI_CHAT_TOOL_CALL_ID_POLICY;
    const normalizedHistory = normalizeToolCallIdsForProvider(history, policy);

    const convertMessageHook = this._hooks?.convertMessage;
    if (convertMessageHook !== undefined) {
      for (const msg of normalizedHistory) {
        const converted = convertMessage(
          msg,
          reasoningKey,
          null,
          preserveThinking,
          false,
        );
        const shaped = convertMessageHook(msg, converted);
        if (shaped !== null) {
          messages.push(shaped);
        }
      }
    } else {
      messages.push(
        ...convertHistoryMessages(
          normalizedHistory,
          reasoningKey,
          this._toolMessageConversion,
          preserveThinking,
        ),
      );
    }

    const merged = this._hooks?.mergeHistory?.(messages);
    const finalMessages = merged ?? messages;

    const createParams: Record<string, unknown> = {
      model: this._model,
      messages: finalMessages,
      stream: this._stream,
      ...kwargs,
    };

    if (tools.length > 0) {
      const convertTool =
        this._hooks?.convertTool ?? ((tool: Tool) => toolToOpenAI(tool));
      createParams["tools"] = tools.map((tool) => convertTool(tool));
    }
    if (options?.responseFormat !== undefined) {
      createParams["response_format"] = responseFormatToOpenAI(
        options.responseFormat,
      );
    }

    if (this._stream) {
      createParams["stream_options"] = { include_usage: true };
    }

    if (reasoningEffort !== undefined) {
      createParams["reasoning_effort"] = reasoningEffort;
    }

    const builtParams = this._hooks?.buildParams?.(createParams);
    const finalParams = builtParams ?? createParams;

    try {
      const client = this._createClient(options?.auth);
      options?.onRequestSent?.();
      const { data, response } = await client.chat.completions
        .create(
          finalParams as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
          options?.signal ? { signal: options.signal } : undefined,
        )
        .withResponse();
      return new OpenAILegacyStreamedMessage(
        data as unknown as
          | OpenAI.Chat.ChatCompletion
          | AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
        this._stream,
        this._reasoningKeyDialect,
        parseTraceId(response.headers),
        this._hooks?.extractUsage,
        this._hooks?.convertError,
      );
    } catch (error: unknown) {
      throw convertOpenAIError(error, this._hooks?.convertError);
    }
  }

  private _resolveRequestKwargs(
    history: readonly Message[],
    options: GenerateOptions | undefined,
  ): { kwargs: Record<string, unknown>; reasoningEffort: string | undefined } {
    let kwargs: Record<string, unknown> = { ...this._generationKwargs };

    if (options?.cacheKey !== undefined) {
      const hooked = this._hooks?.cacheKey?.(options.cacheKey);
      kwargs = {
        ...kwargs,
        ...(hooked ?? { prompt_cache_key: options.cacheKey }),
      };
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
    let explicitThinkingEffort: ThinkingEffort | undefined;
    if (thinking !== undefined) {
      const hooked = this._hooks?.withThinking?.(
        thinking.effort,
        { keep: thinking.keep },
        kwargs,
      );
      if (hooked !== undefined) {
        kwargs = { ...kwargs, ...hooked };
      } else {
        explicitThinkingEffort = thinking.effort;
      }
    }

    let reasoningEffort: string | undefined =
      explicitThinkingEffort === "off"
        ? this._offEffort
        : explicitThinkingEffort === undefined ||
            explicitThinkingEffort === "on"
          ? undefined
          : explicitThinkingEffort;

    if (
      reasoningEffort === undefined &&
      explicitThinkingEffort !== "off" &&
      kwargs["reasoning_effort"] === undefined &&
      this._hooks?.withThinking === undefined
    ) {
      const hasThinkPart = history.some((message) =>
        message.content.some((part) => part.type === "think"),
      );
      if (hasThinkPart) {
        reasoningEffort = "medium";
      }
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
      cap = Math.max(1, cap);
      const hooked = this._hooks?.withMaxCompletionTokens?.(cap);
      if (hooked !== undefined) {
        kwargs = { ...kwargs, ...hooked };
      } else {
        const capped = Math.min(
          cap,
          CHAT_COMPLETIONS_MAX_OUTPUT_TOKENS_CEILING,
        );
        kwargs = {
          ...kwargs,
          ...completionTokenKwargs(this._model, Math.max(1, capped)),
        };
      }
    }

    for (const key of Object.keys(kwargs)) {
      if (kwargs[key] === undefined) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete kwargs[key];
      }
    }

    return { kwargs, reasoningEffort };
  }

  private _createClient(auth: ProviderRequestAuth | undefined): OpenAI {
    return resolveAuthBackedClient(
      { cachedClient: this._client, clientFactory: this._clientFactory },
      auth,
      (a) =>
        this._buildClient(
          requireProviderApiKey("OpenAILegacyChatProvider", a, this._apiKey),
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


export function getOpenAILegacyModelCapability(modelName: string) {
  const normalized = modelName.toLowerCase();
  if (isOpenAIReasoningModel(normalized)) {
    return OPENAI_REASONING_CAPABILITY;
  }
  if (hasModelPrefix(normalized, OPENAI_VISION_TOOL_PREFIXES)) {
    return OPENAI_VISION_TOOL_CAPABILITY;
  }
  if (normalized.startsWith("gpt-3.5-turbo")) {
    return OPENAI_TEXT_TOOL_CAPABILITY;
  }
  return undefined;
}

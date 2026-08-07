/**
 * `kosong/provider` domain — Anthropic Messages wire base.
 *
 * Speaks the Anthropic Messages wire format: system blocks with ephemeral
 * cache control, tool-result user blocks, consecutive-user merging, beta
 * headers vs the beta endpoint, and the thinking profile matrix (budget vs
 * adaptive).
 *
 * The hook surface is `withThinking` plus `convertError`. `withThinking`
 * lets a vendor dialect running over this transport re-encode the thinking
 * intent; when the per-turn thinking intent carries `keep`, the BASE
 * overlays the context-management edit uniformly on top of whatever
 * thinking encoding happened (hook or base path), so a trait never handles
 * `keep` itself.
 *
 * `convertAnthropicError`'s FIRST line is the contract's `throwIfAbortError`
 * guard: a user cancellation is THROWN as the standard abort DOMException at
 * the very front of the classification chain. After the guard,
 * already-converted `ChatProviderError`s pass through untouched; only then is
 * the trait-composed `convertError` hook consulted, so a vendor riding this
 * transport classifies each RAW SDK failure exactly once before the base
 * rules run.
 */

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
  MessageCreateParamsStreaming,
  MessageParam,
  MessageStreamEvent,
  RawContentBlockDeltaEvent,
  RawContentBlockStartEvent,
  RawMessageStartEvent,
  TextBlockParam,
  ThinkingBlockParam,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from "@anthropic-ai/sdk/resources/messages/messages.js";

import {
  APIConnectionError,
  APITimeoutError,
  ChatProviderError,
  classifyBaseApiError,
  normalizeAPIStatusError,
  parseRetryAfterMs,
  throwIfAbortError,
} from "#/kosong/contract/errors";
import type {
  ContentPart,
  Message,
  StreamedMessagePart,
  ToolCall,
} from "#/kosong/contract/message";
import { isToolDeclarationOnlyMessage } from "#/kosong/contract/message";
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

import {
  BUDGET_THINKING_EFFORTS,
  inferAnthropicModelProfile,
  matchKnownAnthropicModelProfile,
  parseAnthropicModelVersion,
  type AnthropicModelProfile,
  type AnthropicModelVersion,
} from "./anthropic-profile";
import { mergeConsecutiveUserMessages } from "../merge-user-messages";
import { mergeRequestHeaders, resolveAuthBackedClient } from "../request-auth";
import {
  normalizeToolCallIdsForProvider,
  sanitizeToolCallId,
} from "../tool-call-id";

import { AnthropicStreamedMessage } from "./anthropic.stream";
import {
  applyThinkingKeep,
  convertAnthropicError,
  resolveDefaultMaxTokens,
} from "./anthropic.convert";
export { getAnthropicModelCapability } from "./anthropic.convert";

export class AnthropicChatProvider implements ChatProvider {
  readonly name: string = "anthropic";

  private readonly _model: string;
  private readonly _stream: boolean;
  private readonly _client: Anthropic | undefined;
  private readonly _generationKwargs: AnthropicGenerationKwargs;
  private readonly _metadata: Record<string, string> | undefined;
  private readonly _apiKey: string | undefined;
  private readonly _baseUrl: string | undefined;
  private readonly _defaultHeaders: Record<string, string | null> | undefined;
  private readonly _clientFactory:
    | ((auth: ProviderRequestAuth) => Anthropic)
    | undefined;
  private readonly _adaptiveThinking: boolean | undefined;
  private readonly _supportEfforts: readonly string[] | undefined;
  private readonly _betaApi: boolean;
  private readonly _thinkingEffort: ThinkingEffort | undefined;
  private readonly _explicitMaxTokens: boolean;
  private readonly _hooks: AnthropicHooks | undefined;

  constructor(options: AnthropicOptions) {
    this._model = options.model;
    this._stream = options.stream ?? true;
    this._metadata = options.metadata;
    this._adaptiveThinking = options.adaptiveThinking;
    this._supportEfforts = options.supportEfforts;
    this._betaApi = options.betaApi ?? false;
    this._thinkingEffort = options.thinkingEffort;
    this._hooks = options.hooks;
    this._apiKey =
      options.apiKey === undefined || options.apiKey.length === 0
        ? undefined
        : options.apiKey;
    this._baseUrl = options.baseUrl;
    this._defaultHeaders = options.defaultHeaders;
    this._clientFactory = options.clientFactory;
    this._client =
      this._apiKey === undefined ? undefined : this._buildClient(this._apiKey);
    this._explicitMaxTokens = options.defaultMaxTokens !== undefined;
    this._generationKwargs = {
      max_tokens:
        options.defaultMaxTokens ?? resolveDefaultMaxTokens(options.model),
      betaFeatures: options.betaFeatures ?? [INTERLEAVED_THINKING_BETA],
    };
  }

  get modelName(): string {
    return this._model;
  }

  get thinkingEffort(): ThinkingEffort | null {
    return this._thinkingEffort ?? null;
  }

  get maxCompletionTokens(): number | undefined {
    return this._generationKwargs.max_tokens;
  }

  async generate(
    systemPrompt: string,
    tools: Tool[],
    history: Message[],
    options?: GenerateOptions,
  ): Promise<StreamedMessage> {
    const system: TextBlockParam[] | undefined = systemPrompt
      ? [
          {
            type: "text",
            text: systemPrompt,
            cache_control: CACHE_CONTROL,
          } as TextBlockParam,
        ]
      : undefined;

    const messages = mergeConsecutiveUserMessages(
      normalizeToolCallIdsForProvider(
        history.filter((msg) => !isToolDeclarationOnlyMessage(msg)),
        ANTHROPIC_TOOL_CALL_ID_POLICY,
      )
        .map((msg) => convertMessage(msg, this._model))
        .filter(shouldKeepConvertedMessage),
      {
        isUser: (message) => message.role === "user",
        isToolResultOnly,
        merge: (last, next) => ({
          ...last,
          content: [
            ...(last.content as ContentBlockParam[]),
            ...(next.content as ContentBlockParam[]),
          ],
        }),
      },
    );

    injectCacheControlOnLastBlock(messages);

    let kwargs: AnthropicGenerationKwargs = { ...this._generationKwargs };
    let useBetaApi = this._betaApi;

    let metadata = this._metadata;
    if (options?.cacheKey !== undefined) {
      metadata = { ...metadata, user_id: options.cacheKey };
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
      const hooked = this._hooks?.withThinking?.(
        thinking.effort,
        { keep: thinking.keep },
        { ...kwargs },
      );
      if (hooked !== undefined) {
        kwargs = { ...kwargs, ...hooked };
      } else {
        kwargs = {
          ...kwargs,
          ...this._encodeThinking(thinking.effort, kwargs),
        };
      }
      if (thinking.keep !== undefined) {
        kwargs = { ...kwargs, ...applyThinkingKeep(kwargs, thinking.keep) };
        useBetaApi = true;
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
      const requestedCap = resolveDefaultMaxTokens(this._model, cap);
      const existingCap = kwargs.max_tokens;
      kwargs = {
        ...kwargs,
        max_tokens:
          existingCap === undefined || this._explicitMaxTokens
            ? (existingCap ?? requestedCap)
            : Math.min(existingCap, requestedCap),
      };
    }

    const requestKwargs: Record<string, unknown> = {};
    if (kwargs.max_tokens !== undefined) {
      requestKwargs["max_tokens"] = kwargs.max_tokens;
    }
    if (kwargs.temperature !== undefined) {
      requestKwargs["temperature"] = kwargs.temperature;
    }
    if (kwargs.top_k !== undefined) {
      requestKwargs["top_k"] = kwargs.top_k;
    }
    if (kwargs.top_p !== undefined) {
      requestKwargs["top_p"] = kwargs.top_p;
    }
    if (kwargs.thinking !== undefined) {
      requestKwargs["thinking"] = kwargs.thinking;
    }
    if (kwargs.output_config !== undefined) {
      requestKwargs["output_config"] = kwargs.output_config;
    }
    if (kwargs.contextManagement !== undefined) {
      requestKwargs["context_management"] = kwargs.contextManagement;
    }
    applyResponseFormat(requestKwargs, options?.responseFormat);

    const betas = kwargs.betaFeatures ?? [];
    const extraHeaders: Record<string, string> = {};
    if (!useBetaApi && betas.length > 0) {
      extraHeaders["anthropic-beta"] = betas.join(",");
    }

    const anthropicTools: AnthropicToolParam[] = tools.map((t) =>
      convertTool(t),
    );
    if (anthropicTools.length > 0) {
      const lastTool = anthropicTools.at(-1);
      if (lastTool !== undefined) {
        lastTool.cache_control = CACHE_CONTROL;
      }
    }

    const createParams: Record<string, unknown> = {
      model: this._model,
      messages,
      ...requestKwargs,
    };

    if (system !== undefined) {
      createParams["system"] = system;
    }

    if (anthropicTools.length > 0) {
      createParams["tools"] = anthropicTools;
    }

    if (metadata !== undefined) {
      createParams["metadata"] = metadata;
    }

    if (useBetaApi && betas.length > 0) {
      createParams["betas"] = betas;
    }

    const requestOptions: Record<string, unknown> = {};
    const headers = mergeRequestHeaders(extraHeaders, options?.auth?.headers);
    if (headers !== undefined) {
      requestOptions["headers"] = headers;
    }
    if (options?.signal) {
      requestOptions["signal"] = options.signal;
    }
    const finalRequestOptions =
      Object.keys(requestOptions).length > 0 ? requestOptions : undefined;
    const client = this._createClient(options?.auth);
    options?.onRequestSent?.();

    if (this._stream) {
      try {
        const stream = useBetaApi
          ? await client.beta.messages.create(
              {
                ...createParams,
                stream: true,
              } as unknown as MessageCreateParamsStreaming,
              finalRequestOptions,
            )
          : await client.messages.create(
              {
                ...createParams,
                stream: true,
              } as unknown as MessageCreateParamsStreaming,
              finalRequestOptions,
            );
        return new AnthropicStreamedMessage(
          stream,
          true,
          this._hooks?.convertError,
        );
      } catch (error: unknown) {
        throw convertAnthropicError(error, this._hooks?.convertError);
      }
    }

    try {
      const response = useBetaApi
        ? await client.beta.messages.create(
            {
              ...createParams,
              stream: false,
            } as unknown as MessageCreateParams,
            finalRequestOptions,
          )
        : await client.messages.create(
            {
              ...createParams,
              stream: false,
            } as unknown as MessageCreateParams,
            finalRequestOptions,
          );
      return new AnthropicStreamedMessage(
        response,
        false,
        this._hooks?.convertError,
      );
    } catch (error: unknown) {
      throw convertAnthropicError(error, this._hooks?.convertError);
    }
  }

  private _encodeThinking(
    effort: ThinkingEffort,
    kwargs: AnthropicGenerationKwargs,
  ): AnthropicGenerationKwargs {
    const profile = resolveThinkingProfile(
      this._model,
      this._supportEfforts,
      this._adaptiveThinking,
    );

    let newBetas = [...(kwargs.betaFeatures ?? [])];
    if (profile.mode === "adaptive") {
      newBetas = newBetas.filter((b) => b !== INTERLEAVED_THINKING_BETA);
    }

    if (effort === "off") {
      return {
        thinking: { type: "disabled" },
        output_config: undefined,
        betaFeatures: newBetas,
      };
    }

    if (profile.mode === "adaptive") {
      return {
        thinking: { type: "adaptive", display: "summarized" },
        output_config:
          effort === "on"
            ? undefined
            : ({ effort } as MessageCreateParams["output_config"]),
        betaFeatures: newBetas,
      };
    }

    const budgetTokens = budgetTokensForEffort(effort);
    const patch: AnthropicGenerationKwargs = {
      thinking:
        budgetTokens === undefined
          ? ({ type: "enabled" } as MessageCreateParams["thinking"])
          : { type: "enabled", budget_tokens: budgetTokens },
      betaFeatures: newBetas,
    };
    if (
      (profile.supportsEffortParam || budgetTokens === undefined) &&
      effort !== "on"
    ) {
      patch.output_config = { effort } as MessageCreateParams["output_config"];
    } else {
      patch.output_config = undefined;
    }
    return patch;
  }

  private _createClient(auth: ProviderRequestAuth | undefined): Anthropic {
    return resolveAuthBackedClient(
      { cachedClient: this._client, clientFactory: this._clientFactory },
      auth,
      (a) => this._buildClient(this._requireApiKey(a)),
    );
  }

  private _requireApiKey(auth: ProviderRequestAuth | undefined): string {
    const apiKey = auth?.apiKey ?? this._apiKey;
    if (apiKey === undefined || apiKey.length === 0) {
      throw new ChatProviderError(
        "AnthropicChatProvider: apiKey is required. Provide it via constructor options, options.auth.apiKey on each request, or an OAuth login. The Anthropic adapter does not read shell API-key environment variables.",
      );
    }
    return apiKey;
  }

  private _anthropicCustomHeaderEnvNames(): string[] {
    const customHeaders = process.env["ANTHROPIC_CUSTOM_HEADERS"];
    if (customHeaders === undefined || customHeaders.length === 0) return [];

    const names: string[] = [];
    for (const line of customHeaders.split("\n")) {
      const colonIndex = line.indexOf(":");
      if (colonIndex < 0) continue;

      const name = line.slice(0, colonIndex).trim().toLowerCase();
      if (name.length > 0) names.push(name);
    }
    return names;
  }

  private _buildDefaultHeaders(apiKey: string): Record<string, string | null> {
    const defaultHeaders: Record<string, string | null> = {
      authorization: null,
    };
    for (const name of this._anthropicCustomHeaderEnvNames()) {
      defaultHeaders[name] = null;
    }
    for (const [name, value] of Object.entries(this._defaultHeaders ?? {})) {
      defaultHeaders[name.toLowerCase()] = value;
    }
    defaultHeaders["x-api-key"] = apiKey;
    return defaultHeaders;
  }

  private _buildClient(apiKey: string): Anthropic {
    return new Anthropic({
      apiKey,
      authToken: null,
      baseURL: this._baseUrl ?? null,
      defaultHeaders: this._buildDefaultHeaders(apiKey),
    });
  }
}

/**
 * `kosong/provider` domain — Google GenAI (Gemini) wire base.
 *
 * Speaks the Gemini generateContent wire format (and Vertex AI through the
 * same SDK options). This base carries no hook surface today — per-turn
 * intents are encoded inline; a cache key has no native field here and is
 * silently dropped, which is the intended "dialect decides whether to encode
 * an intent" behavior.
 *
 * The local `createAbortError` copy is DELIBERATELY not deduplicated: this
 * module's abort plumbing (abortPromise racing,
 * per-chunk checks, the catch guard that rethrows DOMException aborts before
 * error conversion) is self-contained by design.
 */

import {
  GoogleGenAI as GenAIClient,
} from "@google/genai";

import type {
  Message,
} from "#/kosong/contract/message";
import type {
  ChatProvider,
  GenerateOptions,
  ProviderRequestAuth,
  StreamedMessage,
  ThinkingEffort,
} from "#/kosong/contract/provider";
import type { Tool } from "#/kosong/contract/tool";

import {
  requireProviderApiKey,
  resolveAuthBackedClient,
} from "../request-auth";

import {
  applyResponseFormat,
  messagesToGoogleGenAIContents,
  toolToGoogleGenAI,
  type GoogleGenAIGenerationKwargs,
  type GoogleGenAIOptions,
  type ThinkingConfig,
} from "./google-genai-convert";
import { GoogleGenAIStreamedMessage } from "./google-genai-stream";
import {
  abortPromise,
  convertGoogleGenAIError,
  createAbortError,
} from "./google-genai-errors";

export type { GoogleGenAIGenerationKwargs, GoogleGenAIOptions } from "./google-genai-convert";
export { messagesToGoogleGenAIContents } from "./google-genai-convert";
export { convertGoogleGenAIError } from "./google-genai-errors";

export class GoogleGenAIChatProvider implements ChatProvider {
  readonly name: string = "google_genai";

  private readonly _model: string;
  private readonly _client: GenAIClient | undefined;
  private readonly _generationKwargs: GoogleGenAIGenerationKwargs;
  private readonly _vertexai: boolean;
  private readonly _stream: boolean;
  private readonly _apiKey: string | undefined;
  private readonly _baseUrl: string | undefined;
  private readonly _project: string | undefined;
  private readonly _location: string | undefined;
  private readonly _thinkingEffort: ThinkingEffort | undefined;
  private readonly _defaultHeaders: Record<string, string> | undefined;
  private readonly _clientFactory:
    | ((auth: ProviderRequestAuth) => GenAIClient)
    | undefined;

  constructor(options: GoogleGenAIOptions) {
    this._model = options.model;
    this._vertexai = options.vertexai ?? false;
    this._stream = options.stream ?? true;
    this._thinkingEffort = options.thinkingEffort;
    this._generationKwargs = {};

    const apiKey = options.apiKey ?? process.env["GOOGLE_API_KEY"];
    this._apiKey =
      apiKey === undefined || apiKey.length === 0 ? undefined : apiKey;
    this._baseUrl =
      options.baseUrl === undefined || options.baseUrl.length === 0
        ? undefined
        : options.baseUrl;
    this._project = options.project;
    this._location = options.location;
    this._defaultHeaders = options.defaultHeaders;
    this._clientFactory = options.clientFactory;
    this._client =
      this._vertexai || this._apiKey !== undefined
        ? this._buildClient(this._apiKey)
        : undefined;
  }

  private _buildClient(apiKey: string | undefined): GenAIClient {
    const httpOptions: { headers?: Record<string, string>; baseUrl?: string } =
      {};
    if (this._defaultHeaders !== undefined) {
      httpOptions.headers = this._defaultHeaders;
    }
    if (this._baseUrl !== undefined) {
      httpOptions.baseUrl = this._baseUrl;
    }
    return new GenAIClient({
      apiKey,
      ...(this._vertexai
        ? {
            vertexai: true,
            project: this._project,
            location: this._location,
          }
        : {}),
      httpOptions:
        Object.keys(httpOptions).length > 0 ? httpOptions : undefined,
    });
  }

  get modelName(): string {
    return this._model;
  }

  get thinkingEffort(): ThinkingEffort | null {
    return this._thinkingEffort ?? null;
  }

  get maxCompletionTokens(): number | undefined {
    return this._generationKwargs.maxOutputTokens;
  }

  async generate(
    systemPrompt: string,
    tools: Tool[],
    history: Message[],
    options?: GenerateOptions,
  ): Promise<StreamedMessage> {
    if (options?.signal?.aborted === true) {
      throw createAbortError();
    }

    const contents = messagesToGoogleGenAIContents(history);

    let kwargs: GoogleGenAIGenerationKwargs = { ...this._generationKwargs };

    if (options?.sampling?.temperature !== undefined) {
      kwargs = { ...kwargs, temperature: options.sampling.temperature };
    }
    if (options?.sampling?.topP !== undefined) {
      kwargs = { ...kwargs, topP: options.sampling.topP };
    }

    const thinking =
      options?.thinking ??
      (this._thinkingEffort !== undefined
        ? { effort: this._thinkingEffort }
        : undefined);
    if (thinking !== undefined) {
      kwargs = {
        ...kwargs,
        thinkingConfig: this._encodeThinking(thinking.effort),
      };
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
      kwargs = { ...kwargs, maxOutputTokens: Math.max(1, cap) };
    }

    const config: Record<string, unknown> = {
      ...kwargs,
      systemInstruction: systemPrompt,
      ...(tools.length > 0
        ? { tools: tools.map((t) => toolToGoogleGenAI(t)) }
        : {}),
    };
    applyResponseFormat(config, options?.responseFormat);

    try {
      const client = this._createClient(options?.auth);
      const models = client.models as unknown as {
        generateContent(params: Record<string, unknown>): Promise<unknown>;
        generateContentStream(
          params: Record<string, unknown>,
        ): Promise<AsyncGenerator>;
      };

      const params = { model: this._model, contents, config };

      options?.onRequestSent?.();
      if (this._stream) {
        const stream = await Promise.race([
          models.generateContentStream(params),
          abortPromise(options?.signal),
        ]);
        return new GoogleGenAIStreamedMessage(
          stream as AsyncIterable<Record<string, unknown>>,
          true,
          options?.signal,
        );
      }

      const response = await Promise.race([
        models.generateContent(params),
        abortPromise(options?.signal),
      ]);
      return new GoogleGenAIStreamedMessage(
        response as Record<string, unknown>,
        false,
        options?.signal,
      );
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      throw convertGoogleGenAIError(error);
    }
  }

  private _encodeThinking(effort: ThinkingEffort): ThinkingConfig {
    const thinkingConfig: ThinkingConfig = { includeThoughts: true };

    if (this._model.includes("gemini-3")) {
      switch (effort) {
        case "off":
          thinkingConfig.thinkingLevel = "MINIMAL";
          thinkingConfig.includeThoughts = false;
          break;
        case "low":
          thinkingConfig.thinkingLevel = "LOW";
          break;
        case "medium":
          thinkingConfig.thinkingLevel = "MEDIUM";
          break;
        case "high":
        case "xhigh":
        case "max":
          thinkingConfig.thinkingLevel = "HIGH";
          break;
      }
    } else {
      switch (effort) {
        case "off":
          thinkingConfig.thinkingBudget = 0;
          thinkingConfig.includeThoughts = false;
          break;
        case "low":
          thinkingConfig.thinkingBudget = 1024;
          thinkingConfig.includeThoughts = true;
          break;
        case "medium":
          thinkingConfig.thinkingBudget = 4096;
          thinkingConfig.includeThoughts = true;
          break;
        case "high":
        case "xhigh":
        case "max":
          thinkingConfig.thinkingBudget = 32_000;
          thinkingConfig.includeThoughts = true;
          break;
      }
    }

    return thinkingConfig;
  }

  private _createClient(auth: ProviderRequestAuth | undefined): GenAIClient {
    return resolveAuthBackedClient(
      { cachedClient: this._client, clientFactory: this._clientFactory },
      auth,
      (a) => {
        if (this._vertexai) return this._buildClient(this._apiKey);
        return this._buildClient(
          requireProviderApiKey("GoogleGenAIChatProvider", a, this._apiKey),
        );
      },
    );
  }
}

const GEMINI_CATALOGUED_PREFIXES = [
  "gemini-1.5-pro",
  "gemini-1.5-flash",
  "gemini-2.0-flash",
  "gemini-2.0-pro",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
] as const;

const GEMINI_MULTIMODAL_TOOL_CAPABILITY = Object.freeze({
  image_in: true,
  video_in: true,
  audio_in: true,
  thinking: false,
  tool_use: true,
  max_context_tokens: 0,
});

const GEMINI_THINKING_MULTIMODAL_TOOL_CAPABILITY = Object.freeze({
  image_in: true,
  video_in: true,
  audio_in: true,
  thinking: true,
  tool_use: true,
  max_context_tokens: 0,
});

export function getGoogleGenAIModelCapability(modelName: string) {
  const normalized = modelName.toLowerCase();
  if (!normalized.startsWith("gemini-")) return undefined;
  if (
    !GEMINI_CATALOGUED_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  ) {
    return undefined;
  }

  if (normalized.startsWith("gemini-2.5-") || normalized.includes("thinking")) {
    return GEMINI_THINKING_MULTIMODAL_TOOL_CAPABILITY;
  }
  return GEMINI_MULTIMODAL_TOOL_CAPABILITY;
}

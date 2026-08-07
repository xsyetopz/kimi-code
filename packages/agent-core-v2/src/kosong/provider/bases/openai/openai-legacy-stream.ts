/**
 * `kosong/provider` domain — OpenAI Chat Completions streamed response adapter.
 */

import OpenAI from "openai";

import type { ChatProviderError } from "#/kosong/contract/errors";
import type { StreamedMessagePart, ToolCall } from "#/kosong/contract/message";
import type { FinishReason, StreamedMessage } from "#/kosong/contract/provider";
import type { TokenUsage } from "#/kosong/contract/usage";

import { ReasoningKeyDialect } from "./reasoning-key";

import {
  convertChatCompletionStreamToolCall,
  type BufferedChatCompletionToolCall,
} from "./chat-completions-stream";
import {
  convertOpenAIError,
  extractUsage,
  isFunctionToolCall,
  normalizeOpenAIFinishReason,
} from "./openai-common";

export class OpenAILegacyStreamedMessage implements StreamedMessage {
  private _id: string | null = null;
  private _usage: TokenUsage | null = null;
  private _finishReason: FinishReason | null = null;
  private _rawFinishReason: string | null = null;
  private readonly _iter: AsyncGenerator<StreamedMessagePart>;

  constructor(
    response:
      | OpenAI.Chat.ChatCompletion
      | AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
    isStream: boolean,
    reasoningKeyDialect: ReasoningKeyDialect,
    private readonly _traceId: string | null,
    private readonly _extractUsageHook?:
      | ((
          chunk: Record<string, unknown>,
        ) => Record<string, unknown> | null | undefined)
      | undefined,
    private readonly _convertErrorHook?:
      | ((error: unknown) => ChatProviderError | undefined)
      | undefined,
  ) {
    if (isStream) {
      this._iter = this._convertStreamResponse(
        response as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
        reasoningKeyDialect,
      );
    } else {
      this._iter = this._convertNonStreamResponse(
        response as OpenAI.Chat.ChatCompletion,
        reasoningKeyDialect,
      );
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

  get traceId(): string | null {
    return this._traceId;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
    yield* this._iter;
  }

  private _captureFinishReason(raw: string | null | undefined): void {
    const normalized = normalizeOpenAIFinishReason(raw);
    this._finishReason = normalized.finishReason;
    this._rawFinishReason = normalized.rawFinishReason;
  }

  private _captureUsage(raw: Record<string, unknown>, fallback: unknown): void {
    const hooked = this._extractUsageHook?.(raw);
    const rawUsage = hooked !== undefined ? hooked : fallback;
    if (rawUsage !== null && rawUsage !== undefined) {
      this._usage = extractUsage(rawUsage) ?? null;
    }
  }

  private async *_convertNonStreamResponse(
    response: OpenAI.Chat.ChatCompletion,
    reasoningKeyDialect: ReasoningKeyDialect,
  ): AsyncGenerator<StreamedMessagePart> {
    this._id = response.id;
    this._captureUsage(
      response as unknown as Record<string, unknown>,
      response.usage,
    );
    this._captureFinishReason(response.choices[0]?.finish_reason ?? null);

    const message = response.choices[0]?.message;
    if (!message) return;

    const reasoning = reasoningKeyDialect.observe(message);
    if (reasoning !== undefined) {
      yield { type: "think", think: reasoning } satisfies StreamedMessagePart;
    }

    if (message.content) {
      yield {
        type: "text",
        text: message.content,
      } satisfies StreamedMessagePart;
    }

    if (message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        if (!isFunctionToolCall(toolCall)) continue;
        yield {
          type: "function",
          id: toolCall.id || crypto.randomUUID(),
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        } satisfies ToolCall;
      }
    }
  }

  private async *_convertStreamResponse(
    response: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
    reasoningKeyDialect: ReasoningKeyDialect,
  ): AsyncGenerator<StreamedMessagePart> {
    const bufferedToolCalls = new Map<
      number | string,
      BufferedChatCompletionToolCall
    >();

    try {
      for await (const chunk of response) {
        if (chunk.id) {
          this._id = chunk.id;
        }

        this._captureUsage(
          chunk as unknown as Record<string, unknown>,
          chunk.usage,
        );

        if (!chunk.choices || chunk.choices.length === 0) {
          continue;
        }

        const choice = chunk.choices[0];
        if (!choice) continue;

        if (
          choice.finish_reason !== null &&
          choice.finish_reason !== undefined
        ) {
          this._captureFinishReason(choice.finish_reason);
        }

        const delta = choice.delta;

        const reasoning = reasoningKeyDialect.observe(delta);
        if (reasoning !== undefined) {
          yield {
            type: "think",
            think: reasoning,
          } satisfies StreamedMessagePart;
        }

        if (delta.content) {
          yield {
            type: "text",
            text: delta.content,
          } satisfies StreamedMessagePart;
        }

        for (const toolCall of delta.tool_calls ?? []) {
          for (const part of convertChatCompletionStreamToolCall(
            toolCall,
            bufferedToolCalls,
          )) {
            yield part;
          }
        }
      }
    } catch (error: unknown) {
      throw convertOpenAIError(error, this._convertErrorHook);
    }
  }
}


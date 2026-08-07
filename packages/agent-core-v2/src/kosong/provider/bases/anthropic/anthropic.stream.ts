/**
 * `kosong/provider` domain — Anthropic streaming message adapter.
 */

import type {
  MessageStreamEvent,
  RawContentBlockDeltaEvent,
  RawContentBlockStartEvent,
  RawMessageStartEvent,
} from "@anthropic-ai/sdk/resources/messages/messages.js";

import type { ChatProviderError } from "#/kosong/contract/errors";
import type { StreamedMessagePart, ToolCall } from "#/kosong/contract/message";
import type { FinishReason, StreamedMessage } from "#/kosong/contract/provider";
import type { TokenUsage } from "#/kosong/contract/usage";

import {
  convertAnthropicError,
  normalizeAnthropicStopReason,
} from "./anthropic.convert";

export class AnthropicStreamedMessage implements StreamedMessage {
  private _id: string | null = null;
  private _usage: TokenUsage = {
    inputOther: 0,
    output: 0,
    inputCacheRead: 0,
    inputCacheCreation: 0,
  };
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
        response as AsyncIterable<MessageStreamEvent>,
      );
    } else {
      this._iter = this._convertNonStreamResponse(
        response as {
          id: string;
          stop_reason?: string | null;
          usage: {
            input_tokens: number;
            output_tokens: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
          content: Array<{
            type: string;
            text?: string;
            thinking?: string;
            signature?: string;
            data?: string;
            id?: string;
            name?: string;
            input?: unknown;
          }>;
        },
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

  async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
    yield* this._iter;
  }

  private _captureStopReason(raw: string | null | undefined): void {
    const normalized = normalizeAnthropicStopReason(raw);
    this._finishReason = normalized.finishReason;
    this._rawFinishReason = normalized.rawFinishReason;
  }

  private _extractUsage(usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  }): void {
    this._usage = {
      inputOther: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      inputCacheRead: usage.cache_read_input_tokens ?? 0,
      inputCacheCreation: usage.cache_creation_input_tokens ?? 0,
    };
  }

  private async *_convertNonStreamResponse(response: {
    id: string;
    stop_reason?: string | null;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    content: Array<{
      type: string;
      text?: string;
      thinking?: string;
      signature?: string;
      data?: string;
      id?: string;
      name?: string;
      input?: unknown;
    }>;
  }): AsyncGenerator<StreamedMessagePart> {
    this._id = response.id;
    this._extractUsage(response.usage);
    this._captureStopReason(response.stop_reason);

    for (const block of response.content) {
      switch (block.type) {
        case "text":
          if (block.text !== undefined) {
            yield { type: "text", text: block.text };
          }
          break;
        case "thinking":
          yield block.signature !== undefined
            ? {
                type: "think" as const,
                think: block.thinking ?? "",
                encrypted: block.signature,
              }
            : { type: "think" as const, think: block.thinking ?? "" };
          break;
        case "redacted_thinking":
          yield block.data !== undefined
            ? { type: "think" as const, think: "", encrypted: block.data }
            : { type: "think" as const, think: "" };
          break;
        case "tool_use":
          yield {
            type: "function",
            id: block.id ?? crypto.randomUUID(),
            name: block.name ?? "",
            arguments:
              block.input !== undefined ? JSON.stringify(block.input) : null,
          } satisfies ToolCall;
          break;
      }
    }
  }

  private async *_convertStreamResponse(
    response: AsyncIterable<MessageStreamEvent>,
  ): AsyncGenerator<StreamedMessagePart> {
    const toolUseBlockIndexes = new Set<number>();

    try {
      for await (const event of response) {
        const evt = event as unknown as Record<string, unknown>;
        const eventType = evt["type"] as string;

        if (eventType === "message_start") {
          const startEvt = evt as unknown as RawMessageStartEvent;
          this._id = startEvt.message.id;
          this._extractUsage(
            startEvt.message.usage as {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            },
          );
        } else if (eventType === "content_block_start") {
          const blockEvt = evt as unknown as RawContentBlockStartEvent;
          const block = blockEvt.content_block;
          const blockIndex = blockEvt.index;
          // eslint-disable-next-line typescript-eslint/switch-exhaustiveness-check
          switch (block.type) {
            case "text":
              yield { type: "text", text: block.text };
              break;
            case "thinking":
              yield { type: "think", think: block.thinking ?? "" };
              break;
            case "redacted_thinking":
              yield {
                type: "think",
                think: "",
                encrypted: (block as unknown as { data: string }).data,
              };
              break;
            case "tool_use":
              toolUseBlockIndexes.add(blockIndex);
              yield {
                type: "function",
                id: block.id,
                name: block.name,
                arguments: "",
                _streamIndex: blockIndex,
              } satisfies ToolCall;
              break;
          }
        } else if (eventType === "content_block_delta") {
          const deltaEvt = evt as unknown as RawContentBlockDeltaEvent;
          const delta = deltaEvt.delta;
          const blockIndex = deltaEvt.index;
          // eslint-disable-next-line typescript-eslint/switch-exhaustiveness-check
          switch (delta.type) {
            case "text_delta":
              yield { type: "text", text: delta.text };
              break;
            case "thinking_delta":
              yield { type: "think", think: delta.thinking ?? "" };
              break;
            case "input_json_delta":
              yield {
                type: "tool_call_part",
                argumentsPart: delta.partial_json,
                index: blockIndex,
              };
              break;
            case "signature_delta":
              yield {
                type: "think",
                think: "",
                encrypted: delta.signature,
              };
              break;
          }
        } else if (eventType === "content_block_stop") {
        } else if (eventType === "message_delta") {
          const deltaUsage = (evt as { usage?: Record<string, unknown> }).usage;
          if (deltaUsage !== undefined) {
            if (typeof deltaUsage["output_tokens"] === "number") {
              this._usage.output = deltaUsage["output_tokens"];
            }
            if (typeof deltaUsage["cache_read_input_tokens"] === "number") {
              this._usage.inputCacheRead =
                deltaUsage["cache_read_input_tokens"];
            }
            if (typeof deltaUsage["cache_creation_input_tokens"] === "number") {
              this._usage.inputCacheCreation =
                deltaUsage["cache_creation_input_tokens"];
            }
            if (typeof deltaUsage["input_tokens"] === "number") {
              this._usage.inputOther = deltaUsage["input_tokens"];
            }
          }
          const messageDeltaPayload = (
            evt as { delta?: Record<string, unknown> }
          ).delta;
          if (
            messageDeltaPayload !== undefined &&
            "stop_reason" in messageDeltaPayload
          ) {
            this._captureStopReason(
              messageDeltaPayload["stop_reason"] as string | null | undefined,
            );
          }
        }
      }
    } catch (error: unknown) {
      throw convertAnthropicError(error, this._convertErrorHook);
    }
  }
}

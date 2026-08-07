/**
 * `kosong/provider` domain — Google GenAI streamed response adapter.
 *
 * Converts Gemini generateContent stream/non-stream responses into Kimi
 * `StreamedMessagePart` sequences.
 */

import type {
  StreamedMessagePart,
  ThinkPart,
  ToolCall,
} from "#/kosong/contract/message";
import type { FinishReason, StreamedMessage } from "#/kosong/contract/provider";
import type { TokenUsage } from "#/kosong/contract/usage";

import {
  convertGoogleGenAIError,
  createAbortError,
  normalizeGoogleGenAIFinishReason,
} from "./google-genai-errors";

export class GoogleGenAIStreamedMessage implements StreamedMessage {
  private _id: string | null = null;
  private _usage: TokenUsage | null = null;
  private _finishReason: FinishReason | null = null;
  private _rawFinishReason: string | null = null;
  private readonly _iter: AsyncGenerator<StreamedMessagePart>;

  constructor(
    response: AsyncIterable<Record<string, unknown>> | Record<string, unknown>,
    isStream: boolean,
    signal?: AbortSignal,
  ) {
    if (isStream) {
      this._iter = this._convertStreamResponse(
        response as AsyncIterable<Record<string, unknown>>,
        signal,
      );
    } else {
      this._iter = this._convertNonStreamResponse(
        response as Record<string, unknown>,
        signal,
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

  private _captureFinishReason(response: Record<string, unknown>): void {
    const candidates = response["candidates"] as unknown[] | undefined;
    if (!candidates || candidates.length === 0) {
      return;
    }
    const first = candidates[0] as Record<string, unknown> | undefined;
    if (first === undefined) {
      return;
    }
    const raw = first["finishReason"] ?? first["finish_reason"];
    if (raw === undefined) {
      return;
    }
    const normalized = normalizeGoogleGenAIFinishReason(raw);
    if (
      normalized.finishReason !== null ||
      normalized.rawFinishReason !== null
    ) {
      this._finishReason = normalized.finishReason;
      this._rawFinishReason = normalized.rawFinishReason;
    }
  }

  private _extractChunkParts(
    response: Record<string, unknown>,
  ): StreamedMessagePart[] {
    const parts: StreamedMessagePart[] = [];

    const candidates = response["candidates"] as unknown[] | undefined;
    for (const candidate of candidates ?? []) {
      const cand = candidate as Record<string, unknown>;
      const content = cand["content"] as Record<string, unknown> | undefined;
      const contentParts = content?.["parts"] as unknown[] | undefined;
      if (!contentParts) continue;

      for (const part of contentParts) {
        const p = part as Record<string, unknown>;
        if (p["thought"] === true && typeof p["text"] === "string") {
          const thoughtSignature =
            p["thoughtSignature"] ?? p["thought_signature"];
          const thinkPart: ThinkPart = { type: "think", think: p["text"] };
          if (
            typeof thoughtSignature === "string" &&
            thoughtSignature.length > 0
          ) {
            thinkPart.encrypted = thoughtSignature;
          }
          parts.push(thinkPart);
        } else if (p["text"]) {
          parts.push({ type: "text", text: p["text"] as string });
        } else if (p["functionCall"] || p["function_call"]) {
          const fc = (p["functionCall"] ?? p["function_call"]) as Record<
            string,
            unknown
          >;
          const name = fc["name"] as string;
          if (!name) continue;
          const id_ = (fc["id"] as string) ?? crypto.randomUUID();
          const toolCallId = `${name}_${id_}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
          const thoughtSigB64 = p["thoughtSignature"] ?? p["thought_signature"];
          const toolCall: ToolCall = {
            type: "function",
            id: toolCallId,
            name,
            arguments: fc["args"] ? JSON.stringify(fc["args"]) : "{}",
          };
          if (typeof thoughtSigB64 === "string" && thoughtSigB64.length > 0) {
            toolCall.extras = { thought_signature_b64: thoughtSigB64 };
          }
          parts.push(toolCall);
        }
      }
    }

    return parts;
  }

  private _extractUsage(response: Record<string, unknown>): void {
    const usageMetadata = response["usageMetadata"] as
      | Record<string, unknown>
      | undefined;
    if (usageMetadata) {
      const promptTokenCount =
        typeof usageMetadata["promptTokenCount"] === "number"
          ? usageMetadata["promptTokenCount"]
          : 0;
      const cachedContentTokenCount =
        typeof usageMetadata["cachedContentTokenCount"] === "number"
          ? usageMetadata["cachedContentTokenCount"]
          : 0;
      this._usage = {
        inputOther: Math.max(promptTokenCount - cachedContentTokenCount, 0),
        output: (usageMetadata["candidatesTokenCount"] as number) ?? 0,
        inputCacheRead: cachedContentTokenCount,
        inputCacheCreation: 0,
      };
    }
  }

  private _extractId(response: Record<string, unknown>): void {
    if (response["responseId"] !== undefined) {
      this._id = response["responseId"] as string;
    }
  }

  private _throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal !== undefined && signal.aborted) {
      throw createAbortError();
    }
  }

  private async *_convertNonStreamResponse(
    response: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamedMessagePart> {
    this._throwIfAborted(signal);
    this._extractUsage(response);
    this._extractId(response);
    this._captureFinishReason(response);
    for (const part of this._extractChunkParts(response)) {
      this._throwIfAborted(signal);
      yield part;
    }
  }

  private async *_convertStreamResponse(
    response: AsyncIterable<Record<string, unknown>>,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamedMessagePart> {
    try {
      for await (const chunk of response) {
        this._throwIfAborted(signal);
        this._extractUsage(chunk);
        this._extractId(chunk);
        this._captureFinishReason(chunk);
        for (const part of this._extractChunkParts(chunk)) {
          this._throwIfAborted(signal);
          yield part;
        }
      }
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      throw convertGoogleGenAIError(error);
    }
  }
}

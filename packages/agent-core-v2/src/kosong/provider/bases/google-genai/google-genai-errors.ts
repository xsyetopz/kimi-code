/**
 * `kosong/provider` domain — Google GenAI error conversion and abort helpers.
 */

import { ApiError as GoogleApiError } from "@google/genai";

import {
  APIConnectionError,
  APITimeoutError,
  ChatProviderError,
  normalizeAPIStatusError,
} from "#/kosong/contract/errors";
import type { FinishReason } from "#/kosong/contract/provider";

export function normalizeGoogleGenAIFinishReason(raw: unknown): {
  finishReason: FinishReason | null;
  rawFinishReason: string | null;
} {
  if (raw === null || raw === undefined) {
    return { finishReason: null, rawFinishReason: null };
  }
  let rawString: string;
  if (typeof raw === "string") {
    rawString = raw.toUpperCase();
  } else if (
    typeof raw === "number" ||
    typeof raw === "bigint" ||
    typeof raw === "boolean"
  ) {
    rawString = String(raw).toUpperCase();
  } else {
    return { finishReason: null, rawFinishReason: null };
  }
  if (rawString === "FINISH_REASON_UNSPECIFIED" || rawString === "") {
    return { finishReason: null, rawFinishReason: null };
  }
  switch (rawString) {
    case "STOP":
      return { finishReason: "completed", rawFinishReason: rawString };
    case "MAX_TOKENS":
      return { finishReason: "truncated", rawFinishReason: rawString };
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
    case "IMAGE_SAFETY":
      return { finishReason: "filtered", rawFinishReason: rawString };
    case "MALFORMED_FUNCTION_CALL":
    case "OTHER":
    case "LANGUAGE":
      return { finishReason: "other", rawFinishReason: rawString };
    default:
      return { finishReason: "other", rawFinishReason: rawString };
  }
}

export function createAbortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

export async function abortPromise(
  signal: AbortSignal | undefined,
): Promise<never> {
  if (signal === undefined) {
    return new Promise(() => {});
  }
  if (signal.aborted) {
    throw createAbortError();
  }
  return new Promise((_, reject) => {
    signal.addEventListener(
      "abort",
      () => {
        reject(createAbortError());
      },
      { once: true },
    );
  });
}

const NETWORK_RE = /network|connection|connect|disconnect|fetch failed/i;
const TIMEOUT_RE = /timed?s*out|timeout|deadline/i;

export function convertGoogleGenAIError(error: unknown): ChatProviderError {
  if (error instanceof GoogleApiError) {
    return normalizeAPIStatusError(error.status, error.message);
  }
  if (error instanceof Error) {
    const msg = error.message;
    if (TIMEOUT_RE.test(msg)) {
      return new APITimeoutError(msg);
    }
    if (
      NETWORK_RE.test(msg) ||
      (error instanceof TypeError && msg.includes("fetch"))
    ) {
      return new APIConnectionError(msg);
    }
    const statusCode = (error as { code?: number }).code;
    if (typeof statusCode === "number") {
      return normalizeAPIStatusError(statusCode, msg);
    }
    return new ChatProviderError(`GoogleGenAI error: ${msg}`);
  }
  return new ChatProviderError(`GoogleGenAI error: ${String(error)}`);
}

import type { TransportId } from "@kimi-next/model";

export interface LiveStreamOptions {
  readonly transport: TransportId;
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Wire model id — required for Gemini stream URLs. */
  readonly model?: string;
  readonly signal?: AbortSignal;
}

/**
 * POST wire body and yield parsed SSE JSON objects (OpenAI/Anthropic shaped).
 */
export async function* liveSseStream(
  wireBody: unknown,
  options: LiveStreamOptions,
): AsyncIterable<unknown> {
  const url = streamUrl(options.transport, options.baseUrl, options.model);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${options.apiKey}`,
    accept: "text/event-stream",
  };
  if (options.transport === "anthropic") {
    headers["anthropic-version"] = "2023-06-01";
    headers["x-api-key"] = options.apiKey;
  }
  const init: RequestInit = {
    method: "POST",
    headers,
    body: JSON.stringify(wireBody),
  };
  if (options.signal !== undefined) {
    init.signal = options.signal;
  }
  const response = await fetch(url, init);

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") {
        yield { done: true };
        return;
      }
      try {
        yield JSON.parse(data) as unknown;
      } catch {
        // skip malformed SSE data lines
      }
    }
  }
}

function streamUrl(
  transport: TransportId,
  baseUrl: string,
  model?: string,
): string {
  const base = baseUrl.replace(/\/$/, "");
  switch (transport) {
    case "openai-chat":
      return `${base}/chat/completions`;
    case "openai-responses":
      return `${base}/responses`;
    case "anthropic":
      return `${base}/messages`;
    case "gemini": {
      if (!model) {
        throw new Error("Gemini stream requires model id");
      }
      return `${base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
    }
    default: {
      const _exhaustive: never = transport;
      throw new Error(`Unsupported transport: ${_exhaustive}`);
    }
  }
}

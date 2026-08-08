import type {
  Conversation,
  StreamEvent,
  ToolDefinition,
} from "@kimi-next/ir";
import type { TransportId } from "@kimi-next/model";

export interface AdapterRequestParameters {
  readonly temperature?: number;
  readonly topP?: number;
  readonly maxOutputTokens?: number;
  readonly stopSequences?: readonly string[];
  /** Stable key for provider prompt caching (e.g. OpenAI prompt_cache_key). */
  readonly cacheKey?: string;
}

export interface AdapterRequest {
  readonly model: string;
  readonly conversation: Conversation;
  readonly tools?: readonly ToolDefinition[];
  readonly system?: string;
  readonly parameters?: AdapterRequestParameters;
  /** Overrides parameters.cacheKey when both are set. */
  readonly promptCacheKey?: string;
}

export interface TransportAdapter {
  readonly transport: TransportId;
  serialize(request: AdapterRequest): unknown;
  decodeStream(rawEvents: AsyncIterable<unknown>): AsyncIterable<StreamEvent>;
}

export function resolvePromptCacheKey(
  request: AdapterRequest,
): string | undefined {
  return request.promptCacheKey ?? request.parameters?.cacheKey;
}

export async function collectStreamEvents(
  events: AsyncIterable<StreamEvent>,
): Promise<StreamEvent[]> {
  const collected: StreamEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

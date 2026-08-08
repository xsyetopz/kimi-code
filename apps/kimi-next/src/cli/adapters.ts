import type { TransportAdapter } from "@kimi-next/adapters";
import {
  anthropicAdapter,
  geminiAdapter,
  openAiChatAdapter,
  openAiResponsesAdapter,
} from "@kimi-next/adapters";
import type { TransportId } from "@kimi-next/model";

export function adapterForTransport(transport: TransportId): TransportAdapter {
  switch (transport) {
    case "openai-chat":
      return openAiChatAdapter;
    case "openai-responses":
      return openAiResponsesAdapter;
    case "anthropic":
      return anthropicAdapter;
    case "gemini":
      return geminiAdapter;
    default: {
      const _exhaustive: never = transport;
      throw new Error(`Unknown transport: ${_exhaustive}`);
    }
  }
}

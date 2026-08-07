import type { ModelProtocolProfile, ProviderTransportProfile } from "./profile";

/** OpenAI Chat Completions — legacy GPT and OpenAI-compatible gateways. */
export const OPENAI_CHAT_PROTOCOL_PROFILE = {
  transport: "openai",
  tools: {
    protocol: "openai_chat",
    parallel: true,
    streaming: true,
    requiresCallId: true,
    requiresAssistantReplay: false,
  },
  reasoning: {
    mode: "separate_field",
    field: "reasoning_content",
    replayWithToolCalls: false,
  },
} as const satisfies ModelProtocolProfile;

/** OpenAI Responses API — item/call state model for modern GPT/Codex. */
export const OPENAI_RESPONSES_PROTOCOL_PROFILE = {
  transport: "openai_responses",
  tools: {
    protocol: "openai_responses",
    parallel: true,
    streaming: true,
    requiresCallId: true,
    requiresAssistantReplay: false,
  },
  reasoning: {
    mode: "hidden",
    replayWithToolCalls: true,
  },
  request: {
    maxToolCallIdLength: 64,
  },
} as const satisfies ModelProtocolProfile;

/** Anthropic Messages API — tool_use / tool_result content blocks. */
export const ANTHROPIC_PROTOCOL_PROFILE = {
  transport: "anthropic",
  tools: {
    protocol: "anthropic",
    parallel: true,
    streaming: true,
    requiresCallId: true,
    requiresAssistantReplay: false,
  },
  reasoning: {
    mode: "interleaved",
    replayWithToolCalls: true,
  },
} as const satisfies ModelProtocolProfile;

/** Google Gemini generateContent — functionCall / functionResponse. */
export const GEMINI_PROTOCOL_PROFILE = {
  transport: "google-genai",
  tools: {
    protocol: "google_genai",
    parallel: true,
    streaming: true,
    requiresCallId: true,
    requiresAssistantReplay: false,
  },
  reasoning: {
    mode: "hidden",
    replayWithToolCalls: false,
  },
  request: {
    strictRoleAlternation: true,
    mergeParallelToolResults: true,
  },
} as const satisfies ModelProtocolProfile;

/** Kimi K2.x — OpenAI-shaped tool_calls; preserve assistant turns in loops. */
export const KIMI_K2_PROTOCOL_PROFILE = {
  transport: "kimi",
  tools: {
    protocol: "kimi",
    parallel: true,
    streaming: true,
    requiresCallId: true,
    requiresAssistantReplay: true,
  },
  reasoning: {
    mode: "separate_field",
    field: "reasoning_content",
    replayWithToolCalls: true,
  },
} as const satisfies ModelProtocolProfile;

/**
 * Kimi K3 — complete assistant messages must round-trip unchanged during tool
 * loops; `reasoning_effort` is model-native on the Kimi wire.
 */
export const KIMI_K3_PROTOCOL_PROFILE = {
  transport: "kimi",
  tools: {
    protocol: "kimi",
    parallel: true,
    streaming: true,
    requiresCallId: true,
    requiresAssistantReplay: true,
  },
  reasoning: {
    mode: "separate_field",
    field: "reasoning_effort",
    replayWithToolCalls: true,
  },
} as const satisfies ModelProtocolProfile;

/**
 * DeepSeek thinking models — `reasoning_content` must replay alongside tool
 * calls or the upstream returns 400.
 */
export const DEEPSEEK_PROTOCOL_PROFILE = {
  transport: "openai",
  tools: {
    protocol: "openai_chat",
    parallel: true,
    streaming: true,
    requiresCallId: true,
    requiresAssistantReplay: false,
  },
  reasoning: {
    mode: "separate_field",
    field: "reasoning_content",
    replayWithToolCalls: true,
  },
} as const satisfies ModelProtocolProfile;

/** MiniMax M-series — OpenAI/Anthropic compatibility frontends; interleaved thinking. */
export const MINIMAX_PROTOCOL_PROFILE = {
  transport: "openai",
  tools: {
    protocol: "openai_chat",
    parallel: true,
    streaming: true,
    requiresCallId: true,
    requiresAssistantReplay: false,
  },
  reasoning: {
    mode: "separate_field",
    field: "reasoning_details",
    replayWithToolCalls: true,
  },
} as const satisfies ModelProtocolProfile;

export const TRANSPORT_PROFILE_BY_WIRE = {
  anthropic: {
    family: "anthropic",
    endpoint: "messages",
    auth: "bearer",
  },
  openai: {
    family: "openai",
    endpoint: "chat_completions",
    auth: "bearer",
  },
  openai_responses: {
    family: "openai_responses",
    endpoint: "responses",
    auth: "bearer",
  },
  "google-genai": {
    family: "google-genai",
    endpoint: "generate_content",
    auth: "api_key_header",
  },
  kimi: {
    family: "kimi",
    endpoint: "chat_completions",
    auth: "bearer",
  },
  vertexai: {
    family: "vertexai",
    endpoint: "generate_content",
    auth: "oauth",
  },
} as const satisfies Record<string, ProviderTransportProfile>;

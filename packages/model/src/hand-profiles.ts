import type { ModelProfile } from "./profile";

/** Hand-tuned profiles that override models.dev snapshot entries. */
export const HAND_PROFILES: readonly ModelProfile[] = [
  {
    id: "openai/gpt-4.1-mini",
    displayName: "GPT-4.1 Mini",
    wireModel: "gpt-4.1-mini",
    transport: "openai-chat",
    limits: {
      contextTokens: 1_047_576,
      maxOutputTokens: 32_768,
    },
    capabilities: {
      input: { text: true, images: true },
      output: { text: true, toolCalls: true },
      tools: { parallel: true, streamingArguments: true },
      reasoning: { none: true, opaque: false, exposed: false },
      conversation: {
        systemMessage: true,
        toolResults: true,
        alternation: "flexible",
      },
    },
    reasoning: {
      defaultMode: "none",
      supportedModes: ["none"],
    },
    replay: {
      requireRawProviderMessage: false,
      requireContinuation: false,
      requireSignatures: false,
    },
    parameters: {
      temperature: true,
      topP: true,
      maxOutputTokens: true,
      stopSequences: true,
    },
  },
  {
    id: "anthropic/claude-sonnet-4-20250514",
    displayName: "Claude Sonnet 4",
    wireModel: "claude-sonnet-4-20250514",
    transport: "anthropic",
    limits: {
      contextTokens: 200_000,
      maxOutputTokens: 64_000,
    },
    capabilities: {
      input: { text: true, images: true },
      output: { text: true, toolCalls: true },
      tools: { parallel: true, streamingArguments: true },
      reasoning: { none: true, opaque: false, exposed: true },
      conversation: {
        systemMessage: true,
        toolResults: true,
        alternation: "strict",
      },
    },
    reasoning: {
      defaultMode: "none",
      supportedModes: ["none", "exposed"],
    },
    replay: {
      requireRawProviderMessage: true,
      requireContinuation: false,
      requireSignatures: false,
    },
    parameters: {
      temperature: true,
      topP: true,
      maxOutputTokens: true,
      stopSequences: true,
    },
  },
  {
    id: "moonshotai/kimi-k2",
    displayName: "Kimi K2",
    wireModel: "kimi-k2-0711-preview",
    transport: "openai-chat",
    limits: {
      contextTokens: 128_000,
      maxOutputTokens: 16_384,
    },
    capabilities: {
      input: { text: true, images: false },
      output: { text: true, toolCalls: true },
      tools: { parallel: true, streamingArguments: true },
      reasoning: { none: true, opaque: true, exposed: false },
      conversation: {
        systemMessage: true,
        toolResults: true,
        alternation: "flexible",
      },
    },
    reasoning: {
      defaultMode: "opaque",
      supportedModes: ["none", "opaque"],
    },
    replay: {
      requireRawProviderMessage: true,
      requireContinuation: true,
      requireSignatures: false,
    },
    parameters: {
      temperature: true,
      topP: true,
      maxOutputTokens: true,
      stopSequences: false,
    },
  },
  {
    id: "openai/gpt-4.1",
    displayName: "GPT-4.1",
    wireModel: "gpt-4.1",
    transport: "openai-responses",
    limits: { contextTokens: 1_047_576, maxOutputTokens: 32_768 },
    capabilities: {
      input: { text: true, images: true },
      output: { text: true, toolCalls: true },
      tools: { parallel: true, streamingArguments: true },
      reasoning: { none: true, opaque: false, exposed: false },
      conversation: {
        systemMessage: true,
        toolResults: true,
        alternation: "flexible",
      },
    },
    reasoning: { defaultMode: "none", supportedModes: ["none"] },
    replay: {
      requireRawProviderMessage: false,
      requireContinuation: false,
      requireSignatures: false,
    },
    parameters: {
      temperature: true,
      topP: true,
      maxOutputTokens: true,
      stopSequences: true,
    },
  },
  {
    id: "google/gemini-2.5-flash",
    displayName: "Gemini 2.5 Flash",
    wireModel: "gemini-2.5-flash",
    transport: "gemini",
    limits: { contextTokens: 1_048_576, maxOutputTokens: 65_536 },
    capabilities: {
      input: { text: true, images: true },
      output: { text: true, toolCalls: true },
      tools: { parallel: true, streamingArguments: true },
      reasoning: { none: true, opaque: true, exposed: false },
      conversation: {
        systemMessage: true,
        toolResults: true,
        alternation: "flexible",
      },
    },
    reasoning: { defaultMode: "none", supportedModes: ["none", "opaque"] },
    replay: {
      requireRawProviderMessage: true,
      requireContinuation: false,
      requireSignatures: false,
    },
    parameters: {
      temperature: true,
      topP: true,
      maxOutputTokens: true,
      stopSequences: true,
    },
  },
];

import { z } from "zod";

import type { ModelCapability } from "#/capability";

/**
 * Declarative compatibility profiles for the three compat layers:
 *  1. Transport / API dialect ({@link ProviderTransportProfile})
 *  2. Conversation / tool protocol ({@link ModelProtocolProfile.tools})
 *  3. Reasoning protocol ({@link ModelProtocolProfile.reasoning})
 *
 * {@link ServingProfile} captures the inference engine behind an
 * OpenAI-compatible gateway (vLLM, SGLang, llama.cpp) when that affects wire
 * quirks (tool parsers, reasoning field names, chat templates).
 *
 * These are pure metadata — adapters consult them; they do not perform I/O.
 */

export const ProtocolTransportFamilySchema = z.enum([
  "anthropic",
  "openai",
  "openai_responses",
  "google-genai",
  "kimi",
  "vertexai",
  "custom",
]);

export type ProtocolTransportFamily = z.infer<
  typeof ProtocolTransportFamilySchema
>;

export const ToolProtocolKindSchema = z.enum([
  "openai_chat",
  "openai_responses",
  "anthropic",
  "google_genai",
  "kimi",
  "none",
]);

export type ToolProtocolKind = z.infer<typeof ToolProtocolKindSchema>;

export const ReasoningModeSchema = z.enum([
  "hidden",
  "separate_field",
  "interleaved",
  "none",
]);

export type ReasoningMode = z.infer<typeof ReasoningModeSchema>;

export const ModelProtocolToolsProfileSchema = z.object({
  protocol: ToolProtocolKindSchema,
  parallel: z.boolean(),
  streaming: z.boolean(),
  requiresCallId: z.boolean(),
  requiresAssistantReplay: z.boolean(),
});

export type ModelProtocolToolsProfile = z.infer<
  typeof ModelProtocolToolsProfileSchema
>;

export const ModelProtocolReasoningProfileSchema = z.object({
  mode: ReasoningModeSchema,
  field: z.string().min(1).optional(),
  replayWithToolCalls: z.boolean(),
});

export type ModelProtocolReasoningProfile = z.infer<
  typeof ModelProtocolReasoningProfileSchema
>;

export const ModelProtocolRequestConstraintsSchema = z.object({
  strictRoleAlternation: z.boolean().optional(),
  mergeParallelToolResults: z.boolean().optional(),
  maxToolCallIdLength: z.number().int().positive().optional(),
});

export type ModelProtocolRequestConstraints = z.infer<
  typeof ModelProtocolRequestConstraintsSchema
>;

/** Capability fields carried on a protocol profile (subset of {@link ModelCapability}). */
export const ModelProtocolCapabilitySchema = z.object({
  image_in: z.boolean(),
  video_in: z.boolean(),
  audio_in: z.boolean(),
  thinking: z.boolean(),
  tool_use: z.boolean(),
  max_context_tokens: z.number().int().nonnegative(),
  max_input_tokens: z.number().int().positive().optional(),
  dynamically_loaded_tools: z.boolean().optional(),
});

export type ModelProtocolCapability = z.infer<
  typeof ModelProtocolCapabilitySchema
>;

export const ModelProtocolProfileSchema = z.object({
  transport: ProtocolTransportFamilySchema,
  tools: ModelProtocolToolsProfileSchema,
  reasoning: ModelProtocolReasoningProfileSchema,
  capabilities: ModelProtocolCapabilitySchema.optional(),
  request: ModelProtocolRequestConstraintsSchema.optional(),
});

export type ModelProtocolProfile = z.infer<typeof ModelProtocolProfileSchema>;

export const EndpointKindSchema = z.enum([
  "chat_completions",
  "messages",
  "responses",
  "generate_content",
  "custom",
]);

export type EndpointKind = z.infer<typeof EndpointKindSchema>;

export const AuthStyleSchema = z.enum([
  "bearer",
  "api_key_header",
  "query",
  "none",
  "oauth",
]);

export type AuthStyle = z.infer<typeof AuthStyleSchema>;

export const ProviderTransportProfileSchema = z.object({
  family: ProtocolTransportFamilySchema,
  baseUrlPattern: z.string().min(1).optional(),
  endpoint: EndpointKindSchema,
  auth: AuthStyleSchema,
});

export type ProviderTransportProfile = z.infer<
  typeof ProviderTransportProfileSchema
>;

export const ServingEngineSchema = z.enum([
  "vllm",
  "sglang",
  "llamacpp",
  "unknown",
]);

export type ServingEngine = z.infer<typeof ServingEngineSchema>;

export const ServingProfileSchema = z.object({
  engine: ServingEngineSchema,
  chatTemplate: z.string().min(1).optional(),
  toolParser: z.string().min(1).optional(),
  reasoningParser: z.string().min(1).optional(),
});

export type ServingProfile = z.infer<typeof ServingProfileSchema>;

export function parseModelProtocolProfile(
  value: unknown,
): ModelProtocolProfile {
  return ModelProtocolProfileSchema.parse(value);
}

export function parseProviderTransportProfile(
  value: unknown,
): ProviderTransportProfile {
  return ProviderTransportProfileSchema.parse(value);
}

export function parseServingProfile(value: unknown): ServingProfile {
  return ServingProfileSchema.parse(value);
}

/** Narrow a full {@link ModelCapability} to the protocol-profile capability shape. */
export function capabilityToProtocolCapability(
  capability: ModelCapability,
): ModelProtocolCapability {
  return {
    image_in: capability.image_in,
    video_in: capability.video_in,
    audio_in: capability.audio_in,
    thinking: capability.thinking,
    tool_use: capability.tool_use,
    max_context_tokens: capability.max_context_tokens,
    max_input_tokens: capability.max_input_tokens,
    dynamically_loaded_tools: capability.dynamically_loaded_tools,
  };
}

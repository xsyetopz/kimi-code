// Message types
export {
  createAssistantMessage,
  createToolMessage,
  createUserMessage,
  extractText,
  isContentPart,
  isToolCall,
  isToolCallPart,
  mergeInPlace,
} from "./message";
export type {
  AudioURLPart,
  ContentPart,
  ImageURLPart,
  Message,
  Role,
  StreamedMessagePart,
  TextPart,
  ThinkPart,
  ToolCall,
  ToolCallPart,
  VideoURLPart,
} from "./message";

// Provider interfaces
export * from "./provider";
export { createProvider, getModelCapability } from "./providers";
export type { ProviderConfig, ProviderType } from "./providers";
// Kimi provider: exported so callers can narrow a `ChatProvider` to the Kimi
// backend (instanceof) and apply Kimi-specific request params (generation
// kwargs, `thinking.keep` extra body).
export { KimiChatProvider } from "./providers/kimi";
export type {
  ExtraBody,
  GenerationKwargs,
  KimiOptions,
  ThinkingConfig,
} from "./providers/kimi";
export { classifyKimiQuotaError } from "./providers/kimi-errors";

// Model capability matrix
export { isUnknownCapability, UNKNOWN_CAPABILITY } from "./capability";
export type { ModelCapability } from "./capability";

// Protocol compatibility profiles
export {
  capabilityToProtocolCapability,
  parseModelProtocolProfile,
  parseOpaqueProviderState,
  parseProviderTransportProfile,
  parseServingProfile,
} from "./protocol";
export type {
  AuthStyle,
  EndpointKind,
  ModelProtocolCapability,
  ModelProtocolProfile,
  ModelProtocolReasoningProfile,
  ModelProtocolRequestConstraints,
  ModelProtocolToolsProfile,
  OpaqueProviderState,
  ProtocolTransportFamily,
  ProviderTransportProfile,
  ReasoningMode,
  ServingEngine,
  ServingProfile,
  ToolProtocolKind,
} from "./protocol";
export {
  ANTHROPIC_PROTOCOL_PROFILE,
  DEEPSEEK_PROTOCOL_PROFILE,
  GEMINI_PROTOCOL_PROFILE,
  KIMI_K2_PROTOCOL_PROFILE,
  KIMI_K3_PROTOCOL_PROFILE,
  MINIMAX_PROTOCOL_PROFILE,
  OPENAI_CHAT_PROTOCOL_PROFILE,
  OPENAI_RESPONSES_PROTOCOL_PROFILE,
  TRANSPORT_PROFILE_BY_WIRE,
} from "./protocol";

// Model catalog (models.dev-style) metadata
export {
  catalogBaseUrl,
  catalogModelToCapability,
  catalogProviderModels,
  inferWireType,
  resolveCatalogImport,
} from "./catalog";
export {
  resolveModelProtocolProfile,
  resolveProviderTransportProfile,
} from "./catalog-profiles";
export type {
  Catalog,
  CatalogModel,
  CatalogModelCost,
  CatalogModelEntry,
  CatalogProviderEntry,
  CatalogImportInvalidReason,
  CatalogImportResolution,
} from "./catalog";

// Core functions
export { generate } from "./generate";
export type { GenerateCallbacks, GenerateResult } from "./generate";

// Tool wire schema
export type { Tool } from "./tool";

// Token usage
export { addUsage, emptyUsage, grandTotal, inputTotal } from "./usage";
export type { TokenUsage } from "./usage";

// Errors
export {
  APIConnectionError,
  APIContextOverflowError,
  APIEmptyResponseError,
  APIProviderQuotaExhaustedError,
  APIProviderRateLimitError,
  APIRequestTooLargeError,
  APIStatusError,
  APITimeoutError,
  ChatProviderError,
  createAbortError,
  isAbortError,
  isContextOverflowStatusError,
  isImageFormatError,
  isProviderRateLimitError,
  isRecoverableRequestStructureError,
  isRequestTooLargeStatusError,
  isRetryableGenerateError,
  isToolExchangeAdjacencyError,
  throwIfAbortError,
} from "./errors";

/**
 * Concrete provider adapters stay off the root barrel because their SDK type
 * graphs pollute downstream declaration bundles. Import them from subpaths:
 * `@moonshot-ai/kosong/providers/kimi`,
 * `@moonshot-ai/kosong/providers/openai-legacy`, etc.
 */

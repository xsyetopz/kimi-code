/**
 * Provider-specific replay state that does not map onto {@link Message} content
 * or {@link ToolCall} IR fields (e.g. Responses API item ids). Carried as an
 * optional sidecar until wire adapters consume it.
 */
export type OpaqueProviderState = Record<string, unknown>;

/** Opaque provider-side state that must round-trip for replay. */
export type OpaqueProviderState = Readonly<Record<string, unknown>>;

export type ReasoningMode = "none" | "opaque" | "exposed";

export interface ReasoningState {
  readonly mode: ReasoningMode;
  /** Visible reasoning text when mode is exposed. */
  readonly text?: string;
  /** Opaque/encrypted payload for provider-managed reasoning. */
  readonly opaque?: string;
  /** Provider payload required for lossless replay. */
  readonly providerPayload?: OpaqueProviderState;
}

export interface TextPart {
  readonly type: "text";
  readonly text: string;
}

export interface ImagePart {
  readonly type: "image";
  readonly url: string;
  readonly id?: string;
}

export type ContentPart = TextPart | ImagePart;

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** Fully assembled JSON arguments string (never partial at execution time). */
  readonly arguments: string;
  readonly providerMetadata?: OpaqueProviderState;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface SystemMessage {
  readonly kind: "system";
  readonly id: string;
  readonly text: string;
}

export interface UserMessage {
  readonly kind: "user";
  readonly id: string;
  readonly content: ContentPart[];
}

/**
 * Assistant turn with normalized view + preserved provider state.
 * Never reduce to { role, content, tool_calls } alone.
 */
export interface AssistantTurn {
  readonly kind: "assistant";
  readonly id: string;
  readonly text: string[];
  readonly reasoning: ReasoningState;
  readonly toolCalls: ToolCall[];
  readonly partial?: boolean;
  /** Lossless provider sidecars for replay. */
  readonly preserved: {
    readonly rawProviderMessage?: OpaqueProviderState;
    readonly continuation?: OpaqueProviderState;
    readonly signatures?: OpaqueProviderState;
    readonly unknownFields?: OpaqueProviderState;
  };
}

export interface ToolResult {
  readonly kind: "tool_result";
  readonly id: string;
  readonly callId: string;
  readonly content: string;
  readonly isError: boolean;
  readonly metadata?: OpaqueProviderState;
}

/** Structured compact checkpoint — archive truth, not a vague summary blob. */
export interface CompactCheckpoint {
  readonly kind: "compact_checkpoint";
  readonly id: string;
  readonly progress: string;
  readonly filesTouched: string[];
  readonly validation: string;
  readonly nextSteps: string;
  readonly createdAt: string;
}

export type ConversationRecord =
  | SystemMessage
  | UserMessage
  | AssistantTurn
  | ToolResult
  | CompactCheckpoint;

export type Conversation = readonly ConversationRecord[];

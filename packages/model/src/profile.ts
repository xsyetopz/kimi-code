import type { ReasoningMode } from "@kimi-next/ir";
import type { ModelCapabilities } from "./capabilities";

export type TransportId =
  | "openai-chat"
  | "openai-responses"
  | "anthropic"
  | "gemini";

/** Rules for lossless replay of provider-managed assistant state. */
export interface ReplayRules {
  readonly requireRawProviderMessage: boolean;
  readonly requireContinuation: boolean;
  readonly requireSignatures: boolean;
}

export interface ParameterSupport {
  readonly temperature: boolean;
  readonly topP: boolean;
  readonly maxOutputTokens: boolean;
  readonly stopSequences: boolean;
}

export interface ModelLimits {
  readonly contextTokens: number;
  readonly maxOutputTokens: number;
}

export interface ModelProfile {
  readonly id: string;
  readonly displayName: string;
  /** Provider wire model id sent on the HTTP request. */
  readonly wireModel: string;
  readonly transport: TransportId;
  readonly limits: ModelLimits;
  readonly capabilities: ModelCapabilities;
  readonly reasoning: {
    readonly defaultMode: ReasoningMode;
    readonly supportedModes: readonly ReasoningMode[];
  };
  readonly replay: ReplayRules;
  readonly parameters: ParameterSupport;
}

import type { ReasoningMode } from "@kimi-next/ir";

/** Feature flags describing what a model + transport can do. */
export interface ModelCapabilities {
  readonly input: {
    readonly text: boolean;
    readonly images: boolean;
  };
  readonly output: {
    readonly text: boolean;
    readonly toolCalls: boolean;
  };
  readonly tools: {
    readonly parallel: boolean;
    readonly streamingArguments: boolean;
  };
  readonly reasoning: Record<ReasoningMode, boolean>;
  readonly conversation: {
    readonly systemMessage: boolean;
    readonly toolResults: boolean;
    /** strict = alternating user/assistant; flexible allows back-to-back roles. */
    readonly alternation: "strict" | "flexible";
  };
}

export function supportsReasoningMode(
  capabilities: ModelCapabilities,
  mode: ReasoningMode,
): boolean {
  return capabilities.reasoning[mode];
}

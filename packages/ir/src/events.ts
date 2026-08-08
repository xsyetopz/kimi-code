/** Canonical stream events — UI and agent never see provider wire deltas. */

export type StreamEvent =
  | { readonly type: "response.start" }
  | { readonly type: "response.end" }
  | { readonly type: "text.start" }
  | { readonly type: "text.delta"; readonly text: string }
  | { readonly type: "text.end" }
  | { readonly type: "reasoning.start" }
  | { readonly type: "reasoning.delta"; readonly text: string }
  | { readonly type: "reasoning.end" }
  | { readonly type: "tool.start"; readonly id: string; readonly name: string }
  | {
      readonly type: "tool.arguments.delta";
      readonly id: string;
      readonly argumentsDelta: string;
    }
  | { readonly type: "tool.end"; readonly id: string }
  | {
      readonly type: "usage";
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      readonly cachedInputTokens?: number;
    }
  | {
      readonly type: "provider.state";
      readonly state: Readonly<Record<string, unknown>>;
    };

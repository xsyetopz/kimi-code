import type { ToolCall, ToolResult, UserMessage } from "@kimi-next/ir";

export type HookEvent =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PreCompact";

export type HookDecision =
  | { readonly action: "allow" }
  | { readonly action: "deny"; readonly reason: string }
  | { readonly action: "modify"; readonly arguments: string };

export interface PreCompactContext {
  readonly conversationLength: number;
}

export type PreCompactCallback = (
  context: PreCompactContext,
) => void | Promise<void>;

export interface AgentHooks {
  readonly sessionStart?: () => void | Promise<void>;
  readonly userPromptSubmit?: (message: UserMessage) => void | Promise<void>;
  readonly preToolUse?: (
    call: ToolCall,
  ) => HookDecision | Promise<HookDecision>;
  readonly postToolUse?: (
    call: ToolCall,
    result: ToolResult,
  ) => void | Promise<void>;
  readonly preCompact?: PreCompactCallback;
}

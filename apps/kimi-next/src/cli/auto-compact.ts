import type { Conversation } from "@kimi-next/ir";

export const DEFAULT_AUTO_COMPACT_CHARS = 120_000;

export interface AutoCompactOptions {
  readonly threshold?: number;
}

export function estimateConversationChars(conversation: Conversation): number {
  return JSON.stringify(conversation).length;
}

export function shouldAutoCompact(
  conversation: Conversation,
  options?: AutoCompactOptions,
): boolean {
  const threshold = options?.threshold ?? DEFAULT_AUTO_COMPACT_CHARS;
  return threshold > 0 && estimateConversationChars(conversation) >= threshold;
}

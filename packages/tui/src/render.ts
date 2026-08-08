import type { WysiwygToggles } from "./toggles";

interface UserMessageProjection {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
}

interface ToolCallProjection {
  readonly id?: string;
  readonly name: string;
  readonly arguments?: string;
}

interface ToolResultProjection {
  readonly content: string;
  readonly isError: boolean;
}

export interface FooterState {
  readonly modelId: string;
  readonly effort?: string;
  readonly permissionMode: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly swarmLines?: readonly string[];
}

export function renderUserMessage(message: UserMessageProjection): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

export function renderToolCall(call: ToolCallProjection): string {
  return `[tool] ${call.name}`;
}

export function renderToolResult(result: ToolResultProjection): string {
  const status = result.isError ? "error" : "result";
  return `[tool ${status}] ${result.content}`;
}

/** Pure footer projection for the host to print. */
export function renderFooter(
  state: FooterState,
  toggles: WysiwygToggles,
): string {
  const parts: string[] = [`model=${state.modelId}`];
  if (toggles.showModelEffort && state.effort) {
    parts.push(`effort=${state.effort}`);
  }
  parts.push(`perm=${state.permissionMode}`);
  if (
    toggles.showUsage &&
    (state.inputTokens !== undefined ||
      state.outputTokens !== undefined ||
      state.cachedInputTokens !== undefined)
  ) {
    parts.push(
      `tokens in=${state.inputTokens ?? 0} out=${state.outputTokens ?? 0} cached=${state.cachedInputTokens ?? 0}`,
    );
  }
  let out = parts.join(" | ");
  if (
    toggles.showSwarmVisibility &&
    state.swarmLines &&
    state.swarmLines.length > 0
  ) {
    out += `\nswarm:\n${state.swarmLines.join("\n")}`;
  }
  return out;
}

export function renderAssistantText(
  text: string,
  thinking: string | undefined,
  raw: string | undefined,
  toggles: WysiwygToggles,
): string {
  const blocks: string[] = [];
  if (toggles.showThinking && thinking) {
    blocks.push(`[thinking]\n${thinking}`);
  }
  blocks.push(text);
  if (toggles.showRawAssistant && raw) {
    blocks.push(`[raw]\n${raw}`);
  }
  return blocks.join("\n\n");
}

import type { TokenUsage } from "@moonshot-ai/kimi-code-sdk";
import { Text, truncateToWidth } from "@moonshot-ai/kimi-tui";

import { isGenericToolResult } from "#/tui/components/messages/tool-renderers/registry";
import {
  BRAILLE_SPINNER_FRAMES,
  THINKING_PREVIEW_LINES,
} from "#/tui/constant/rendering";
import { STATUS_BULLET } from "#/tui/constant/symbols";
import { currentTheme } from "#/tui/theme";
import type {
  SubagentCardViewState,
  SubagentPhase,
  SubagentToolActivityView,
  ToolCallBlockData,
  ToolResultBlockData,
} from "#/tui/types";
import { formatTokenCount } from "#/utils/usage/usage-format";

import { extractKeyArgument } from "./key-argument";

const MAX_SUBAGENT_DESCRIPTION_LENGTH = 60;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function formatSubagentLabel(agentName: string | undefined): string {
  const raw = agentName?.trim();
  if (raw === undefined || raw.length === 0) return "SubAgent";
  const label = raw
    .split(/[-_\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  if (/\bagent$/i.test(label)) return label;
  return `${label} Agent`;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes)}m ${String(remainder)}s`;
}

function formatTokens(n: number): string {
  return `${formatTokenCount(n)} tok`;
}

function tailNonEmptyLines(text: string, maxLines: number): string[] {
  if (text.length === 0) return [];
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-maxLines);
}

export function usageTotal(usage: TokenUsage | undefined): number {
  if (usage === undefined) return 0;
  return (
    (usage.inputOther ?? 0) +
    (usage.inputCacheRead ?? 0) +
    (usage.inputCacheCreation ?? 0) +
    usage.output
  );
}

export function deriveSubagentPhase(options: {
  readonly card: SubagentCardViewState;
  readonly result: ToolResultBlockData | undefined;
}): SubagentPhase | undefined {
  const { card, result } = options;
  if (card.backgroundTerminalPhase !== undefined) {
    return card.backgroundTerminalPhase;
  }
  if (card.detachedFromForeground && card.phase === "backgrounded") {
    return "backgrounded";
  }
  if (result !== undefined) {
    return result.is_error ? "failed" : "done";
  }
  return card.phase;
}

function getCurrentSubToolActivity(
  card: SubagentCardViewState,
): SubagentToolActivityView | undefined {
  let latestOngoing: SubagentToolActivityView | undefined;
  let latest: SubagentToolActivityView | undefined;
  let latestSeq = -1;
  let latestOngoingSeq = -1;
  for (const [index, activity] of card.toolActivities.entries()) {
    if (index > latestSeq) {
      latestSeq = index;
      latest = activity;
    }
    if (activity.phase === "ongoing" && index > latestOngoingSeq) {
      latestOngoingSeq = index;
      latestOngoing = activity;
    }
  }
  return latestOngoing ?? latest;
}

function getActiveSubagentContent(
  card: SubagentCardViewState,
): { text: string; tone: "text" | "thinking" } | undefined {
  const current = getCurrentSubToolActivity(card);
  if (
    current?.phase === "ongoing" &&
    current.output !== undefined &&
    current.output.trim().length > 0 &&
    (current.name === "Bash" || isGenericToolResult(current.name))
  ) {
    return { text: current.output, tone: "text" };
  }
  if (
    card.lastStreamKind === "thinking" &&
    card.subagentThinkingText.trim().length > 0
  ) {
    return { text: card.subagentThinkingText.trimEnd(), tone: "thinking" };
  }
  if (card.subagentText.trim().length > 0) {
    return { text: card.subagentText, tone: "text" };
  }
  if (card.subagentThinkingText.trim().length > 0) {
    return { text: card.subagentThinkingText.trimEnd(), tone: "thinking" };
  }
  return undefined;
}

function buildSingleSubagentMarker(
  phase: SubagentPhase | undefined,
  spinnerFrame: number,
): string {
  if (phase === "failed") return currentTheme.fg("error", "✗ ");
  if (phase === "done") return currentTheme.fg("success", STATUS_BULLET);
  if (phase === "backgrounded") return currentTheme.dim("◐ ");
  const frame =
    BRAILLE_SPINNER_FRAMES[spinnerFrame] ?? BRAILLE_SPINNER_FRAMES[0];
  return currentTheme.fg("primary", `${frame} `);
}

function formatSingleSubagentStatus(phase: SubagentPhase | undefined): string {
  switch (phase) {
    case "done":
      return currentTheme.fg("success", "Completed");
    case "failed":
      return currentTheme.fg("error", "Failed");
    case "running":
      return currentTheme.fg("primary", "Running");
    case "backgrounded":
      return "Backgrounded";
    case "queued":
      return currentTheme.fg("primary", "Queued");
    case "spawning":
    case undefined:
      return currentTheme.fg("primary", "Starting");
    default: {
      const _exhaustive: never = phase;
      return _exhaustive;
    }
  }
}

function formatSingleSubagentStatsText(card: SubagentCardViewState): string {
  const parts: string[] = [];
  if (card.model !== undefined) parts.push(card.model);
  parts.push(
    `${String(card.toolActivities.length)} tool${card.toolActivities.length === 1 ? "" : "s"}`,
  );
  if (card.elapsedSeconds !== undefined) {
    parts.push(formatElapsed(card.elapsedSeconds));
  }
  const tokens =
    card.contextTokens && card.contextTokens > 0
      ? card.contextTokens
      : (card.usageTokens ?? 0);
  if (tokens > 0) parts.push(formatTokens(tokens));
  return ` · ${parts.join(" · ")}`;
}

export interface ProjectSingleSubagentHeaderOptions {
  readonly toolCall: ToolCallBlockData;
  readonly result: ToolResultBlockData | undefined;
  readonly card: SubagentCardViewState;
}

export function projectSingleSubagentHeader(
  options: ProjectSingleSubagentHeaderOptions,
): string {
  const { toolCall, result, card } = options;
  const phase = deriveSubagentPhase({ card, result });
  const isDone = phase === "done";
  const marker = buildSingleSubagentMarker(phase, card.spinnerFrame);
  const labelText = formatSubagentLabel(card.agentName);
  const status = formatSingleSubagentStatus(phase);
  const rawDescription = str(toolCall.args["description"]);
  const description =
    rawDescription.length > MAX_SUBAGENT_DESCRIPTION_LENGTH
      ? `${rawDescription.slice(0, MAX_SUBAGENT_DESCRIPTION_LENGTH - 1)}…`
      : rawDescription;
  const descriptionPlain = description.length > 0 ? ` (${description})` : "";
  const descriptionText =
    descriptionPlain.length > 0 ? currentTheme.dim(descriptionPlain) : "";
  const statsText = formatSingleSubagentStatsText(card);
  if (isDone) {
    return `${marker}${currentTheme.boldFg("success", labelText)} ${currentTheme.fg("success", `Completed${descriptionPlain}${statsText}`)}`;
  }
  const stats = currentTheme.dim(statsText);
  return `${marker}${currentTheme.boldFg("primary", labelText)} ${status}${descriptionText}${stats}`;
}

function wrapPrefixedLines(
  firstPrefix: string,
  continuationPrefix: string,
  text: string,
  width: number,
  tailLines: number,
  minLines: number,
): string[] {
  const safeWidth = Math.max(0, width);
  if (safeWidth <= 0) return [firstPrefix.trimEnd()];
  const prefixWidth = Math.max(firstPrefix.length, continuationPrefix.length);
  const contentWidth = Math.max(1, safeWidth - prefixWidth);
  const wrapped = new Text(text, 0, 0).render(contentWidth);
  const lines =
    wrapped.length > tailLines
      ? wrapped.slice(wrapped.length - tailLines)
      : wrapped;
  while (lines.length < minLines) lines.push("");
  return lines.map((line, index) =>
    truncateToWidth(
      index === 0 ? `${firstPrefix}${line}` : `${continuationPrefix}${line}`,
      safeWidth,
      "…",
    ),
  );
}

export function projectSingleSubagentSummaryLine(
  card: SubagentCardViewState,
  workspaceDir?: string,
): string {
  const toolCount = card.toolActivities.length;
  const countLabel = `${String(toolCount)} tool${toolCount === 1 ? "" : "s"}`;
  const current = getCurrentSubToolActivity(card);
  if (current === undefined) {
    return currentTheme.dim(`  · ${countLabel}`);
  }
  const verb = current.phase === "ongoing" ? "Using" : "Used";
  const keyArg = extractKeyArgument(current.name, current.args, workspaceDir);
  const nameCol = currentTheme.fg("primary", current.name);
  const argCol = keyArg ? currentTheme.dim(` (${keyArg})`) : "";
  const mark =
    current.phase === "failed"
      ? currentTheme.fg("error", " ✗")
      : current.phase === "done"
        ? currentTheme.fg("success", " ✓")
        : "";
  return `${currentTheme.dim(`  · ${countLabel} · `)}${verb} ${nameCol}${argCol}${mark}`;
}

export interface ProjectSingleSubagentBodyOptions {
  readonly card: SubagentCardViewState;
  readonly result: ToolResultBlockData | undefined;
  readonly workspaceDir?: string;
  readonly width?: number;
}

export function projectSingleSubagentBodyLines(
  options: ProjectSingleSubagentBodyOptions,
): string[] {
  const { card, result, workspaceDir, width = 100 } = options;
  const phase = deriveSubagentPhase({ card, result });
  const lines: string[] = [
    projectSingleSubagentSummaryLine(card, workspaceDir),
  ];
  const gutter = currentTheme.dim("│");

  if (phase === "failed") {
    const text =
      card.subagentError === undefined
        ? ""
        : tailNonEmptyLines(card.subagentError, THINKING_PREVIEW_LINES).join(
            "\n",
          );
    lines.push(
      ...wrapPrefixedLines(
        `  ${gutter} `,
        `  ${gutter} `,
        currentTheme.fg("error", text),
        width,
        THINKING_PREVIEW_LINES,
        THINKING_PREVIEW_LINES,
      ),
    );
    return lines;
  }

  if (phase === "done" || phase === "backgrounded") {
    const text = tailNonEmptyLines(
      card.subagentText,
      THINKING_PREVIEW_LINES,
    ).join("\n");
    lines.push(
      ...wrapPrefixedLines(
        `  ${gutter} `,
        `  ${gutter} `,
        currentTheme.fg("text", text),
        width,
        THINKING_PREVIEW_LINES,
        THINKING_PREVIEW_LINES,
      ),
    );
    return lines;
  }

  const content = getActiveSubagentContent(card);
  const styled =
    content === undefined
      ? currentTheme.dim("…")
      : content.tone === "thinking"
        ? currentTheme.dim(content.text)
        : currentTheme.fg("textDim", content.text);
  lines.push(
    ...wrapPrefixedLines(
      `  ${gutter} `,
      `  ${gutter} `,
      styled,
      width,
      THINKING_PREVIEW_LINES,
      THINKING_PREVIEW_LINES,
    ),
  );
  return lines;
}

export function hasSubagentCardView(
  toolCall: ToolCallBlockData,
): toolCall is ToolCallBlockData & { subagentCard: SubagentCardViewState } {
  return toolCall.name === "Agent" && toolCall.subagentCard !== undefined;
}

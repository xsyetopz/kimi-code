import { Box, Text } from "ink";
import { type ReactNode } from "react";

import type { TranscriptEntry, ToolCallBlockData } from "../../types";
import { currentTheme } from "../../theme";
import { truncateToWidth } from "@moonshot-ai/kimi-tui";

export interface ToolCallProps {
  readonly entry: TranscriptEntry;
}

const PREVIEW_LINES = 3;
const CHIP_INDENT = "  ";

function toolChip(name: string): string {
  return currentTheme.fg("accent", name);
}

function strArg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (typeof v === "string") return v;
  return undefined;
}

function summarizeArgs(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "Bash":
      return strArg(args, "command") ?? "";
    case "Read":
      return strArg(args, "path") ?? "";
    case "Edit":
    case "Write":
      return strArg(args, "path") ?? "";
    case "Grep":
      return strArg(args, "pattern") ?? "";
    case "Glob":
      return strArg(args, "pattern") ?? "";
    case "FetchURL":
      return strArg(args, "url") ?? "";
    case "WebSearch":
      return strArg(args, "query") ?? "";
    case "Think":
      return "";
    default: {
      // For MCP tools, show the first string arg
      for (const v of Object.values(args)) {
        if (typeof v === "string" && v.length > 0) return v;
      }
      return "";
    }
  }
}

function resultChip(_name: string, result: { output: string; is_error?: boolean } | undefined): string | null {
  if (!result) return null;
  if (result.is_error) return currentTheme.fg("error", "✗");
  return currentTheme.fg("success", "✓");
}

/**
 * Renders a tool call card: header with tool name chip + args preview,
 * and a truncated result preview. Matches the kimi-tui ToolCallComponent's
 * compact (non-expanded) form.
 */
export function ToolCall({ entry }: ToolCallProps): ReactNode {
  const data: ToolCallBlockData | undefined = entry.toolCallData;
  if (!data) return null;

  const streaming = data.streamingArguments !== undefined && !data.result;
  const truncated = data.truncated;

  const headerVerb = truncated ? "Truncated" : streaming ? "Running" : data.result ? "Called" : "Calling";
  const chip = toolChip(data.name);
  const summary = streaming
    ? (data.streamingArguments ?? "")
    : summarizeArgs(data.name, data.args);
  const resultMark = resultChip(data.name, data.result);

  // Build the header line
  const header = `${currentTheme.fg("textDim", headerVerb)} ${chip}${summary ? ` ${currentTheme.fg("textDim", summary)}` : ""}${resultMark ? ` ${resultMark}` : ""}`;

  const lines: ReactNode[] = [
    <Text key="header">{header}</Text>,
  ];

  // Result preview (if present and not an error-free empty output)
  if (data.result && data.result.output) {
    const outputLines = data.result.output.split("\n").filter((l) => l.length > 0);
    const previewLines = outputLines.slice(0, PREVIEW_LINES);
    const hasMore = outputLines.length > PREVIEW_LINES;
    const color = data.result.is_error ? currentTheme.color("error") : currentTheme.color("textDim");

    for (let i = 0; i < previewLines.length; i++) {
      const line = previewLines[i];
      const truncated = truncateToWidth(line, 76);
      lines.push(
        <Text key={`result-${i}`} color={color}>
          {CHIP_INDENT}
          {truncated}
        </Text>,
      );
    }
    if (hasMore) {
      lines.push(
        <Text key="result-more" color={currentTheme.color("textMuted")}>
          {CHIP_INDENT}… {outputLines.length - PREVIEW_LINES} more lines
        </Text>,
      );
    }
  }

  return (
    <Box flexDirection="column" paddingLeft={2}>
      {lines}
    </Box>
  );
}

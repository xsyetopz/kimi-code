import {
  highlightLines,
  langFromPath,
} from "#/tui/components/media/code-highlight";
import { renderDiffLinesClustered } from "#/tui/components/media/diff-preview";
import { COMMAND_PREVIEW_LINES } from "#/tui/constant/rendering";
import { STREAMING_ARGS_PREVIEW_MAX_CHARS } from "#/tui/constant/streaming";
import { currentTheme } from "#/tui/theme";
import type { ToolCallBlockData, ToolResultBlockData } from "#/tui/types";

const PREVIEW_INDENT = "  ";

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes)}m ${String(remainder)}s`;
}

/**
 * Pull the live value of a JSON string field out of partially-streamed
 * arguments, even if the closing quote hasn't arrived yet.
 */
export function extractPartialStringField(
  text: string,
  key: string,
): string | undefined {
  const opener = new RegExp(`"${key}"\\s*:\\s*"`);
  const match = opener.exec(text);
  if (match === null) return undefined;
  const start = match.index + match[0].length;
  let out = "";
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      const next = text[i + 1];
      if (next === undefined) return out;
      switch (next) {
        case "n":
          out += "\n";
          break;
        case "t":
          out += "\t";
          break;
        case "r":
          out += "\r";
          break;
        case "b":
          out += "\b";
          break;
        case "f":
          out += "\f";
          break;
        case '"':
          out += '"';
          break;
        case "\\":
          out += "\\";
          break;
        case "/":
          out += "/";
          break;
        case "u": {
          if (i + 5 >= text.length) return out;
          const hex = text.slice(i + 2, i + 6);
          const code = Number.parseInt(hex, 16);
          if (Number.isNaN(code)) return out;
          out += String.fromCodePoint(code);
          i += 6;
          continue;
        }
        default:
          out += next;
      }
      i += 2;
      continue;
    }
    if (ch === '"') return out;
    out += ch;
    i++;
  }
  return out;
}

export interface ProjectWriteEditPreviewOptions {
  readonly toolCall: ToolCallBlockData;
  readonly result?: ToolResultBlockData | undefined;
  readonly expanded?: boolean;
  /** Wall clock for Edit streaming elapsed text (defaults to Date.now()). */
  readonly nowMs?: number;
}

function projectWriteStreamingPreviewLines(
  streamText: string,
): string[] {
  const previewText = streamText.slice(0, STREAMING_ARGS_PREVIEW_MAX_CHARS);
  const content = extractPartialStringField(previewText, "content");
  if (content === undefined || content.length === 0) return [];
  const filePath =
    extractPartialStringField(previewText, "file_path") ??
    extractPartialStringField(previewText, "path") ??
    "";
  const lang = langFromPath(filePath);
  const allLines = highlightLines(content, lang);
  const maxLines = COMMAND_PREVIEW_LINES;
  const scrollLines =
    allLines.length > maxLines
      ? allLines.slice(allLines.length - maxLines)
      : allLines;
  const lines: string[] = [];
  for (const [i, line] of scrollLines.entries()) {
    const originalLineNumber =
      allLines.length > maxLines ? allLines.length - maxLines + i : i;
    const lineNum = currentTheme.dim(
      String(originalLineNumber + 1).padStart(4) + "  ",
    );
    lines.push(`${PREVIEW_INDENT}${lineNum}${line}`);
  }
  return lines;
}

function projectWriteFinalizedPreviewLines(
  toolCall: ToolCallBlockData,
  expanded: boolean,
): string[] {
  const content = str(toolCall.args["content"]);
  if (content.length === 0) return [];
  const filePath = str(
    toolCall.args["file_path"] ?? toolCall.args["path"],
  );
  const lang = langFromPath(filePath);
  const allLines = highlightLines(content, lang);
  const shouldCap = !expanded;
  const shown = shouldCap
    ? allLines.slice(0, COMMAND_PREVIEW_LINES)
    : allLines;
  const remaining = allLines.length - shown.length;
  const lines: string[] = [];
  for (const [i, line] of shown.entries()) {
    const lineNum = currentTheme.dim(String(i + 1).padStart(4) + "  ");
    lines.push(`${PREVIEW_INDENT}${lineNum}${line}`);
  }
  if (shouldCap && remaining > 0) {
    lines.push(
      currentTheme.dim(
        `${PREVIEW_INDENT}... (${String(remaining)} more lines, ${String(allLines.length)} total, ctrl+o to expand)`,
      ),
    );
  }
  return lines;
}

function projectEditStreamingPreviewLines(
  streamText: string,
  streamingStartedAtMs: number | undefined,
  nowMs: number,
): string[] {
  const previewText = streamText.slice(0, STREAMING_ARGS_PREVIEW_MAX_CHARS);
  const filePath =
    extractPartialStringField(previewText, "file_path") ??
    extractPartialStringField(previewText, "path") ??
    "";
  const bytes = Buffer.byteLength(previewText, "utf8");
  const elapsedSeconds =
    streamingStartedAtMs === undefined
      ? 0
      : Math.max(0, Math.floor((nowMs - streamingStartedAtMs) / 1000));
  const target = filePath.length > 0 ? ` for ${filePath}` : "";
  const progress = `Preparing changes${target}... ${formatByteSize(bytes)} · ${formatElapsed(
    elapsedSeconds,
  )} elapsed`;
  return [currentTheme.dim(`${PREVIEW_INDENT}${progress}`)];
}

function projectEditFinalizedPreviewLines(
  toolCall: ToolCallBlockData,
  expanded: boolean,
): string[] {
  const oldStr = str(toolCall.args["old_string"]);
  const newStr = str(toolCall.args["new_string"]);
  if (oldStr.length === 0 && newStr.length === 0) return [];
  const filePath = str(
    toolCall.args["file_path"] ?? toolCall.args["path"],
  );
  const shouldCap = !expanded;
  return renderDiffLinesClustered(oldStr, newStr, filePath, {
    contextLines: 3,
    ...(shouldCap ? { maxLines: COMMAND_PREVIEW_LINES } : {}),
  }).map((line) => `${PREVIEW_INDENT}${line}`);
}

/** Write / Edit call-preview body lines (ANSI) for Ink and pi-tui parity. */
export function projectWriteEditPreviewLines(
  options: ProjectWriteEditPreviewOptions,
): string[] {
  const {
    toolCall,
    result,
    expanded = false,
    nowMs = Date.now(),
  } = options;
  const name = toolCall.name;
  if (name !== "Write" && name !== "Edit") return [];

  if (
    result === undefined &&
    toolCall.streamingArguments !== undefined
  ) {
    if (name === "Write") {
      return projectWriteStreamingPreviewLines(toolCall.streamingArguments);
    }
    return projectEditStreamingPreviewLines(
      toolCall.streamingArguments,
      toolCall.streamingStartedAtMs,
      nowMs,
    );
  }

  if (name === "Write") {
    return projectWriteFinalizedPreviewLines(toolCall, expanded);
  }
  return projectEditFinalizedPreviewLines(toolCall, expanded);
}

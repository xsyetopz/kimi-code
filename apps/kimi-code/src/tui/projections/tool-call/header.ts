import { STATUS_BULLET } from "#/tui/constant/symbols";
import { buildGoalToolHeader } from "#/tui/components/messages/tool-renderers/goal";
import { pickChip } from "#/tui/components/messages/tool-renderers/chip";
import { currentTheme } from "#/tui/theme";
import type { ToolCallBlockData, ToolResultBlockData } from "#/tui/types";
import { decodeMcpToolName } from "#/tui/utils/mcp-tool-name";

import { interpretExitPlanModeOutcome } from "./exit-plan-mode";
import { extractKeyArgument } from "./key-argument";

export interface ProjectToolCallHeaderOptions {
  readonly toolCall: ToolCallBlockData;
  readonly result: ToolResultBlockData | undefined;
  readonly workspaceDir?: string;
}

function buildHeaderChip(
  toolCall: ToolCallBlockData,
  result: ToolResultBlockData,
): string {
  const provider = pickChip(toolCall.name);
  if (provider === undefined) return "";
  const text = provider(toolCall, result);
  if (text.length === 0) return "";
  if (result.is_error) return currentTheme.fg("error", ` · ${text}`);
  return currentTheme.dim(` · ${text}`);
}

/** Framework-free tool-call header line (ANSI), shared by pi-tui and Ink. */
export function projectToolCallHeader(
  options: ProjectToolCallHeaderOptions,
): string {
  const { toolCall, result, workspaceDir } = options;
  const isFinished = result !== undefined;
  const isError = result?.is_error ?? false;
  const isTruncated = toolCall.truncated === true && !isFinished;

  let bullet: string;
  if (isFinished) {
    bullet = isError
      ? currentTheme.fg("error", "✗ ")
      : currentTheme.fg("success", STATUS_BULLET);
  } else if (isTruncated) {
    bullet = currentTheme.fg("error", "✗ ");
  } else {
    bullet = currentTheme.fg("text", STATUS_BULLET);
  }

  if (toolCall.name === "ExitPlanMode") {
    const label = currentTheme.boldFg("primary", "Current plan");
    if (!isFinished || result === undefined || result.is_error === true) {
      return label;
    }
    const outcome = interpretExitPlanModeOutcome(result.output);
    if (outcome.kind === "approved") {
      const chipText =
        outcome.chosen !== undefined && outcome.chosen.length > 0
          ? `Approved: ${outcome.chosen}`
          : "Approved";
      return `${label}${currentTheme.fg("success", ` · ${chipText}`)}`;
    }
    if (outcome.kind === "auto_approved") {
      return `${label}${currentTheme.fg("warning", " · Auto-approved")}`;
    }
    return label;
  }

  if (toolCall.name === "AskUserQuestion") {
    const isBackgroundAsk = toolCall.args["background"] === true;
    const label = isFinished
      ? isError
        ? "Could not collect your input"
        : isBackgroundAsk
          ? "Started background question"
          : "Collected your answers"
      : isBackgroundAsk
        ? "Starting background question"
        : "Waiting for your input";
    const tone = isError ? "error" : "primary";
    return `${bullet}${currentTheme.boldFg(tone, label)}`;
  }

  if (toolCall.name === "Bash") {
    if (isTruncated) {
      return `${bullet}${currentTheme.fg("error", "Truncated")} ${currentTheme.boldFg("primary", "Bash")}`;
    }
    const label = isFinished ? "Ran a command" : "Running a command";
    const tone = isError ? "error" : "primary";
    const chipStr =
      isFinished && result !== undefined
        ? buildHeaderChip(toolCall, result)
        : "";
    return `${bullet}${currentTheme.boldFg(tone, label)}${chipStr}`;
  }

  const goalHeader = buildGoalToolHeader({
    toolCall,
    result,
    bullet,
    chip:
      isFinished && result !== undefined
        ? buildHeaderChip(toolCall, result)
        : "",
  });
  if (goalHeader !== undefined) return goalHeader;

  const verb = isFinished ? "Used" : isTruncated ? "Truncated" : "Using";
  const keyArg = extractKeyArgument(toolCall.name, toolCall.args, workspaceDir);
  const decoded = decodeMcpToolName(toolCall.name);
  const verbStyled = isTruncated ? currentTheme.fg("error", verb) : verb;
  const toolLabel =
    decoded !== null
      ? `${currentTheme.boldFg("primary", decoded.toolName)}${currentTheme.dim(` · MCP/${decoded.serverName}`)}`
      : currentTheme.boldFg("primary", toolCall.name);
  const argStr = keyArg ? currentTheme.dim(` (${keyArg})`) : "";
  let chipStr = "";
  if (isFinished && result) chipStr = buildHeaderChip(toolCall, result);
  return `${bullet}${verbStyled} ${toolLabel}${argStr}${chipStr}`;
}

import type { Component } from "@moonshot-ai/kimi-tui";

import { pickResultRenderer } from "#/tui/components/messages/tool-renderers/registry";
import { currentTheme } from "#/tui/theme";
import type { ToolCallBlockData, ToolResultBlockData } from "#/tui/types";

import { projectAgentSwarmResultSummaryLines } from "./agent-swarm-result";
import { projectWriteEditPreviewLines } from "./call-preview";
import {
  interpretExitPlanModeOutcome,
  isExitPlanModeOutcomeOutput,
} from "./exit-plan-mode";

export interface ProjectToolCallBodyOptions {
  readonly toolCall: ToolCallBlockData;
  readonly result: ToolResultBlockData | undefined;
  readonly expanded?: boolean;
  readonly width?: number;
  /** When true, skip result body (Agent single-card layout owns the body). */
  readonly skipResultBody?: boolean;
}

function strArg(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v : "";
}

function renderComponentsToLines(
  components: readonly Component[],
  width: number,
): string[] {
  const lines: string[] = [];
  for (const component of components) {
    lines.push(...component.render(width));
  }
  return lines;
}

/** Preview / result body lines (ANSI) for Ink and parity tests. */
export function projectToolCallBodyLines(
  options: ProjectToolCallBodyOptions,
): string[] {
  const {
    toolCall,
    result,
    expanded = false,
    width = 100,
    skipResultBody = false,
  } = options;
  const lines: string[] = [];

  if (result === undefined && toolCall.truncated === true) {
    lines.push(
      currentTheme.dim(
        "  Tool call arguments truncated by max_tokens — call never executed.",
      ),
    );
    return lines;
  }

  if (
    toolCall.name === "Write" ||
    toolCall.name === "Edit"
  ) {
    lines.push(
      ...projectWriteEditPreviewLines({
        toolCall,
        result,
        expanded,
      }),
    );
  } else if (
    result === undefined &&
    toolCall.streamingArguments !== undefined &&
    toolCall.streamingArguments.length > 0
  ) {
    const preview = toolCall.streamingArguments.slice(0, 240);
    lines.push(currentTheme.dim(`  ${preview}`));
  }

  if (toolCall.name === "Bash") {
    const command = strArg(toolCall.args, "command");
    if (command.length > 0) {
      lines.push(currentTheme.fg("shellMode", `  $ ${command}`));
    }
  }

  if (result === undefined || skipResultBody) return lines;
  if (!result.output) return lines;

  if (toolCall.name === "AgentSwarm") {
    lines.push(...projectAgentSwarmResultSummaryLines(result));
    return lines;
  }

  if (result.output.trimStart().startsWith("<system-reminder>")) {
    return lines;
  }

  if (
    toolCall.name === "ExitPlanMode" &&
    isExitPlanModeOutcomeOutput(result.output)
  ) {
    const outcome = interpretExitPlanModeOutcome(result.output);
    if (outcome.kind === "rejected" && outcome.feedback !== undefined) {
      const trimmed = outcome.feedback.trim();
      if (trimmed.length > 0) {
        lines.push(currentTheme.boldFg("warning", "  ↪ Suggestion"));
        for (const line of trimmed.split("\n")) {
          lines.push(`    ${line}`);
        }
      }
    }
    return lines;
  }

  if (toolCall.name === "TodoList" && !result.is_error) {
    return lines;
  }

  if (toolCall.name === "EnterPlanMode" && !result.is_error) {
    return lines;
  }

  const renderer = pickResultRenderer(toolCall.name);
  lines.push(
    ...renderComponentsToLines(
      renderer(toolCall, result, { expanded }),
      width,
    ),
  );
  return lines;
}

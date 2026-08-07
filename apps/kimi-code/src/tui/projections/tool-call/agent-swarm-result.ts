import { FAILURE_MARK, SUCCESS_MARK } from "#/tui/constant/symbols";
import {
  agentSwarmFailureTextFromOutput,
  agentSwarmResultSummaryFromOutput,
} from "#/tui/components/messages/agent-swarm-progress";
import { currentTheme } from "#/tui/theme";
import type { ToolResultBlockData } from "#/tui/types";

const ABORTED_MARK = "⊘";

/** Result summary lines for a finished AgentSwarm tool call (replay / Ink body). */
export function projectAgentSwarmResultSummaryLines(
  result: ToolResultBlockData,
): string[] {
  const dim = (s: string): string => currentTheme.fg("textDim", s);
  const summary = agentSwarmResultSummaryFromOutput(result.output);
  const segments: string[] = [];

  if (summary.completed > 0) {
    segments.push(
      currentTheme.fg(
        "success",
        `${SUCCESS_MARK.trimEnd()} ${String(summary.completed)} completed`,
      ),
    );
  }
  if (summary.failed > 0) {
    segments.push(
      currentTheme.fg(
        "error",
        `${FAILURE_MARK.trimEnd()} ${String(summary.failed)} failed`,
      ),
    );
  }
  if (summary.aborted > 0) {
    segments.push(
      currentTheme.fg(
        "warning",
        `${ABORTED_MARK} ${String(summary.aborted)} aborted`,
      ),
    );
  }

  if (segments.length > 0) {
    return [`${dim("Agent swarm: ")}${segments.join(dim(" · "))}`];
  }

  if (result.is_error === true && !summary.parsed) {
    const errorText = agentSwarmFailureTextFromOutput(result.output);
    if (errorText !== undefined) {
      return [
        `${dim("Agent swarm: ")}${currentTheme.fg("error", `${FAILURE_MARK}${errorText}`)}`,
      ];
    }
  }

  const isAborted =
    result.is_error === true &&
    /\b(?:aborted|cancelled)\b/i.test(result.output);
  const colorToken = isAborted
    ? "warning"
    : result.is_error === true
      ? "error"
      : "success";
  const label = isAborted
    ? `${ABORTED_MARK} Aborted.`
    : result.is_error === true
      ? `${FAILURE_MARK.trimEnd()} Failed.`
      : `${SUCCESS_MARK.trimEnd()} Completed.`;
  return [`${dim("Agent swarm: ")}${currentTheme.fg(colorToken, label)}`];
}

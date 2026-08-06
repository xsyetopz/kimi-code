import { renderAgentSwarmProgressView } from "#/tui/components/messages/agent-swarm-progress";
import type { AgentSwarmProgressViewState, ToolCallBlockData } from "#/tui/types";

export interface ProjectAgentSwarmLinesOptions {
  readonly state: AgentSwarmProgressViewState;
  readonly width?: number;
  readonly gridHeight?: number;
}

export function hasAgentSwarmProgressView(
  toolCall: ToolCallBlockData,
): toolCall is ToolCallBlockData & {
  agentSwarmProgress: AgentSwarmProgressViewState;
} {
  return toolCall.name === "AgentSwarm" && toolCall.agentSwarmProgress !== undefined;
}

/** Full AgentSwarm card lines (ANSI) for Ink, shared with pi-tui layout. */
export function projectAgentSwarmLines(
  options: ProjectAgentSwarmLinesOptions,
): string[] {
  const { state, width = 100, gridHeight } = options;
  return renderAgentSwarmProgressView(state, width, {
    availableGridHeight:
      gridHeight === undefined ? undefined : () => gridHeight,
  });
}

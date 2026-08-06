import { Box, Text } from "ink";
import { type ReactNode } from "react";

import { projectAgentSwarmLines } from "../../../projections/tool-call/agent-swarm";
import type { TranscriptEntry } from "../../../types";

export interface AgentSwarmProps {
  readonly entry: TranscriptEntry;
  readonly width?: number;
  readonly gridHeight?: number;
}

/**
 * Ink AgentSwarm grid — lines come from the shared projection layer so
 * production Ink matches the pi-tui swarm card layout.
 */
export function AgentSwarm({
  entry,
  width = 100,
  gridHeight,
}: AgentSwarmProps): ReactNode {
  const data = entry.toolCallData;
  const state = data?.agentSwarmProgress;
  if (!data || !state) return null;

  const lines = projectAgentSwarmLines({ state, width, gridHeight });

  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={`swarm-${index}`}>{line.length > 0 ? line : " "}</Text>
      ))}
    </Box>
  );
}

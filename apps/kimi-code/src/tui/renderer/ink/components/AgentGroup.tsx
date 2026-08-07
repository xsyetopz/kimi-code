import { Box, Text } from "ink";
import { type ReactNode } from "react";

import { projectAgentGroupLines } from "../../../projections/tool-call/agent-group";
import type { TranscriptEntry } from "../../../types";

export interface AgentGroupProps {
  readonly entry: TranscriptEntry;
}

/** Ink Agent group card — lines come from the shared projection layer. */
export function AgentGroup({ entry }: AgentGroupProps): ReactNode {
  const state = entry.agentGroupData;
  if (!state) return null;

  const lines = projectAgentGroupLines(state);

  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={`agent-group-${index}`}>{line.length > 0 ? line : " "}</Text>
      ))}
    </Box>
  );
}

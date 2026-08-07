import { Box, Text } from "ink";
import { type ReactNode } from "react";

import { projectReadGroupLines } from "../../../projections/tool-call/read-group";
import type { TranscriptEntry } from "../../../types";

export interface ReadGroupProps {
  readonly entry: TranscriptEntry;
}

/** Ink Read group card — lines come from the shared projection layer. */
export function ReadGroup({ entry }: ReadGroupProps): ReactNode {
  const state = entry.readGroupData;
  if (!state) return null;

  const lines = projectReadGroupLines(state);

  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={`read-group-${index}`}>{line.length > 0 ? line : " "}</Text>
      ))}
    </Box>
  );
}

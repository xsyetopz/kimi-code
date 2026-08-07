import { Box, Text } from "ink";
import { type ReactNode } from "react";

import { projectCompactionLines } from "../../../projections/compaction";
import type { TranscriptEntry } from "../../../types";

export interface CompactionProps {
  readonly entry: TranscriptEntry;
}

/** Ink compaction block — lines come from the shared projection layer. */
export function Compaction({ entry }: CompactionProps): ReactNode {
  const data = entry.compactionData;
  if (!data) return null;

  const lines = projectCompactionLines({
    data,
    blinkOn: data.blinkOn ?? true,
  });

  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={`compaction-${index}`}>{line.length > 0 ? line : " "}</Text>
      ))}
    </Box>
  );
}

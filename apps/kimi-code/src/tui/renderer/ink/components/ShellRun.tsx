import { Box, Text } from "ink";
import { type ReactNode } from "react";

import { projectShellRunLines } from "../../../projections/shell-run";
import type { TranscriptEntry } from "../../../types";

export interface ShellRunProps {
  readonly entry: TranscriptEntry;
}

/** Ink shell-run card — lines come from the shared projection layer. */
export function ShellRun({ entry }: ShellRunProps): ReactNode {
  const state = entry.shellRunData;
  if (!state) return null;

  const lines = projectShellRunLines(state);

  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={`shell-run-${index}`}>{line.length > 0 ? line : " "}</Text>
      ))}
    </Box>
  );
}

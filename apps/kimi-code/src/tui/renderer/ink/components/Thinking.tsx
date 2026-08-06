import { Box, Text } from "ink";
import { type ReactNode } from "react";

import type { TranscriptEntry } from "../../../types";
import { currentTheme } from "../../../theme";

export interface ThinkingProps {
  readonly entry: TranscriptEntry;
}

/**
 * Renders a thinking block: dim bullet + dim text content.
 * Matches the kimi-tui ThinkingComponent's finalized mode.
 */
export function Thinking({ entry }: ThinkingProps): ReactNode {
  const bullet = currentTheme.fg("textDim", "●");

  return (
    <Box flexDirection="column">
      <Text color={currentTheme.color("textDim")}>
        {bullet} {entry.content}
      </Text>
    </Box>
  );
}

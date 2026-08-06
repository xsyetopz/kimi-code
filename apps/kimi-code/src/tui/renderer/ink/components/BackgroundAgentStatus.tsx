import { Box, Text } from "ink";
import { type ReactNode } from "react";

import type { TranscriptEntry } from "../../../types";
import { currentTheme } from "../../../theme";

export interface BackgroundAgentStatusProps {
  readonly entry: TranscriptEntry;
}

/**
 * Renders a single-line status for backgrounded agents.
 * Phase-colored bullet: started=primary, completed=success, failed=error.
 */
export function BackgroundAgentStatus({ entry }: BackgroundAgentStatusProps): ReactNode {
  const status = entry.backgroundAgentStatus;
  if (!status) return null;

  const phaseColors: Record<string, string> = {
    started: currentTheme.color("primary"),
    completed: currentTheme.color("success"),
    failed: currentTheme.color("error"),
  };
  const color = phaseColors[status.phase] ?? currentTheme.color("text");

  return (
    <Box flexDirection="column">
      <Text color={color}>
        ● {status.headline}
        {status.detail ? ` (${status.detail})` : ""}
      </Text>
    </Box>
  );
}

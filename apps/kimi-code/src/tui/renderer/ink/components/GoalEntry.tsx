import { Box, Text } from "ink";
import { type ReactNode } from "react";

import type { TranscriptEntry } from "../../../types";
import { currentTheme } from "../../../theme";

export interface GoalEntryProps {
  readonly entry: TranscriptEntry;
}

/**
 * Renders a goal transcript entry. Two sub-types:
 * - "created": "● Goal created"
 * - "lifecycle": dim marker like "◦ Goal paused" with the change reason
 */
export function GoalEntry({ entry }: GoalEntryProps): ReactNode {
  if (!entry.goalData) return null;

  if (entry.goalData.kind === "created") {
    return (
      <Box flexDirection="column">
        <Text color={currentTheme.color("primary")}>
          {currentTheme.fg("primary", "●")} Goal created
        </Text>
      </Box>
    );
  }

  // Lifecycle change — low-profile dim marker
  const change = entry.goalData.change;
  return (
    <Box flexDirection="column">
      <Text color={currentTheme.color("textMuted")}>◦ Goal {change}</Text>
    </Box>
  );
}

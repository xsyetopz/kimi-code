import { Box, Text } from "ink";
import { type ReactNode } from "react";

import type { TranscriptEntry } from "../../types";
import { currentTheme } from "../../theme";

export interface UserMessageProps {
  readonly entry: TranscriptEntry;
}

const USER_BULLET = "✦";

/**
 * Renders a user message with the sparkles bullet and the user's text.
 * Shell-command echoes use an empty bullet (the "$" prefix is in the content).
 */
export function UserMessage({ entry }: UserMessageProps): ReactNode {
  const bullet = entry.bullet === "" ? "" : (entry.bullet ?? USER_BULLET);
  const prefix = bullet === "" ? "" : `${currentTheme.fg("roleUser", bullet)} `;

  return (
    <Box flexDirection="column">
      <Text>
        {prefix}
        {entry.content}
      </Text>
    </Box>
  );
}

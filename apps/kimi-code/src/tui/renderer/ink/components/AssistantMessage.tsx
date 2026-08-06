import { Box, Text } from "ink";
import { type ReactNode } from "react";

import type { TranscriptEntry } from "../../../types";
import { currentTheme } from "../../../theme";

export interface AssistantMessageProps {
  readonly entry: TranscriptEntry;
}

/**
 * Renders an assistant message with a bullet marker and markdown content.
 * The content string already contains ANSI color codes from the streaming
 * renderer, so we pass it through as-is. The bullet uses the theme's primary
 * color, matching the kimi-tui AssistantMessageComponent.
 */
export function AssistantMessage({ entry }: AssistantMessageProps): ReactNode {
  const bullet = currentTheme.fg("primary", "●");

  // Goal completion messages get special treatment
  if (entry.content.startsWith("✓ Goal complete")) {
    return (
      <Box flexDirection="column">
        <Text color={currentTheme.color("success")}>{entry.content}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text>
        {bullet} {entry.content}
      </Text>
    </Box>
  );
}

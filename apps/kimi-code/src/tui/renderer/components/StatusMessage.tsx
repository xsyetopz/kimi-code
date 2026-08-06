import { Box, Text } from "ink";
import { type ReactNode } from "react";

import type { TranscriptEntry } from "../../types";
import { currentTheme } from "../../theme";

export interface StatusMessageProps {
  readonly entry: TranscriptEntry;
}

/**
 * Renders a status message. Two sub-types:
 * - "notice": bold title + dim detail (with spacer)
 * - "plain"/"markdown": indented text, optionally colored by the entry's color token
 */
export function StatusMessage({ entry }: StatusMessageProps): ReactNode {
  if (entry.renderMode === "notice") {
    return (
      <Box flexDirection="column">
        <Box flexDirection="column">
          <Text bold color={currentTheme.color("text")}>
            {entry.content}
          </Text>
          {entry.detail ? (
            <Text color={currentTheme.color("textMuted")}>
              {entry.detail}
            </Text>
          ) : null}
        </Box>
      </Box>
    );
  }

  const colorToken = entry.color;
  const color = colorToken ? currentTheme.color(colorToken) : currentTheme.color("textDim");

  return (
    <Box flexDirection="column">
      <Text color={color}>
        {"  "}
        {entry.content}
      </Text>
    </Box>
  );
}

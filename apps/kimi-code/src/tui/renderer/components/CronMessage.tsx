import { Box, Text } from "ink";
import { type ReactNode } from "react";

import type { TranscriptEntry } from "../../types";
import { currentTheme } from "../../theme";

export interface CronMessageProps {
  readonly entry: TranscriptEntry;
}

/**
 * Renders a cron task message: title (fired/missed), detail (cron/recurring/coalesced),
 * and the prompt text.
 */
export function CronMessage({ entry }: CronMessageProps): ReactNode {
  const data = entry.cronData;
  const isMissed = data?.missedCount !== undefined && data.missedCount > 0;
  const titleColor = isMissed ? currentTheme.color("warning") : currentTheme.color("text");

  return (
    <Box flexDirection="column">
      <Text color={titleColor}>
        {isMissed ? "⚠" : "●"} {entry.content}
      </Text>
      {data ? (
        <Text color={currentTheme.color("textMuted")}>
          {"  "}
          {[
            data.cron,
            data.recurring ? "recurring" : "one-shot",
            data.coalescedCount ? `coalesced ${data.coalescedCount}` : null,
            data.stale ? "stale" : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      ) : null}
    </Box>
  );
}

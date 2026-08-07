import { Box, Text } from "ink";
import { type ReactNode } from "react";

import type { InkQueueProjection } from "../terminal-view";

export interface InkQueueProps {
  readonly queue: InkQueueProjection;
}

/** Renders queued messages and the edit/steer hint below the activity pane. */
export function InkQueue({ queue }: InkQueueProps): ReactNode {
  if (queue.messages.length === 0) {
    return null;
  }
  return (
    <Box flexDirection="column">
      {queue.messages.map((message, index) => (
        <Text key={`${index}-${message}`}>{message}</Text>
      ))}
      {queue.hint === undefined ? null : (
        <Text dimColor>{queue.hint}</Text>
      )}
    </Box>
  );
}

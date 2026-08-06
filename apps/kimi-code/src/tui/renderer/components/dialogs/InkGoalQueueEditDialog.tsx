import { Box, Text } from "ink";
import { type ReactNode } from "react";

import { currentTheme } from "../../../theme";
import type { InkGoalQueueEditView } from "../../ink-goal-queue-edit";

export interface InkGoalQueueEditDialogProps {
  readonly edit: InkGoalQueueEditView;
}

export function InkGoalQueueEditDialog({
  edit,
}: InkGoalQueueEditDialogProps): ReactNode {
  return (
    <Box flexDirection="column">
      <Text>{currentTheme.boldFg("textStrong", edit.title)}</Text>
      <Text> </Text>
      <Text>
        {currentTheme.fg(
          edit.subtitleIsError ? "warning" : "textDim",
          edit.subtitle,
        )}
      </Text>
      <Text> </Text>
      {edit.inputLines.map((line, index) => (
        <Text key={`input-${index}`}>{line}</Text>
      ))}
      <Text> </Text>
      <Text>{currentTheme.fg("textDim", edit.footer)}</Text>
    </Box>
  );
}

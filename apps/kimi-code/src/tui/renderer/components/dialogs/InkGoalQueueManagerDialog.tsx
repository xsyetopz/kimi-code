import { Box, Text } from "ink";
import { type ReactNode } from "react";

import { SELECT_POINTER } from "../../../constant/symbols";
import { currentTheme } from "../../../theme";
import type { InkGoalQueueManagerView } from "../../ink-goal-queue-manager";

export interface InkGoalQueueManagerDialogProps {
  readonly manager: InkGoalQueueManagerView;
}

export function InkGoalQueueManagerDialog({
  manager,
}: InkGoalQueueManagerDialogProps): ReactNode {
  return (
    <Box flexDirection="column">
      <Text>{currentTheme.boldFg("primary", manager.title)}</Text>
      <Text>{currentTheme.fg("textMuted", manager.hint)}</Text>
      {manager.empty ? (
        <Text>{currentTheme.fg("textMuted", "  No upcoming goals.")}</Text>
      ) : (
        manager.rows.map((row) => (
          <Text key={`${row.index}:${row.label}`}>
            {currentTheme.fg(row.selected ? "primary" : "textDim", `  ${row.selected ? SELECT_POINTER : " "} `)}
            {row.selected
              ? currentTheme.boldFg("primary", row.label)
              : currentTheme.fg("text", row.label)}
            {row.moving
              ? currentTheme.fg("success", "  selected")
              : null}
          </Text>
        ))
      )}
      {manager.belowCount > 0 ? (
        <Text>
          {currentTheme.fg("textMuted", ` ▼ ${String(manager.belowCount)} more`)}
        </Text>
      ) : null}
    </Box>
  );
}

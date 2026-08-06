import { Box, Text } from "ink";
import { type ReactNode } from "react";

import { SELECT_POINTER } from "../../../constant/symbols";
import { currentTheme } from "../../../theme";
import type { InkUndoSelectorView } from "../../ink-undo-selector";

export interface InkUndoSelectorDialogProps {
  readonly selector: InkUndoSelectorView;
}

export function InkUndoSelectorDialog({
  selector,
}: InkUndoSelectorDialogProps): ReactNode {
  return (
    <Box flexDirection="column">
      <Text>{currentTheme.boldFg("primary", selector.title)}</Text>
      <Text>{currentTheme.fg("textMuted", selector.hint)}</Text>
      {selector.rows.length === 0 ? (
        <Text>{currentTheme.fg("textMuted", "No messages")}</Text>
      ) : (
        selector.rows.map((row) => {
          const pointer = row.isSelected ? SELECT_POINTER : " ";
          const label = row.isSelected
            ? currentTheme.boldFg("primary", row.label)
            : row.inUndoRange
              ? currentTheme.fg("textDim", row.label)
              : currentTheme.fg("text", row.label);
          return (
            <Text key={row.id}>
              {`  ${pointer} `}
              {label}
            </Text>
          );
        })
      )}
    </Box>
  );
}

import { Box, Text } from "ink";
import { type ReactNode } from "react";

import { currentTheme } from "../../../../theme";
import type { InkSingleLineInputView } from "../../sessions/input-single-line";

export interface InkSingleLineInputDialogProps {
  readonly dialog: InkSingleLineInputView;
}

export function InkSingleLineInputDialog({
  dialog,
}: InkSingleLineInputDialogProps): ReactNode {
  return (
    <Box flexDirection="column">
      <Text>{currentTheme.boldFg("textStrong", dialog.title)}</Text>
      <Text> </Text>
      {dialog.subtitleLines.map((line, index) => (
        <Text key={`subtitle-${index}`}>
          {currentTheme.fg("textDim", line)}
        </Text>
      ))}
      <Text> </Text>
      <Text>{dialog.inputLine}</Text>
      <Text> </Text>
      <Text>{currentTheme.fg("textDim", dialog.footer)}</Text>
    </Box>
  );
}

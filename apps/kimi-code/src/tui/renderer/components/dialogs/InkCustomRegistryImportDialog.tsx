import { Box, Text } from "ink";
import { type ReactNode } from "react";

import { currentTheme } from "../../../theme";
import type { InkCustomRegistryImportView } from "../../ink-custom-registry-import";

export interface InkCustomRegistryImportDialogProps {
  readonly dialog: InkCustomRegistryImportView;
}

export function InkCustomRegistryImportDialog({
  dialog,
}: InkCustomRegistryImportDialogProps): ReactNode {
  return (
    <Box flexDirection="column">
      <Text>{currentTheme.boldFg("textStrong", dialog.title)}</Text>
      <Text> </Text>
      <Text>{currentTheme.fg("textDim", dialog.subtitle)}</Text>
      <Text> </Text>
      <Text>
        {dialog.activeField === "url"
          ? currentTheme.boldFg("accent", dialog.urlLabel)
          : currentTheme.fg("textDim", dialog.urlLabel)}
      </Text>
      <Text>{dialog.urlInputLine}</Text>
      <Text> </Text>
      <Text>
        {dialog.activeField === "token"
          ? currentTheme.boldFg("accent", dialog.tokenLabel)
          : currentTheme.fg("textDim", dialog.tokenLabel)}
      </Text>
      <Text>{dialog.tokenInputLine}</Text>
      <Text> </Text>
      <Text>{currentTheme.fg("textDim", dialog.footer)}</Text>
    </Box>
  );
}

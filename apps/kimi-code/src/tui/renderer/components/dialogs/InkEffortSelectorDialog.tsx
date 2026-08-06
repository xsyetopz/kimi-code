import { Box, Text } from "ink";
import { type ReactNode } from "react";

import { currentTheme } from "../../../theme";
import type { InkEffortSelectorView } from "../../ink-effort-selector";

export interface InkEffortSelectorDialogProps {
  readonly selector: InkEffortSelectorView;
}

export function InkEffortSelectorDialog({
  selector,
}: InkEffortSelectorDialogProps): ReactNode {
  return (
    <Box flexDirection="column">
      <Text>{currentTheme.boldFg("primary", selector.title)}</Text>
      <Text>{currentTheme.fg("textMuted", selector.hint)}</Text>
      {selector.warning === undefined ? null : (
        <Text>{currentTheme.fg("warning", selector.warning)}</Text>
      )}
      <Text>
        {selector.segments.map((segment) =>
          segment.active
            ? currentTheme.boldFg("primary", `[ ${segment.label} ]`)
            : currentTheme.fg("text", `  ${segment.label}  `),
        ).join("  ")}
      </Text>
    </Box>
  );
}

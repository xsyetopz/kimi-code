import { Box, Text } from "ink";
import { type ReactNode } from "react";

import type { PendingApproval } from "../../../reverse-rpc/types";
import { currentTheme } from "../../../theme";

import { ChoiceList } from "./ChoiceList";
import { summarizeDisplayBlock } from "./dialog-display";

export interface InkApprovalDialogProps {
  readonly request: PendingApproval;
  readonly selectedIndex: number;
}

export function InkApprovalDialog({
  request,
  selectedIndex,
}: InkApprovalDialogProps): ReactNode {
  const { data } = request;
  const displayLines = data.display
    .map(summarizeDisplayBlock)
    .filter((line): line is string => line !== undefined)
    .slice(0, 4);

  return (
    <Box flexDirection="column">
      <Text>{currentTheme.boldFg("primary", `Tool: ${data.tool_name}`)}</Text>
      <Text>{currentTheme.fg("textStrong", data.action)}</Text>
      <Text>{currentTheme.fg("textDim", data.description)}</Text>
      {displayLines.map((line) => (
        <Text key={line}>{currentTheme.fg("textMuted", `  ${line}`)}</Text>
      ))}
      <Text> </Text>
      <ChoiceList
        choices={data.choices}
        selectedIndex={selectedIndex}
      />
      <Text>{currentTheme.fg("textMuted", "↑↓ choose · Enter select · Esc reject")}</Text>
    </Box>
  );
}

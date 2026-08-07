import { Box, Text } from "ink";
import { type ReactNode } from "react";

import { CURRENT_MARK, SELECT_POINTER } from "../../../../constant/symbols";
import { currentTheme } from "../../../../theme";
import type { InkProviderManagerView } from "../../sessions/provider-manager";

export interface InkProviderManagerDialogProps {
  readonly manager: InkProviderManagerView;
}

export function InkProviderManagerDialog({
  manager,
}: InkProviderManagerDialogProps): ReactNode {
  return (
    <Box flexDirection="column">
      <Text>{currentTheme.boldFg("primary", manager.title)}</Text>
      <Text>{currentTheme.fg("textMuted", manager.hint)}</Text>
      {manager.empty ? (
        <Text>
          {currentTheme.fg("textMuted", "  No providers configured.")}
        </Text>
      ) : (
        manager.rows.map((row) => (
          <ProviderManagerRow key={`${row.kind}:${row.label}`} row={row} />
        ))
      )}
      {manager.confirmPrompt === undefined ? null : (
        <Text>
          {currentTheme.boldFg("warning", `  ${manager.confirmPrompt}`)}
        </Text>
      )}
      {manager.pageLabel === undefined ? null : (
        <Text>{currentTheme.fg("textMuted", manager.pageLabel)}</Text>
      )}
    </Box>
  );
}

function ProviderManagerRow({
  row,
}: {
  readonly row: InkProviderManagerView["rows"][number];
}): ReactNode {
  const pointer = row.selected ? SELECT_POINTER : " ";
  const label =
    row.selected && row.kind === "add"
      ? currentTheme.boldFg("primary", row.label)
      : row.selected
        ? currentTheme.boldFg("primary", row.label)
        : row.kind === "add"
          ? currentTheme.fg("primary", row.label)
          : currentTheme.fg("text", row.label);
  const marker = row.hasActive
    ? currentTheme.fg("success", ` ${CURRENT_MARK}`)
    : "";

  return (
    <Box flexDirection="column">
      <Text>
        {currentTheme.fg(row.selected ? "primary" : "textDim", `  ${pointer} `)}
        {label}
        {marker}
      </Text>
      {row.baseUrl === undefined || row.baseUrl.length === 0 ? null : (
        <Text>{currentTheme.fg("textMuted", `      ${row.baseUrl}`)}</Text>
      )}
    </Box>
  );
}

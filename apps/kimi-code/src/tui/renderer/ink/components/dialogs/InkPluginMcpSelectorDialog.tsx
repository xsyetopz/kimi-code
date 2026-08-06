import { Box, Text } from "ink";
import { type ReactNode } from "react";

import { SELECT_POINTER } from "../../../../constant/symbols";
import { currentTheme } from "../../../../theme";
import type { InkPluginMcpSelectorView } from "../../sessions/plugin-mcp-selector";

export interface InkPluginMcpSelectorDialogProps {
  readonly selector: InkPluginMcpSelectorView;
}

export function InkPluginMcpSelectorDialog({
  selector,
}: InkPluginMcpSelectorDialogProps): ReactNode {
  const serverRows = selector.rows.filter((row) => row.kind === "plugin");
  const actionRows = selector.rows.filter((row) => row.kind === "action");

  return (
    <Box flexDirection="column">
      <Text>{currentTheme.boldFg("primary", selector.title)}</Text>
      <Text>{currentTheme.fg("textMuted", selector.hint)}</Text>
      <Text>{currentTheme.fg("textDim", selector.serverHeader)}</Text>
      {serverRows.length === 0 ? (
        <Text>{currentTheme.fg("textMuted", "No MCP servers declared.")}</Text>
      ) : (
        serverRows.map((row) => (
          <PluginMcpRow key={row.value} row={row} />
        ))
      )}
      <Text>{currentTheme.fg("textDim", selector.actionHeader)}</Text>
      {actionRows.map((row) => (
        <PluginMcpRow key={row.value} row={row} />
      ))}
    </Box>
  );
}

function PluginMcpRow({
  row,
}: {
  readonly row: InkPluginMcpSelectorView["rows"][number];
}): ReactNode {
  const pointer = row.selected ? SELECT_POINTER : " ";
  const label = row.selected
    ? currentTheme.boldFg("primary", row.label)
    : row.kind === "action"
      ? currentTheme.fg("textDim", row.label)
      : currentTheme.fg("text", row.label);
  const status =
    row.status === undefined
      ? null
      : row.status === "enabled"
        ? currentTheme.fg("success", row.status)
        : row.status === "disabled"
          ? currentTheme.fg("textDim", row.status)
          : currentTheme.fg("warning", row.status);

  return (
    <Box flexDirection="column">
      <Text>
        {currentTheme.fg(row.selected ? "primary" : "textDim", `  ${pointer} `)}
        {label}
        {status === null ? null : `  ${status}`}
        {row.hint === undefined
          ? null
          : `  ${currentTheme.fg("warning", row.hint)}`}
      </Text>
      <Text>{currentTheme.fg("textMuted", `    ${row.description}`)}</Text>
    </Box>
  );
}

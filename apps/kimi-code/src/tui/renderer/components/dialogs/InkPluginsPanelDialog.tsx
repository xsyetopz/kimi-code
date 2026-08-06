import { Box, Text } from "ink";
import { type ReactNode } from "react";

import { SELECT_POINTER } from "../../../constant/symbols";
import { currentTheme } from "../../../theme";
import type {
  InkPluginsPanelRowStatusTone,
  InkPluginsPanelView,
} from "../../ink-plugins-panel";

export interface InkPluginsPanelDialogProps {
  readonly panel: InkPluginsPanelView;
}

export function InkPluginsPanelDialog({
  panel,
}: InkPluginsPanelDialogProps): ReactNode {
  if (panel.mode === "installing") {
    return (
      <Box flexDirection="column">
        <Text>{currentTheme.boldFg("primary", panel.title)}</Text>
        <Text>
          {currentTheme.fg(
            "textMuted",
            `  Installing ${panel.installingLabel ?? ""} from marketplace…`,
          )}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text>{currentTheme.boldFg("primary", panel.title)}</Text>
      <Text>{currentTheme.fg("textMuted", panel.hint)}</Text>
      {panel.tabs.length > 0 ? (
        <Text>
          {panel.tabs
            .map((tab, index) => {
              const prefix = index === 0 ? " " : " ";
              if (tab.active) {
                return `${prefix}${currentTheme.bg("primary", currentTheme.boldFg("text", ` ${tab.label} `))}`;
              }
              return `${prefix}${currentTheme.fg("textMuted", tab.label)}`;
            })
            .join(" ")}
        </Text>
      ) : null}
      {panel.mode === "custom" ? (
        <>
          {panel.customPrompt === undefined ? null : (
            <Text>{currentTheme.fg("textMuted", panel.customPrompt)}</Text>
          )}
          <Text>
            {currentTheme.fg("primary", "╭")}
            {currentTheme.fg("primary", "─".repeat(20))}
            {currentTheme.fg("primary", "╮")}
          </Text>
          <Text>
            {currentTheme.fg("primary", "│")}  {panel.customInput ?? ""}
            {currentTheme.fg("primary", "│")}
          </Text>
          <Text>
            {currentTheme.fg("primary", "╰")}
            {currentTheme.fg("primary", "─".repeat(20))}
            {currentTheme.fg("primary", "╯")}
          </Text>
        </>
      ) : (
        panel.rows.map((row, index) => (
          <PluginsPanelRow key={`${row.label}:${String(index)}`} row={row} />
        ))
      )}
      {panel.footerLines.map((line) => (
        <Text key={line}>{currentTheme.fg("textMuted", line)}</Text>
      ))}
    </Box>
  );
}

function PluginsPanelRow({
  row,
}: {
  readonly row: InkPluginsPanelView["rows"][number];
}): ReactNode {
  const pointer = row.selected ? SELECT_POINTER : " ";
  const label = row.selected
    ? currentTheme.boldFg("primary", row.label)
    : currentTheme.fg("text", row.label);
  const status =
    row.status === undefined ? null : statusText(row.status, row.statusTone);

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
      {row.descriptionLines.map((line) => (
        <Text key={line}>{currentTheme.fg("textMuted", `    ${line}`)}</Text>
      ))}
    </Box>
  );
}

function statusText(
  status: string,
  tone: InkPluginsPanelRowStatusTone,
): string {
  switch (tone) {
    case "primary":
      return currentTheme.fg("primary", status);
    case "success":
      return currentTheme.fg("success", status);
    case "warning":
      return currentTheme.fg("warning", status);
    case "dim":
      return currentTheme.fg("textDim", status);
  }
}

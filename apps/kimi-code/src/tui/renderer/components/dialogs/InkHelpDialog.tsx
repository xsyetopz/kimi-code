import { truncateToWidth } from "@moonshot-ai/kimi-tui";
import { Box, Text } from "ink";
import { type ReactNode } from "react";

import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  formatHelpPanelCommandLabel,
  sortHelpPanelCommands,
} from "../../../components/dialogs/help-panel-data";
import { currentTheme } from "../../../theme";
import type { TerminalDialogView } from "../../terminal-view-state";

export interface InkHelpDialogProps {
  readonly dialog: TerminalDialogView;
  readonly width?: number;
  readonly maxVisible?: number;
}

function helpLines(
  dialog: TerminalDialogView,
  width = 80,
  maxVisible = 24,
): readonly string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const accent = (text: string): string => currentTheme.fg("primary", text);
  const dim = (text: string): string => currentTheme.fg("textDim", text);
  const muted = (text: string): string => currentTheme.fg("textMuted", text);
  const kbdColor = (text: string): string => currentTheme.fg("warning", text);
  const slashColor = (text: string): string => currentTheme.fg("primary", text);
  const shortcuts = DEFAULT_KEYBOARD_SHORTCUTS;
  const kbdWidth = Math.max(
    8,
    ...shortcuts.map((shortcut) => shortcut.keys.length),
  );
  const commands = sortHelpPanelCommands(dialog.helpCommands);
  const commandLabels = commands.map(formatHelpPanelCommandLabel);
  const commandWidth = Math.max(
    12,
    ...commandLabels.map((label) => label.length),
  );
  const lines: string[] = [
    accent("─".repeat(safeWidth)),
    currentTheme.boldFg("primary", " help ") +
      muted("· Esc / Enter / q to cancel · ↑↓ scroll · PgUp/PgDn page"),
    "",
    `  ${dim("Sure, Kimi is ready to help! Just send a message to get started.")}`,
    "",
    `  ${currentTheme.bold("Keyboard shortcuts")}`,
    ...shortcuts.map(
      (shortcut) =>
        `    ${kbdColor(shortcut.keys.padEnd(kbdWidth))} — ${dim(shortcut.description)}`,
    ),
    "",
    `  ${currentTheme.bold("Slash commands")}`,
    ...commands.map((command, index) => {
      const label = commandLabels[index] ?? `/${command.name}`;
      return `    ${slashColor(label.padEnd(commandWidth))} — ${dim(command.description)}`;
    }),
    "",
    accent("─".repeat(safeWidth)),
  ];

  const content = lines.slice(1, lines.length - 1);
  const visible = Math.max(5, Math.floor(maxVisible));
  if (content.length > visible) {
    const scrollTop = Math.max(
      0,
      Math.min(dialog.scrollTop, content.length - visible),
    );
    const slice = content.slice(scrollTop, scrollTop + visible);
    const scrollInfo = muted(
      ` showing ${String(scrollTop + 1)}-${String(scrollTop + slice.length)} of ${String(content.length)}`,
    );
    return [lines[0] ?? "", ...slice, scrollInfo, lines.at(-1) ?? ""].map(
      (line) => truncateToWidth(line, safeWidth),
    );
  }
  return lines.map((line) => truncateToWidth(line, safeWidth));
}

/**
 * React-owned `/help` dialog. The parent coordinator supplies only the
 * renderer-neutral snapshot; no kimi-tui component is mounted in this path.
 */
export function InkHelpDialog({
  dialog,
  width = 80,
  maxVisible = 24,
}: InkHelpDialogProps): ReactNode {
  const lines = helpLines(dialog, width, maxVisible);
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={`help-${index}`}>{line}</Text>
      ))}
    </Box>
  );
}

/** Exposed for tests that assert help scroll clipping without mounting Ink. */
export function projectInkHelpLines(
  dialog: TerminalDialogView,
  width = 80,
  maxVisible = 24,
): readonly string[] {
  return helpLines(dialog, width, maxVisible);
}

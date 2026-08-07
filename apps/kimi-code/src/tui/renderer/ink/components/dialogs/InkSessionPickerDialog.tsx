import { Box, Text } from "ink";
import { type ReactNode } from "react";

import { CURRENT_MARK, SELECT_POINTER } from "../../../../constant/symbols";
import type { TerminalDialogView } from "../../../terminal-view-state";
import { currentTheme } from "../../../../theme";

export interface InkSessionPickerDialogProps {
  readonly dialog: TerminalDialogView;
  readonly currentSessionId: string;
}

export function InkSessionPickerDialog({
  dialog,
  currentSessionId,
}: InkSessionPickerDialogProps): ReactNode {
  const title = dialog.sessionsScope === "all" ? "All sessions" : "Sessions";

  if (dialog.loadingSessions) {
    return (
      <Box flexDirection="column">
        <Text>{currentTheme.boldFg("primary", title)}</Text>
        <Text>{currentTheme.fg("textMuted", "Loading sessions…")}</Text>
      </Box>
    );
  }

  if (dialog.sessions.length === 0) {
    return (
      <Box flexDirection="column">
        <Text>{currentTheme.boldFg("primary", title)}</Text>
        <Text>{currentTheme.fg("textMuted", "No sessions found.")}</Text>
        <Text>{currentTheme.fg("textMuted", "Esc cancel")}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text>{currentTheme.boldFg("primary", title)}</Text>
      <Text>
        {currentTheme.fg(
          "textMuted",
          "↑↓ navigate · Enter select · Ctrl+A change scope · Esc cancel",
        )}
      </Text>
      {dialog.sessions.slice(0, 8).map((session, index) => {
        const label = session.title ?? session.lastPrompt ?? session.id;
        const current =
          session.id === currentSessionId ? ` ${CURRENT_MARK}` : "";
        const pointer = index === dialog.selectedIndex ? SELECT_POINTER : " ";
        return (
          <Text key={session.id}>
            {`  ${pointer} ${label}${current} · ${session.workDir}`}
          </Text>
        );
      })}
    </Box>
  );
}

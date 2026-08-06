import { Box, Text } from "ink";
import { type ReactNode } from "react";

import { SELECT_POINTER } from "../../../../constant/symbols";
import { currentTheme } from "../../../../theme";
import type { InkStartPermissionPromptView } from "../../sessions/start-permission-prompt";

export interface InkStartPermissionPromptDialogProps {
  readonly prompt: InkStartPermissionPromptView;
}

export function InkStartPermissionPromptDialog({
  prompt,
}: InkStartPermissionPromptDialogProps): ReactNode {
  return (
    <Box flexDirection="column">
      <Text>{currentTheme.boldFg("primary", prompt.title)}</Text>
      <Text>{currentTheme.fg("textMuted", prompt.hint)}</Text>
      {prompt.notices.map((notice, noticeIndex) => (
        <Box key={`notice-${noticeIndex}`} flexDirection="column">
          {notice.lines.map((line, lineIndex) => (
            <Text key={`notice-${noticeIndex}-${lineIndex}`}>
              {styleModeNames(line, "textMuted")}
            </Text>
          ))}
        </Box>
      ))}
      {prompt.options.map((option) => (
        <Box key={option.value} flexDirection="column">
          <Text>
            {currentTheme.fg(
              option.selected ? "primary" : "textDim",
              `  ${option.selected ? SELECT_POINTER : " "} `,
            )}
            {styleLabel(option.label, option.selected)}
          </Text>
          {option.descriptionLines.map((line, lineIndex) => (
            <Text key={`${option.value}-${lineIndex}`}>
              {`    ${styleModeNames(line, "textMuted")}`}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  );
}

function styleLabel(label: string, selected: boolean): string {
  if (selected) return currentTheme.boldFg("primary", label);
  return styleModeNames(label, "text");
}

function styleModeNames(text: string, baseToken: "text" | "textMuted"): string {
  return text
    .split(/(\b(?:Manual|Auto|YOLO)\b)/g)
    .map((part) => {
      if (part === "Manual" || part === "Auto" || part === "YOLO") {
        return currentTheme.boldFg("textStrong", part);
      }
      return currentTheme.fg(baseToken, part);
    })
    .join("");
}

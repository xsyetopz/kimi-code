import { Box, Text } from "ink";
import { type ReactNode } from "react";

import { ChoiceList } from "./ChoiceList";
import type { TerminalTrustPromptView } from "../../../terminal-view-state";
import { currentTheme } from "../../../../theme";

const TRUST_OPTIONS = [
  {
    label: "Trust this folder — enable project MCP servers",
    description: undefined,
  },
  {
    label: "Don't trust — exit Kimi Code",
    description: undefined,
  },
] as const;

export interface InkTrustDialogProps {
  readonly trustPrompt: TerminalTrustPromptView;
  readonly selectedIndex: number;
}

export function InkTrustDialog({
  trustPrompt,
  selectedIndex,
}: InkTrustDialogProps): ReactNode {
  const gated =
    trustPrompt.gatedMcpServers.length === 0
      ? "none"
      : trustPrompt.gatedMcpServers.join(", ");

  return (
    <Box flexDirection="column">
      <Text>{currentTheme.boldFg("primary", "Trust this folder?")}</Text>
      <Text>{currentTheme.fg("textStrong", trustPrompt.workDir)}</Text>
      <Text>
        {currentTheme.fg(
          "textDim",
          "Project MCP servers are enabled only in trusted folders.",
        )}
      </Text>
      <Text>{`Gated servers: ${gated}`}</Text>
      <ChoiceList
        choices={TRUST_OPTIONS}
        selectedIndex={selectedIndex}
        numbered={false}
      />
      <Text>{currentTheme.fg("textMuted", "↑↓ navigate · Enter select · Esc exit")}</Text>
    </Box>
  );
}

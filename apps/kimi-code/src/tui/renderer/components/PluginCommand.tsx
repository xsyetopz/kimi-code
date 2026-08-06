import { Box, Text } from "ink";
import { type ReactNode } from "react";

import type { TranscriptEntry } from "../../types";
import { currentTheme } from "../../theme";

export interface PluginCommandProps {
  readonly entry: TranscriptEntry;
}

/**
 * Renders a plugin command invocation: "▶ Invoked command: /pluginId:commandName" + dim args.
 */
export function PluginCommand({ entry }: PluginCommandProps): ReactNode {
  const data = entry.pluginCommandData;
  if (!data) return null;

  return (
    <Box flexDirection="column">
      <Text>
        {currentTheme.fg("accent", "▶")} Invoked command:{" "}
        {currentTheme.fg("text", `/${data.pluginId}:${data.commandName}`)}
      </Text>
      {data.args ? (
        <Text color={currentTheme.color("textMuted")}>
          {"  "}
          {data.args}
        </Text>
      ) : null}
    </Box>
  );
}

import { Box, Text } from "ink";
import { type ReactNode } from "react";

import type { TranscriptEntry } from "../../../types";
import { currentTheme } from "../../../theme";

export interface SkillActivationProps {
  readonly entry: TranscriptEntry;
}

/**
 * Renders a skill activation notice: "▶ Activated skill: name" + dim args preview.
 */
export function SkillActivation({ entry }: SkillActivationProps): ReactNode {
  const name = entry.skillName ?? "unknown";
  const args = entry.skillArgs;

  return (
    <Box flexDirection="column">
      <Text>
        {currentTheme.fg("accent", "▶")} Activated skill:{" "}
        {currentTheme.fg("text", name)}
      </Text>
      {args ? (
        <Text color={currentTheme.color("textMuted")}>
          {"  "}
          {args.length > 200 ? `${args.slice(0, 200)}…` : args}
        </Text>
      ) : null}
    </Box>
  );
}

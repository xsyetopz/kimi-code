import { Box, Text } from "ink";
import { type ReactNode } from "react";

import { projectToolCallBodyLines } from "../../../projections/tool-call/body";
import { projectToolCallHeader } from "../../../projections/tool-call/header";
import {
  hasSubagentCardView,
  projectSingleSubagentBodyLines,
  projectSingleSubagentHeader,
} from "../../../projections/tool-call/subagent";
import type { TranscriptEntry } from "../../../types";

export interface ToolCallProps {
  readonly entry: TranscriptEntry;
  readonly workspaceDir?: string;
}

/**
 * Ink tool-call card — header and body lines come from the shared projection
 * layer so production Ink matches pi-tui wording and chips.
 */
export function ToolCall({ entry, workspaceDir }: ToolCallProps): ReactNode {
  const data = entry.toolCallData;
  if (!data) return null;

  if (hasSubagentCardView(data)) {
    const header = projectSingleSubagentHeader({
      toolCall: data,
      result: data.result,
      card: data.subagentCard,
    });
    const bodyLines = projectSingleSubagentBodyLines({
      card: data.subagentCard,
      result: data.result,
      workspaceDir,
    });
    return (
      <Box flexDirection="column">
        <Text>{header}</Text>
        {bodyLines.map((line, index) => (
          <Text key={`subagent-body-${index}`}>{line}</Text>
        ))}
      </Box>
    );
  }

  const header = projectToolCallHeader({
    toolCall: data,
    result: data.result,
    workspaceDir,
  });
  const bodyLines = projectToolCallBodyLines({
    toolCall: data,
    result: data.result,
    skipResultBody:
      data.name === "Agent" &&
      (data.subagent !== undefined || data.subagentCard !== undefined),
  });

  return (
    <Box flexDirection="column">
      <Text>{header}</Text>
      {bodyLines.map((line, index) => (
        <Text key={`body-${index}`}>{line}</Text>
      ))}
    </Box>
  );
}

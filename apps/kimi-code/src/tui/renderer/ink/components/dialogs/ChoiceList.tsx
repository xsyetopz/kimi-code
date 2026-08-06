import { Box, Text } from "ink";
import { type ReactNode } from "react";

import { SELECT_POINTER } from "../../../../constant/symbols";

export interface InkChoiceOption {
  readonly label: string;
  readonly description?: string | undefined;
}

export interface ChoiceListProps {
  readonly choices: readonly InkChoiceOption[];
  readonly selectedIndex: number;
  readonly numbered?: boolean;
}

/** Shared list-row renderer for Ink-owned selector dialogs. */
export function ChoiceList({
  choices,
  selectedIndex,
  numbered = true,
}: ChoiceListProps): ReactNode {
  return (
    <Box flexDirection="column">
      {choices.map((choice, index) => {
        const pointer =
          index === selectedIndex
            ? SELECT_POINTER
            : numbered
              ? String(index + 1)
              : " ";
        const suffix =
          choice.description === undefined ? "" : ` — ${choice.description}`;
        return (
          <Text key={`${index}-${choice.label}`}>
            {`  ${pointer} ${choice.label}${suffix}`}
          </Text>
        );
      })}
    </Box>
  );
}

import { Box, Text } from "ink";
import { type ReactNode } from "react";

import type { PendingQuestion } from "../../../reverse-rpc/types";
import { currentTheme } from "../../../theme";

import { ChoiceList } from "./ChoiceList";

export interface InkQuestionDialogProps {
  readonly request: PendingQuestion;
  readonly selectedIndex: number;
}

export function InkQuestionDialog({
  request,
  selectedIndex,
}: InkQuestionDialogProps): ReactNode {
  const question = request.data.questions[0];
  if (question === undefined) {
    return (
      <Box flexDirection="column">
        <Text>{currentTheme.fg("error", "Question required")}</Text>
        <Text>{currentTheme.fg("textMuted", "Esc cancel")}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text>{currentTheme.boldFg("primary", question.header ?? "Question")}</Text>
      <Text>{question.question}</Text>
      {question.body === undefined ? null : (
        <Text>{currentTheme.fg("textDim", question.body)}</Text>
      )}
      <ChoiceList
        choices={question.options}
        selectedIndex={selectedIndex}
      />
      <Text>
        {currentTheme.fg(
          "textMuted",
          question.multi_select
            ? "Space select · Enter next"
            : "↑↓ choose · Enter next",
        )}
      </Text>
      <Text>{currentTheme.fg("textMuted", "Esc cancel")}</Text>
    </Box>
  );
}

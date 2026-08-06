import { Box, Text } from "ink";
import { type ReactNode } from "react";

import { buildQuestionDisplayOptions } from "#/tui/components/dialogs/question-dialog-options";
import type { PendingQuestion } from "../../../reverse-rpc/types";
import { currentTheme } from "../../../theme";

import { ChoiceList } from "./ChoiceList";

export interface InkQuestionDialogProps {
  readonly request: PendingQuestion;
  readonly selectedIndex: number;
  readonly otherMode: boolean;
  readonly otherText: string;
  readonly multiSelections: ReadonlySet<number>;
}

export function InkQuestionDialog({
  request,
  selectedIndex,
  otherMode,
  otherText,
  multiSelections,
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

  const choices = buildQuestionDisplayOptions(question);

  return (
    <Box flexDirection="column">
      <Text>{currentTheme.boldFg("primary", question.header ?? "Question")}</Text>
      <Text>{question.question}</Text>
      {question.body === undefined ? null : (
        <Text>{currentTheme.fg("textDim", question.body)}</Text>
      )}
      {otherMode ? (
        <Text>
          {currentTheme.fg("primary", "Other: ")}
          {otherText}
          {currentTheme.fg("primary", "█")}
        </Text>
      ) : (
        <ChoiceList
          choices={choices.map((choice, index) => ({
            label:
              question.multi_select && multiSelections.has(index)
                ? `${choice.label} ✓`
                : choice.label,
            description: choice.description,
          }))}
          selectedIndex={selectedIndex}
        />
      )}
      <Text>
        {currentTheme.fg(
          "textMuted",
          otherMode
            ? "Enter save · Esc back"
            : question.multi_select
              ? "Space select · Enter next"
              : "↑↓ choose · Enter next",
        )}
      </Text>
      <Text>{currentTheme.fg("textMuted", "Esc cancel")}</Text>
    </Box>
  );
}

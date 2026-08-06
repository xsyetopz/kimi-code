import { Box, Text } from "ink";
import { type ReactNode } from "react";

import { buildQuestionDisplayOptions } from "#/tui/components/dialogs/question-dialog-options";
import type { PendingQuestion } from "../../../../reverse-rpc/types";
import { currentTheme } from "../../../../theme";
import {
  hasUnansweredInkQuestionAnswers,
  INK_QUESTION_NOT_ANSWERED_LABEL,
  INK_QUESTION_REVIEW_TITLE,
  INK_QUESTION_SUBMIT_PROMPT,
  INK_QUESTION_UNANSWERED_WARNING,
  type InkQuestionWizardView,
} from "../../question-wizard";

import { ChoiceList } from "./ChoiceList";

const SUBMIT_ACTIONS = ["Submit", "Cancel"] as const;

export interface InkQuestionDialogProps {
  readonly request: PendingQuestion;
  readonly wizard: InkQuestionWizardView;
}

function isSubmitTab(request: PendingQuestion, wizard: InkQuestionWizardView): boolean {
  return wizard.tab === request.data.questions.length;
}

function renderTabs(
  request: PendingQuestion,
  wizard: InkQuestionWizardView,
): ReactNode {
  const questionCount = request.data.questions.length;
  const parts: ReactNode[] = [];
  for (let i = 0; i < questionCount; i++) {
    const question = request.data.questions[i];
    if (question === undefined) continue;
    const label =
      question.header !== undefined && question.header.length > 0
        ? question.header
        : `Q${String(i + 1)}`;
    const answered =
      wizard.answers[i] !== undefined && (wizard.answers[i]?.length ?? 0) > 0;
    if (parts.length > 0) parts.push("  ");
    if (i === wizard.tab) {
      parts.push(
        <Text key={`tab-${String(i)}`}>
          {currentTheme.bg("primary", currentTheme.boldFg("text", ` ${label} `))}
        </Text>,
      );
    } else if (answered) {
      parts.push(
        <Text key={`tab-${String(i)}`}>
          {currentTheme.fg("success", `(✓) ${label}`)}
        </Text>,
      );
    } else {
      parts.push(
        <Text key={`tab-${String(i)}`}>
          {currentTheme.fg("textDim", `(○) ${label}`)}
        </Text>,
      );
    }
  }
  if (parts.length > 0) parts.push("  ");
  const submitLabel = "Submit";
  if (isSubmitTab(request, wizard)) {
    parts.push(
      <Text key="tab-submit">
        {currentTheme.bg("primary", currentTheme.boldFg("text", ` ${submitLabel} `))}
      </Text>,
    );
  } else {
    parts.push(
      <Text key="tab-submit">{currentTheme.fg("textDim", ` ${submitLabel} `)}</Text>,
    );
  }
  return <Text>{parts}</Text>;
}

function renderQuestionTab(
  request: PendingQuestion,
  wizard: InkQuestionWizardView,
): ReactNode {
  const question = request.data.questions[wizard.tab];
  if (question === undefined) return null;

  const choices = buildQuestionDisplayOptions(question);
  const multiSet = new Set(wizard.multiSelections[wizard.tab] ?? []);
  const singleSelection = wizard.singleSelections[wizard.tab];
  const multiTab = request.data.questions.length > 1;

  return (
    <Box flexDirection="column">
      {renderTabs(request, wizard)}
      <Text>{currentTheme.boldFg("primary", question.header ?? "Question")}</Text>
      <Text>{question.question}</Text>
      {question.body === undefined ? null : (
        <Text>{currentTheme.fg("textDim", question.body)}</Text>
      )}
      {wizard.otherMode ? (
        <Text>
          {currentTheme.fg("primary", "Other: ")}
          {wizard.otherText}
          {currentTheme.fg("primary", "█")}
        </Text>
      ) : (
        <ChoiceList
          choices={choices.map((choice, index) => {
            const isSelected = question.multi_select
              ? multiSet.has(index)
              : singleSelection === index;
            const prefix =
              question.multi_select && isSelected ? `${choice.label} ✓` : choice.label;
            return {
              label: prefix,
              description: choice.description,
            };
          })}
          selectedIndex={wizard.selectedIndex}
        />
      )}
      <Text>
        {currentTheme.fg(
          "textMuted",
          wizard.otherMode
            ? multiTab
              ? "Enter save · Tab switch · Esc back"
              : "Enter save · Esc back"
            : question.multi_select
              ? multiTab
                ? "Space toggle · Enter choose · ←/→/Tab switch"
                : "Space toggle · Enter choose"
              : multiTab
                ? "↑↓ choose · Enter next · ←/→/Tab switch"
                : "↑↓ choose · Enter next",
        )}
      </Text>
      <Text>{currentTheme.fg("textMuted", "Esc cancel")}</Text>
    </Box>
  );
}

function renderSubmitTab(
  request: PendingQuestion,
  wizard: InkQuestionWizardView,
): ReactNode {
  const reviewWarning =
    wizard.reviewMessage ??
    (hasUnansweredInkQuestionAnswers(wizard)
      ? INK_QUESTION_UNANSWERED_WARNING
      : undefined);

  return (
    <Box flexDirection="column">
      {renderTabs(request, wizard)}
      <Text>{currentTheme.boldFg("text", INK_QUESTION_REVIEW_TITLE)}</Text>
      {reviewWarning === undefined ? null : (
        <Text>{currentTheme.fg("warning", reviewWarning)}</Text>
      )}
      {request.data.questions.map((question, index) => {
        const answer = wizard.answers[index];
        return (
          <Box key={`review-${String(index)}`} flexDirection="column">
            <Text>{currentTheme.fg("textDim", `Q  ${question.question}`)}</Text>
            {answer !== undefined && answer.length > 0 ? (
              <Text>{currentTheme.fg("text", `→  ${answer}`)}</Text>
            ) : (
              <Text>
                {currentTheme.fg("textDim", `→  ${INK_QUESTION_NOT_ANSWERED_LABEL}`)}
              </Text>
            )}
          </Box>
        );
      })}
      <Text>{currentTheme.fg("text", INK_QUESTION_SUBMIT_PROMPT)}</Text>
      <ChoiceList
        choices={SUBMIT_ACTIONS.map((label) => ({ label }))}
        selectedIndex={wizard.submitActionIndex}
      />
      <Text>
        {currentTheme.fg(
          "textMuted",
          "↑↓ select · 1/2 choose · Enter confirm · ←/→/Tab switch · Esc cancel",
        )}
      </Text>
    </Box>
  );
}

export function InkQuestionDialog({
  request,
  wizard,
}: InkQuestionDialogProps): ReactNode {
  if (request.data.questions.length === 0) {
    return (
      <Box flexDirection="column">
        <Text>{currentTheme.fg("error", "Question required")}</Text>
        <Text>{currentTheme.fg("textMuted", "Esc cancel")}</Text>
      </Box>
    );
  }

  if (isSubmitTab(request, wizard)) {
    return renderSubmitTab(request, wizard);
  }
  return renderQuestionTab(request, wizard);
}

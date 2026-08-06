import type { QuestionPanelItem } from "#/tui/reverse-rpc/types";

export const DEFAULT_QUESTION_OTHER_LABEL = "Other";

export interface QuestionDisplayOption {
  readonly label: string;
  readonly description?: string | undefined;
  readonly kind: "preset" | "other";
}

export function buildQuestionDisplayOptions(
  question: QuestionPanelItem,
): readonly QuestionDisplayOption[] {
  return [
    ...question.options.map((option) => ({
      label: option.label,
      description: option.description,
      kind: "preset" as const,
    })),
    {
      label:
        question.other_label !== undefined && question.other_label.length > 0
          ? question.other_label
          : DEFAULT_QUESTION_OTHER_LABEL,
      description:
        question.other_description !== undefined &&
        question.other_description.length > 0
          ? question.other_description
          : undefined,
      kind: "other" as const,
    },
  ];
}

export function questionOtherOptionIndex(question: QuestionPanelItem): number {
  return question.options.length;
}

export function isQuestionOtherOption(
  question: QuestionPanelItem,
  optionIndex: number,
): boolean {
  return optionIndex === questionOtherOptionIndex(question);
}

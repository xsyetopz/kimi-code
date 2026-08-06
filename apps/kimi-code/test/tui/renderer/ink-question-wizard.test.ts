import { describe, expect, it, vi } from "vitest";

import type { PendingQuestion } from "#/tui/reverse-rpc/types";
import {
  createInkQuestionWizardState,
  handleInkQuestionWizardInput,
  projectInkQuestionWizardView,
} from "#/tui/renderer/ink/question-wizard";

function makePending(
  questions: PendingQuestion["data"]["questions"],
): PendingQuestion {
  return {
    data: {
      id: "q_1",
      tool_call_id: "tc_1",
      questions,
    },
  };
}

describe("ink question wizard", () => {
  it("auto-advances single-select answers to the review tab before submit", () => {
    const request = makePending([
      {
        question: "Q1?",
        multi_select: false,
        options: [{ label: "A1" }, { label: "B1" }],
      },
      {
        question: "Q2?",
        multi_select: false,
        options: [{ label: "A2" }, { label: "B2" }],
      },
    ]);
    const wizard = createInkQuestionWizardState(2);
    const respond = vi.fn();

    expect(handleInkQuestionWizardInput(request, wizard, "2", respond)).toBe(true);
    expect(respond).not.toHaveBeenCalled();
    expect(wizard.tab).toBe(1);

    expect(handleInkQuestionWizardInput(request, wizard, "2", respond)).toBe(true);
    expect(wizard.tab).toBe(2);
    expect(projectInkQuestionWizardView(request, wizard).answers).toEqual([
      "B1",
      "B2",
    ]);

    expect(handleInkQuestionWizardInput(request, wizard, "1", respond)).toBe(true);
    expect(respond).toHaveBeenCalledWith({
      answers: ["B1", "B2"],
      method: "number_key",
    });
  });

  it("commits Other answers and includes them in the final payload", () => {
    const request = makePending([
      {
        question: "Pick one",
        multi_select: false,
        other_label: "Custom",
        options: [{ label: "Preset" }],
      },
    ]);
    const wizard = createInkQuestionWizardState(1);
    const respond = vi.fn();

    expect(handleInkQuestionWizardInput(request, wizard, "\u001b[B", respond)).toBe(
      true,
    );
    expect(handleInkQuestionWizardInput(request, wizard, "\r", respond)).toBe(true);
    expect(wizard.otherMode).toBe(true);
    for (const ch of "mine") {
      expect(handleInkQuestionWizardInput(request, wizard, ch, respond)).toBe(true);
    }
    expect(handleInkQuestionWizardInput(request, wizard, "\r", respond)).toBe(true);
    expect(handleInkQuestionWizardInput(request, wizard, "\r", respond)).toBe(true);
    expect(respond).toHaveBeenCalledWith({
      answers: ["mine"],
      method: "enter",
    });
  });
});

/**
 * QuestionDialog — kimi-tui version of the structured question prompt.
 *
 * Each question collects an answer locally, and a final Submit tab
 * reviews everything before the answers are emitted upstream.
 */

import {
  Container,
  Input,
  matchesKey,
  Key,
  decodeKittyPrintable,
  type Focusable,
} from "@moonshot-ai/kimi-tui";

import type {
  PendingQuestion,
  QuestionPanelResponse,
  QuestionSubmissionMethod,
} from "#/tui/reverse-rpc/types";
import type { QuestionDisplayOption } from "./question-dialog-options";
import {
  displayOptionsForQuestion,
  isOtherOption,
  otherOptionIndex,
  renderQuestionDialog,
  SUBMIT_ACTIONS,
  type QuestionDialogRenderHost,
} from "./question-dialog-render";

const NUMBER_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

export class QuestionDialogComponent
  extends Container
  implements Focusable, QuestionDialogRenderHost
{
  focused = false;

  readonly request: PendingQuestion;
  private readonly onAnswer: (response: QuestionPanelResponse) => void;
  readonly maxVisibleOptions: number;
  readonly otherInput = new Input();

  currentTab = 0;
  submitActionIdx = 0;
  editingOther = false;
  reviewMessage: string | undefined;
  private lastAnswerMethod: QuestionSubmissionMethod | undefined;

  /** Per-question cursor position. */
  readonly cursors: number[];
  /** Per-question single-select choice. */
  readonly singleSelections: (number | undefined)[];
  /** Per-question multi-select choices. */
  readonly multiSelections: Set<number>[];
  /** Per-question free-text drafts for the synthetic Other option. */
  readonly otherDrafts: string[];
  /** Per-question committed Other values. */
  readonly committedOtherValues: (string | undefined)[];
  /** Per-question derived answers used by tabs + review. */
  readonly answers: (string | undefined)[];

  private readonly onToggleToolOutput: (() => void) | undefined;

  constructor(
    request: PendingQuestion,
    onAnswer: (response: QuestionPanelResponse) => void,
    maxVisibleOptions = 6,
    onToggleToolOutput?: () => void,
  ) {
    super();
    this.request = request;
    this.onAnswer = onAnswer;
    this.maxVisibleOptions = maxVisibleOptions;
    this.onToggleToolOutput = onToggleToolOutput;
    this.otherInput.onSubmit = (value) => {
      this.commitOtherInput(value, "enter");
    };

    const total = request.data.questions.length;
    this.cursors = Array.from({ length: total }, (): number => 0);
    this.singleSelections = Array.from(
      { length: total },
      (): number | undefined => undefined,
    );
    this.multiSelections = Array.from(
      { length: total },
      () => new Set<number>(),
    );
    this.otherDrafts = Array.from({ length: total }, (): string => "");
    this.committedOtherValues = Array.from(
      { length: total },
      (): string | undefined => undefined,
    );
    this.answers = Array.from(
      { length: total },
      (): string | undefined => undefined,
    );
  }

  // ── Input ─────────────────────────────────────────────────────────

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.onAnswer({ answers: [] });
      return;
    }

    if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.ctrl("d"))) {
      this.onAnswer({ answers: [] });
      return;
    }

    if (matchesKey(data, Key.ctrl("o"))) {
      this.onToggleToolOutput?.();
      return;
    }

    if (this.isEditingOther()) {
      this.handleOtherInput(data);
      return;
    }

    if (this.isSubmitTab()) {
      this.handleSubmitInput(data);
      return;
    }

    const questionIdx = this.currentQuestionIndex();
    if (questionIdx === undefined) return;
    const question = this.request.data.questions[questionIdx];
    if (question === undefined) return;

    const optionCount = this.displayOptions(questionIdx).length;
    if (optionCount === 0) return;

    if (matchesKey(data, Key.up)) {
      this.moveQuestionCursor(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.moveQuestionCursor(1);
      return;
    }

    if (matchesKey(data, Key.left)) {
      this.gotoTab(this.currentTab - 1);
      return;
    }
    if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
      this.gotoTab(this.currentTab + 1);
      return;
    }

    if (matchesKey(data, Key.enter)) {
      this.activateQuestionOption(this.currentCursor(), "enter");
      return;
    }

    const printable = decodeKittyPrintable(data) ?? data;
    const numIdx = NUMBER_KEYS.indexOf(printable);
    if (numIdx >= 0 && numIdx < optionCount) {
      this.cursors[questionIdx] = numIdx;
      this.activateQuestionOption(numIdx, "number_key");
      return;
    }

    if (
      (printable === " " || matchesKey(data, Key.space)) &&
      question.multi_select
    ) {
      this.activateQuestionOption(this.currentCursor(), "space");
    }
  }

  private handleOtherInput(data: string): void {
    const questionIdx = this.currentQuestionIndex();
    if (questionIdx === undefined) return;

    if (matchesKey(data, Key.tab)) {
      this.syncOtherDraft(questionIdx);
      this.editingOther = false;
      this.gotoTab(this.currentTab + 1);
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.syncOtherDraft(questionIdx);
      this.editingOther = false;
      this.moveQuestionCursor(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.syncOtherDraft(questionIdx);
      this.editingOther = false;
      this.moveQuestionCursor(1);
      return;
    }

    this.otherInput.handleInput(data);
    this.syncOtherDraft(questionIdx);
    this.reviewMessage = undefined;
  }

  private handleSubmitInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.submitActionIdx =
        (this.submitActionIdx - 1 + SUBMIT_ACTIONS.length) %
        SUBMIT_ACTIONS.length;
      this.reviewMessage = undefined;
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.submitActionIdx = (this.submitActionIdx + 1) % SUBMIT_ACTIONS.length;
      this.reviewMessage = undefined;
      return;
    }

    if (matchesKey(data, Key.left)) {
      this.gotoTab(this.currentTab - 1);
      return;
    }
    if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
      this.gotoTab(this.currentTab + 1);
      return;
    }

    if (matchesKey(data, Key.enter)) {
      this.executeSubmitAction(this.submitActionIdx, "enter");
      return;
    }

    const printable = decodeKittyPrintable(data) ?? data;
    if (printable === "1") {
      this.submitActionIdx = 0;
      this.executeSubmitAction(0, "number_key");
      return;
    }
    if (printable === "2") {
      this.submitActionIdx = 1;
      this.executeSubmitAction(1, "number_key");
    }
  }

  // ── State mutation ────────────────────────────────────────────────

  private gotoTab(target: number): void {
    const total = this.totalTabs();
    if (total <= 0) return;

    const wrapped = ((target % total) + total) % total;
    if (wrapped === this.currentTab) return;

    this.currentTab = wrapped;
    this.editingOther = false;
    this.reviewMessage = undefined;
    if (this.isSubmitTab()) this.submitActionIdx = 0;
  }

  private moveQuestionCursor(delta: number): void {
    const questionIdx = this.currentQuestionIndex();
    if (questionIdx === undefined) return;

    const total = this.displayOptions(questionIdx).length;
    if (total <= 0) return;

    this.cursors[questionIdx] = (this.currentCursor() + delta + total) % total;
    this.reviewMessage = undefined;
  }

  private activateQuestionOption(
    optionIdx: number,
    method: QuestionSubmissionMethod,
  ): void {
    const questionIdx = this.currentQuestionIndex();
    if (questionIdx === undefined) return;

    const question = this.request.data.questions[questionIdx];
    if (question === undefined) return;

    this.cursors[questionIdx] = optionIdx;
    this.editingOther = false;
    this.reviewMessage = undefined;

    if (isOtherOption(this, questionIdx, optionIdx)) {
      this.enterOtherInput(questionIdx);
      return;
    }

    if (question.multi_select) {
      const set = this.multiSelections[questionIdx];
      if (set === undefined) return;
      if (set.has(optionIdx)) set.delete(optionIdx);
      else set.add(optionIdx);
      this.lastAnswerMethod = method;
      this.updateAnswer(questionIdx);
      return;
    }

    this.singleSelections[questionIdx] = optionIdx;
    this.committedOtherValues[questionIdx] = undefined;
    this.lastAnswerMethod = method;
    this.updateAnswer(questionIdx);
    this.advanceAfterSingleSelect(questionIdx);
  }

  private enterOtherInput(questionIdx: number): void {
    this.cursors[questionIdx] = otherOptionIndex(this, questionIdx);
    this.editingOther = true;
    this.otherInput.setValue(this.otherDraftValue(questionIdx));
    this.reviewMessage = undefined;
  }

  private commitOtherInput(
    rawValue: string | undefined,
    method: QuestionSubmissionMethod,
  ): void {
    const questionIdx = this.currentQuestionIndex();
    if (questionIdx === undefined) return;

    const question = this.request.data.questions[questionIdx];
    if (question === undefined) return;

    const value = (rawValue ?? this.otherInput.getValue()).trim();
    if (value.length === 0) return;

    this.otherInput.setValue(value);
    this.otherDrafts[questionIdx] = value;
    this.committedOtherValues[questionIdx] = value;

    if (question.multi_select) {
      this.multiSelections[questionIdx]?.add(
        otherOptionIndex(this, questionIdx),
      );
    } else {
      this.singleSelections[questionIdx] = otherOptionIndex(this, questionIdx);
    }

    this.lastAnswerMethod = method;
    this.updateAnswer(questionIdx);
    this.editingOther = false;
    this.reviewMessage = undefined;

    if (!question.multi_select) this.advanceAfterSingleSelect(questionIdx);
  }

  private advanceAfterSingleSelect(questionIdx: number): void {
    const next = this.findNextUnansweredAfter(questionIdx);
    this.currentTab = next ?? this.submitTabIndex();
    this.reviewMessage = undefined;
    if (this.isSubmitTab()) this.submitActionIdx = 0;
  }

  private findNextUnansweredAfter(fromIdx: number): number | null {
    const total = this.request.data.questions.length;
    for (let idx = fromIdx + 1; idx < total; idx++) {
      if (!this.isAnswered(idx)) return idx;
    }
    return null;
  }

  private updateAnswer(questionIdx: number): void {
    const question = this.request.data.questions[questionIdx];
    if (question === undefined) return;

    if (question.multi_select) {
      const labels: string[] = [];
      const set = this.multiSelections[questionIdx] ?? new Set<number>();
      const otherIdx = otherOptionIndex(this, questionIdx);
      for (let i = 0; i < question.options.length; i++) {
        if (!set.has(i)) continue;
        const label = question.options[i]?.label;
        if (label !== undefined && label.length > 0) labels.push(label);
      }
      const otherText = this.committedOtherValues[questionIdx];
      if (
        set.has(otherIdx) &&
        otherText !== undefined &&
        otherText.length > 0
      ) {
        labels.push(otherText);
      }
      this.answers[questionIdx] =
        labels.length > 0 ? labels.join(", ") : undefined;
      return;
    }

    const selection = this.singleSelections[questionIdx];
    if (selection === undefined) {
      this.answers[questionIdx] = undefined;
      return;
    }

    if (isOtherOption(this, questionIdx, selection)) {
      const otherText = this.committedOtherValues[questionIdx];
      this.answers[questionIdx] =
        otherText !== undefined && otherText.length > 0 ? otherText : undefined;
      return;
    }

    const label = question.options[selection]?.label;
    this.answers[questionIdx] =
      label !== undefined && label.length > 0 ? label : undefined;
  }

  private executeSubmitAction(
    actionIdx: number,
    method: QuestionSubmissionMethod,
  ): void {
    if (actionIdx === 1) {
      this.onAnswer({ answers: [] });
      return;
    }

    this.reviewMessage = undefined;
    this.emitAnswers(method);
  }

  private emitAnswers(method: QuestionSubmissionMethod): void {
    const out: string[] = [];
    for (let i = 0; i < this.answers.length; i++) {
      const answer = this.answers[i];
      if (answer !== undefined && answer.length > 0) out[i] = answer;
    }
    this.onAnswer({ answers: out, method: this.lastAnswerMethod ?? method });
  }

  // ── Render ────────────────────────────────────────────────────────

  override render(width: number): string[] {
    this.otherInput.focused = this.focused && this.isEditingOther();
    return renderQuestionDialog(this, width);
  }

  displayOptions(questionIdx: number): readonly QuestionDisplayOption[] {
    return displayOptionsForQuestion(this, questionIdx);
  }

  otherDraftValue(questionIdx: number): string {
    return (
      this.otherDrafts[questionIdx] ??
      this.committedOtherValues[questionIdx] ??
      ""
    );
  }

  private syncOtherDraft(questionIdx: number): void {
    this.otherDrafts[questionIdx] = this.otherInput.getValue();
  }

  isAnswered(questionIdx: number): boolean {
    const answer = this.answers[questionIdx];
    return answer !== undefined && answer.length > 0;
  }

  hasUnansweredQuestions(): boolean {
    for (let i = 0; i < this.request.data.questions.length; i++) {
      if (!this.isAnswered(i)) return true;
    }
    return false;
  }

  totalTabs(): number {
    return this.request.data.questions.length + 1;
  }

  private submitTabIndex(): number {
    return this.request.data.questions.length;
  }

  isSubmitTab(): boolean {
    return this.currentTab === this.submitTabIndex();
  }

  isEditingOther(): boolean {
    return this.editingOther && !this.isSubmitTab();
  }

  currentQuestionIndex(): number | undefined {
    return this.isSubmitTab() ? undefined : this.currentTab;
  }

  currentCursor(): number {
    const questionIdx = this.currentQuestionIndex();
    if (questionIdx === undefined) return 0;
    return this.cursors[questionIdx] ?? 0;
  }

  override invalidate(): void {
    super.invalidate();
    this.otherInput.invalidate();
  }
}

import { Key, matchesKey } from "@moonshot-ai/kimi-tui";

import {
  buildQuestionDisplayOptions,
  isQuestionOtherOption,
  questionOtherOptionIndex,
} from "#/tui/components/dialogs/question-dialog-options";
import type {
  PendingQuestion,
  QuestionPanelResponse,
  QuestionSubmissionMethod,
} from "#/tui/reverse-rpc/types";
import { isPrintableChar, printableChar } from "#/tui/utils/printable-key";

const NUMBER_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;
const SUBMIT_ACTIONS = ["Submit", "Cancel"] as const;

export const INK_QUESTION_REVIEW_TITLE = "Review your answers before submit";
export const INK_QUESTION_SUBMIT_PROMPT = "Ready to submit your answers?";
export const INK_QUESTION_UNANSWERED_WARNING =
  "Some questions are still unanswered.";
export const INK_QUESTION_NOT_ANSWERED_LABEL = "Not answered";

/** Ink-owned multi-question wizard state. Null when no question dialog is open. */
export interface InkQuestionWizardState {
  tab: number;
  submitActionIndex: number;
  otherMode: boolean;
  otherText: string;
  reviewMessage: string | undefined;
  cursors: number[];
  singleSelections: (number | undefined)[];
  multiSelections: Set<number>[];
  otherDrafts: string[];
  committedOther: (string | undefined)[];
  lastAnswerMethod: QuestionSubmissionMethod | undefined;
}

export interface InkQuestionWizardView {
  readonly tab: number;
  readonly submitActionIndex: number;
  readonly otherMode: boolean;
  readonly otherText: string;
  readonly reviewMessage: string | undefined;
  readonly selectedIndex: number;
  readonly cursors: readonly number[];
  readonly singleSelections: readonly (number | undefined)[];
  readonly multiSelections: readonly number[][];
  readonly committedOther: readonly (string | undefined)[];
  readonly answers: readonly (string | undefined)[];
}

export function createInkQuestionWizardState(
  questionCount: number,
): InkQuestionWizardState {
  return {
    tab: 0,
    submitActionIndex: 0,
    otherMode: false,
    otherText: "",
    reviewMessage: undefined,
    cursors: Array.from({ length: questionCount }, () => 0),
    singleSelections: Array.from({ length: questionCount }, () => undefined),
    multiSelections: Array.from({ length: questionCount }, () => new Set()),
    otherDrafts: Array.from({ length: questionCount }, () => ""),
    committedOther: Array.from({ length: questionCount }, () => undefined),
    lastAnswerMethod: undefined,
  };
}

export function projectInkQuestionWizardView(
  request: PendingQuestion,
  wizard: InkQuestionWizardState,
): InkQuestionWizardView {
  const questionCount = request.data.questions.length;
  const questionIdx = currentQuestionIndex(wizard, questionCount);
  const selectedIndex =
    questionIdx === undefined ? 0 : (wizard.cursors[questionIdx] ?? 0);
  return {
    tab: wizard.tab,
    submitActionIndex: wizard.submitActionIndex,
    otherMode: wizard.otherMode,
    otherText: wizard.otherText,
    reviewMessage: wizard.reviewMessage,
    selectedIndex,
    cursors: [...wizard.cursors],
    singleSelections: [...wizard.singleSelections],
    multiSelections: wizard.multiSelections.map((set) => [...set]),
    committedOther: [...wizard.committedOther],
    answers: deriveQuestionAnswers(request, wizard),
  };
}

export function questionSubmitTabIndex(questionCount: number): number {
  return questionCount;
}

export function isInkQuestionSubmitTab(
  wizard: InkQuestionWizardState,
  questionCount: number,
): boolean {
  return wizard.tab === questionSubmitTabIndex(questionCount);
}

function currentQuestionIndex(
  wizard: InkQuestionWizardState,
  questionCount: number,
): number | undefined {
  return isInkQuestionSubmitTab(wizard, questionCount) ? undefined : wizard.tab;
}

function totalTabs(questionCount: number): number {
  return questionCount + 1;
}

function gotoTab(
  wizard: InkQuestionWizardState,
  questionCount: number,
  target: number,
): void {
  const wrapped = ((target % totalTabs(questionCount)) + totalTabs(questionCount)) % totalTabs(questionCount);
  if (wrapped === wizard.tab) return;
  wizard.tab = wrapped;
  wizard.otherMode = false;
  wizard.otherText = "";
  wizard.reviewMessage = undefined;
  if (isInkQuestionSubmitTab(wizard, questionCount)) {
    wizard.submitActionIndex = 0;
  }
}

function isAnswered(
  request: PendingQuestion,
  wizard: InkQuestionWizardState,
  questionIdx: number,
): boolean {
  const answer = deriveQuestionAnswers(request, wizard)[questionIdx];
  return answer !== undefined && answer.length > 0;
}

function findNextUnansweredAfter(
  request: PendingQuestion,
  wizard: InkQuestionWizardState,
  fromIdx: number,
): number | null {
  const total = request.data.questions.length;
  for (let idx = fromIdx + 1; idx < total; idx++) {
    if (!isAnswered(request, wizard, idx)) return idx;
  }
  return null;
}

function updateAnswer(
  request: PendingQuestion,
  wizard: InkQuestionWizardState,
  questionIdx: number,
): void {
  // Answers are derived on read; clearing review state is enough here.
  void questionIdx;
  void request;
  void wizard;
}

function deriveQuestionAnswers(
  request: PendingQuestion,
  wizard: InkQuestionWizardState,
): (string | undefined)[] {
  const answers: (string | undefined)[] = [];
  for (let i = 0; i < request.data.questions.length; i++) {
    const question = request.data.questions[i];
    if (question === undefined) {
      answers.push(undefined);
      continue;
    }
    if (question.multi_select) {
      const labels: string[] = [];
      const set = wizard.multiSelections[i] ?? new Set<number>();
      const otherIdx = questionOtherOptionIndex(question);
      for (let optionIdx = 0; optionIdx < question.options.length; optionIdx++) {
        if (!set.has(optionIdx)) continue;
        const label = question.options[optionIdx]?.label;
        if (label !== undefined && label.length > 0) labels.push(label);
      }
      const otherText = wizard.committedOther[i];
      if (
        set.has(otherIdx) &&
        otherText !== undefined &&
        otherText.length > 0
      ) {
        labels.push(otherText);
      }
      answers.push(labels.length > 0 ? labels.join(", ") : undefined);
      continue;
    }

    const selection = wizard.singleSelections[i];
    if (selection === undefined) {
      answers.push(undefined);
      continue;
    }
    if (isQuestionOtherOption(question, selection)) {
      const otherText = wizard.committedOther[i];
      answers.push(
        otherText !== undefined && otherText.length > 0 ? otherText : undefined,
      );
      continue;
    }
    const label = question.options[selection]?.label;
    answers.push(label !== undefined && label.length > 0 ? label : undefined);
  }
  return answers;
}

function syncOtherDraft(wizard: InkQuestionWizardState, questionIdx: number): void {
  wizard.otherDrafts[questionIdx] = wizard.otherText;
}

function enterOtherInput(
  wizard: InkQuestionWizardState,
  questionIdx: number,
  question: PendingQuestion["data"]["questions"][number],
): void {
  wizard.cursors[questionIdx] = questionOtherOptionIndex(question);
  wizard.otherMode = true;
  wizard.otherText = wizard.otherDrafts[questionIdx] ?? "";
  wizard.reviewMessage = undefined;
}

function commitOtherInput(
  request: PendingQuestion,
  wizard: InkQuestionWizardState,
  questionIdx: number,
  method: QuestionSubmissionMethod,
): boolean {
  const question = request.data.questions[questionIdx];
  if (question === undefined) return false;

  const value = wizard.otherText.trim();
  if (value.length === 0) return false;

  wizard.otherDrafts[questionIdx] = value;
  wizard.committedOther[questionIdx] = value;

  if (question.multi_select) {
    wizard.multiSelections[questionIdx]?.add(questionOtherOptionIndex(question));
  } else {
    wizard.singleSelections[questionIdx] = questionOtherOptionIndex(question);
  }

  wizard.lastAnswerMethod = method;
  updateAnswer(request, wizard, questionIdx);
  wizard.otherMode = false;
  wizard.otherText = "";
  wizard.reviewMessage = undefined;

  if (!question.multi_select) {
    advanceAfterSingleSelect(request, wizard, questionIdx);
  }
  return true;
}

function advanceAfterSingleSelect(
  request: PendingQuestion,
  wizard: InkQuestionWizardState,
  questionIdx: number,
): void {
  const next = findNextUnansweredAfter(request, wizard, questionIdx);
  wizard.tab = next ?? questionSubmitTabIndex(request.data.questions.length);
  wizard.reviewMessage = undefined;
  if (isInkQuestionSubmitTab(wizard, request.data.questions.length)) {
    wizard.submitActionIndex = 0;
  }
}

function activateQuestionOption(
  request: PendingQuestion,
  wizard: InkQuestionWizardState,
  questionIdx: number,
  optionIdx: number,
  method: QuestionSubmissionMethod,
): void {
  const question = request.data.questions[questionIdx];
  if (question === undefined) return;

  wizard.cursors[questionIdx] = optionIdx;
  wizard.otherMode = false;
  wizard.otherText = "";
  wizard.reviewMessage = undefined;

  if (isQuestionOtherOption(question, optionIdx)) {
    enterOtherInput(wizard, questionIdx, question);
    return;
  }

  if (question.multi_select) {
    const set = wizard.multiSelections[questionIdx];
    if (set === undefined) return;
    if (set.has(optionIdx)) set.delete(optionIdx);
    else set.add(optionIdx);
    wizard.lastAnswerMethod = method;
    updateAnswer(request, wizard, questionIdx);
    return;
  }

  wizard.singleSelections[questionIdx] = optionIdx;
  wizard.committedOther[questionIdx] = undefined;
  wizard.lastAnswerMethod = method;
  updateAnswer(request, wizard, questionIdx);
  advanceAfterSingleSelect(request, wizard, questionIdx);
}

function moveQuestionCursor(
  request: PendingQuestion,
  wizard: InkQuestionWizardState,
  questionIdx: number,
  delta: number,
): void {
  const question = request.data.questions[questionIdx];
  if (question === undefined) return;
  const optionCount = buildQuestionDisplayOptions(question).length;
  if (optionCount <= 0) return;
  const cursor = wizard.cursors[questionIdx] ?? 0;
  wizard.cursors[questionIdx] = (cursor + delta + optionCount) % optionCount;
  wizard.reviewMessage = undefined;
}

function emitAnswers(
  request: PendingQuestion,
  wizard: InkQuestionWizardState,
  method: QuestionSubmissionMethod,
  respond: (response: QuestionPanelResponse) => void,
): void {
  const derived = deriveQuestionAnswers(request, wizard);
  const out: string[] = [];
  for (let i = 0; i < derived.length; i++) {
    const answer = derived[i];
    if (answer !== undefined && answer.length > 0) out[i] = answer;
  }
  respond({
    answers: out,
    method: wizard.lastAnswerMethod ?? method,
  });
}

function handleOtherInput(
  request: PendingQuestion,
  wizard: InkQuestionWizardState,
  questionIdx: number,
  data: string,
  respond: (response: QuestionPanelResponse) => void,
): boolean {
  if (matchesKey(data, Key.tab)) {
    syncOtherDraft(wizard, questionIdx);
    wizard.otherMode = false;
    wizard.otherText = "";
    gotoTab(wizard, request.data.questions.length, wizard.tab + 1);
    return true;
  }
  if (matchesKey(data, Key.up)) {
    syncOtherDraft(wizard, questionIdx);
    wizard.otherMode = false;
    wizard.otherText = "";
    moveQuestionCursor(request, wizard, questionIdx, -1);
    return true;
  }
  if (matchesKey(data, Key.down)) {
    syncOtherDraft(wizard, questionIdx);
    wizard.otherMode = false;
    wizard.otherText = "";
    moveQuestionCursor(request, wizard, questionIdx, 1);
    return true;
  }
  if (matchesKey(data, Key.backspace)) {
    wizard.otherText = wizard.otherText.slice(0, -1);
    syncOtherDraft(wizard, questionIdx);
    wizard.reviewMessage = undefined;
    return true;
  }
  const printable = printableChar(data);
  if (printable !== undefined && isPrintableChar(printable)) {
    wizard.otherText += printable;
    syncOtherDraft(wizard, questionIdx);
    wizard.reviewMessage = undefined;
    return true;
  }
  if (matchesKey(data, Key.enter)) {
    commitOtherInput(request, wizard, questionIdx, "enter");
    return true;
  }
  return true;
}

function handleSubmitInput(
  request: PendingQuestion,
  wizard: InkQuestionWizardState,
  data: string,
  respond: (response: QuestionPanelResponse) => void,
): boolean {
  if (matchesKey(data, Key.up)) {
    wizard.submitActionIndex =
      (wizard.submitActionIndex - 1 + SUBMIT_ACTIONS.length) %
      SUBMIT_ACTIONS.length;
    wizard.reviewMessage = undefined;
    return true;
  }
  if (matchesKey(data, Key.down)) {
    wizard.submitActionIndex =
      (wizard.submitActionIndex + 1) % SUBMIT_ACTIONS.length;
    wizard.reviewMessage = undefined;
    return true;
  }
  if (matchesKey(data, Key.left)) {
    gotoTab(wizard, request.data.questions.length, wizard.tab - 1);
    return true;
  }
  if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
    gotoTab(wizard, request.data.questions.length, wizard.tab + 1);
    return true;
  }
  if (matchesKey(data, Key.enter)) {
    if (wizard.submitActionIndex === 1) {
      respond({ answers: [] });
      return true;
    }
    wizard.reviewMessage = undefined;
    emitAnswers(request, wizard, "enter", respond);
    return true;
  }
  const printable = printableChar(data);
  if (printable === "1") {
    wizard.submitActionIndex = 0;
    wizard.reviewMessage = undefined;
    emitAnswers(request, wizard, "number_key", respond);
    return true;
  }
  if (printable === "2") {
    wizard.submitActionIndex = 1;
    respond({ answers: [] });
    return true;
  }
  return true;
}

function handleQuestionInput(
  request: PendingQuestion,
  wizard: InkQuestionWizardState,
  questionIdx: number,
  data: string,
  respond: (response: QuestionPanelResponse) => void,
): boolean {
  const question = request.data.questions[questionIdx];
  if (question === undefined) return true;

  const options = buildQuestionDisplayOptions(question);
  const optionCount = options.length;
  if (optionCount === 0) return true;

  if (wizard.otherMode) {
    return handleOtherInput(request, wizard, questionIdx, data, respond);
  }

  if (matchesKey(data, Key.up)) {
    moveQuestionCursor(request, wizard, questionIdx, -1);
    return true;
  }
  if (matchesKey(data, Key.down)) {
    moveQuestionCursor(request, wizard, questionIdx, 1);
    return true;
  }
  if (matchesKey(data, Key.left)) {
    gotoTab(wizard, request.data.questions.length, wizard.tab - 1);
    return true;
  }
  if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
    gotoTab(wizard, request.data.questions.length, wizard.tab + 1);
    return true;
  }

  const cursor = wizard.cursors[questionIdx] ?? 0;

  if (question.multi_select && matchesKey(data, Key.space)) {
    activateQuestionOption(request, wizard, questionIdx, cursor, "space");
    return true;
  }

  if (matchesKey(data, Key.enter)) {
    activateQuestionOption(request, wizard, questionIdx, cursor, "enter");
    return true;
  }

  const printable = printableChar(data);
  const numericIndex = NUMBER_KEYS.indexOf(
    printable as (typeof NUMBER_KEYS)[number],
  );
  if (numericIndex >= 0 && numericIndex < optionCount) {
    activateQuestionOption(
      request,
      wizard,
      questionIdx,
      numericIndex,
      "number_key",
    );
    return true;
  }

  return true;
}

/** Handle keyboard input for an Ink-owned question dialog. Returns true when consumed. */
export function handleInkQuestionWizardInput(
  request: PendingQuestion,
  wizard: InkQuestionWizardState,
  data: string,
  respond: (response: QuestionPanelResponse) => void,
): boolean {
  if (
    matchesKey(data, Key.escape) ||
    matchesKey(data, Key.ctrl("c")) ||
    matchesKey(data, Key.ctrl("d"))
  ) {
    if (wizard.otherMode) {
      wizard.otherMode = false;
      wizard.otherText = "";
      return true;
    }
    respond({ answers: [] });
    return true;
  }

  const questionCount = request.data.questions.length;
  if (isInkQuestionSubmitTab(wizard, questionCount)) {
    return handleSubmitInput(request, wizard, data, respond);
  }

  const questionIdx = currentQuestionIndex(wizard, questionCount);
  if (questionIdx === undefined) return true;
  return handleQuestionInput(request, wizard, questionIdx, data, respond);
}

export function hasUnansweredInkQuestions(
  request: PendingQuestion,
  wizard: InkQuestionWizardState,
): boolean {
  for (let i = 0; i < request.data.questions.length; i++) {
    if (!isAnswered(request, wizard, i)) return true;
  }
  return false;
}

export function hasUnansweredInkQuestionAnswers(
  wizard: InkQuestionWizardView,
): boolean {
  return wizard.answers.some(
    (answer) => answer === undefined || answer.length === 0,
  );
}

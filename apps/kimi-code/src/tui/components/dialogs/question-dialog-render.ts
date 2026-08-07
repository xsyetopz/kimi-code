import {
  Input,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@moonshot-ai/kimi-tui";

import { currentTheme } from "#/tui/theme";
import type { PendingQuestion } from "#/tui/reverse-rpc/types";
import {
  buildQuestionDisplayOptions,
  isQuestionOtherOption,
  type QuestionDisplayOption,
} from "./question-dialog-options";

export const MAX_BODY_LINES = 12;
export const NOT_ANSWERED_LABEL = "Not answered";
export const REVIEW_TITLE = "Review your answer before submit";
export const SUBMIT_PROMPT = "Ready to submit your answers?";
export const UNANSWERED_WARNING = "Some questions are still unanswered.";
export const SUBMIT_ACTIONS = ["Submit", "Cancel"] as const;

/**
 * Push `content` to `lines`, wrapping it to fit `width` with a hanging
 * indent. The first physical line starts with `firstPrefix`; continuation
 * lines get `continuationPrefix`. Pass `tone` to wrap every emitted line
 * in a single ANSI span (cleaner for selection highlights and matches the
 * pre-wrap rendering tests expect); leave it undefined when the prefixes
 * already carry their own mixed styling.
 */
export function appendWrapped(
  lines: string[],
  firstPrefix: string,
  continuationPrefix: string,
  content: string,
  width: number,
  tone?: (s: string) => string,
): void {
  const prefixWidth = Math.max(
    visibleWidth(firstPrefix),
    visibleWidth(continuationPrefix),
  );
  const contentWidth = Math.max(1, width - prefixWidth);
  const wrapped = wrapTextWithAnsi(content, contentWidth);
  const styleLine = tone ?? ((s: string) => s);
  if (wrapped.length === 0) {
    lines.push(styleLine(firstPrefix));
    return;
  }
  lines.push(styleLine(`${firstPrefix}${wrapped[0] ?? ""}`));
  for (let i = 1; i < wrapped.length; i++) {
    lines.push(styleLine(`${continuationPrefix}${wrapped[i] ?? ""}`));
  }
}

export interface QuestionDialogRenderHost {
  readonly request: PendingQuestion;
  readonly maxVisibleOptions: number;
  readonly otherInput: Input;
  readonly currentTab: number;
  readonly submitActionIdx: number;
  readonly editingOther: boolean;
  readonly reviewMessage: string | undefined;
  readonly cursors: readonly number[];
  readonly singleSelections: readonly (number | undefined)[];
  readonly multiSelections: readonly ReadonlySet<number>[];
  readonly otherDrafts: readonly string[];
  readonly committedOtherValues: readonly (string | undefined)[];
  readonly answers: readonly (string | undefined)[];
  isSubmitTab(): boolean;
  isEditingOther(): boolean;
  currentQuestionIndex(): number | undefined;
  currentCursor(): number;
  displayOptions(questionIdx: number): readonly QuestionDisplayOption[];
  otherDraftValue(questionIdx: number): string;
  isAnswered(questionIdx: number): boolean;
  hasUnansweredQuestions(): boolean;
  totalTabs(): number;
}

export function renderQuestionDialog(
  host: QuestionDialogRenderHost,
  width: number,
): string[] {
  return host.isSubmitTab()
    ? renderSubmitTab(host, width)
    : renderQuestionTab(host, width);
}

function renderQuestionTab(
  host: QuestionDialogRenderHost,
  width: number,
): string[] {
  const questionIdx = host.currentQuestionIndex();
  if (questionIdx === undefined) return renderSubmitTab(host, width);

  const question = host.request.data.questions[questionIdx];
  if (question === undefined) return [];

  const accent = (text: string) => currentTheme.fg("primary", text);
  const dim = (text: string) => currentTheme.fg("textDim", text);
  const success = (text: string) => currentTheme.fg("success", text);

  const renderWidth = Math.max(1, width);
  const lines: string[] = [
    accent("─".repeat(renderWidth)),
    currentTheme.boldFg("primary", " question"),
    "",
  ];
  pushTabs(host, lines);
  lines.push("");

  appendWrapped(lines, " ? ", "   ", question.question, renderWidth, accent);
  if (host.isEditingOther()) {
    lines.push(dim("   Type your answer, then press Enter to save."));
  }

  if (question.body !== undefined && question.body.trim().length > 0) {
    lines.push("");
    const bodyLines = question.body.trim().split("\n");
    const visibleBodyLines = bodyLines.slice(0, MAX_BODY_LINES);
    for (const bodyLine of visibleBodyLines) {
      appendWrapped(lines, "   ", "   ", bodyLine, renderWidth, dim);
    }
    if (bodyLines.length > visibleBodyLines.length) {
      lines.push(
        dim(
          `   ... ${String(bodyLines.length - visibleBodyLines.length)} more lines`,
        ),
      );
    }
  }

  lines.push("");

  const options = host.displayOptions(questionIdx);
  const cursor = host.currentCursor();
  const visibleStart = computeVisibleStart(
    host.maxVisibleOptions,
    cursor,
    options.length,
  );
  const visibleEnd = Math.min(
    options.length,
    visibleStart + host.maxVisibleOptions,
  );
  const multiSet = host.multiSelections[questionIdx] ?? new Set<number>();
  const singleSelection = host.singleSelections[questionIdx];

  for (let i = visibleStart; i < visibleEnd; i++) {
    const option = options[i];
    if (option === undefined) continue;
    const num = i + 1;
    const isCursor = i === cursor;
    const isOther = option.kind === "other";
    const isSelected = question.multi_select
      ? multiSet.has(i)
      : singleSelection === i;

    if (host.isEditingOther() && isCursor && isOther) {
      lines.push(
        renderEditingOtherLine(host, width, questionIdx, option, num, isSelected),
      );
      continue;
    }

    const label = renderOptionLabel(host, questionIdx, option, isCursor);

    let tone: (s: string) => string;
    let prefix: string;
    if (question.multi_select) {
      const checked = isSelected ? "✓" : " ";
      prefix = `  [${checked}] `;
      if (isSelected && isCursor)
        tone = (s) => currentTheme.boldFg("success", s);
      else if (isSelected) tone = success;
      else if (isCursor) tone = accent;
      else tone = dim;
    } else if (isSelected && host.isAnswered(questionIdx)) {
      prefix = isCursor ? `  → [${String(num)}] ` : `    [${String(num)}] `;
      tone = isCursor ? (s) => currentTheme.boldFg("success", s) : success;
    } else if (isCursor) {
      prefix = `  → [${String(num)}] `;
      tone = accent;
    } else {
      prefix = `    [${String(num)}] `;
      tone = dim;
    }
    const continuation = " ".repeat(visibleWidth(prefix));
    appendWrapped(lines, prefix, continuation, label, renderWidth, tone);

    if (
      option.description !== undefined &&
      option.description.length > 0 &&
      !(host.isEditingOther() && isCursor && isOther)
    ) {
      appendWrapped(
        lines,
        "        ",
        "        ",
        option.description,
        renderWidth,
        dim,
      );
    }
  }

  if (visibleEnd < options.length || visibleStart > 0) {
    lines.push(
      dim(
        `   showing ${String(visibleStart + 1)}-${String(visibleEnd)} of ${String(options.length)}`,
      ),
    );
  }

  lines.push("");
  lines.push(buildQuestionHint(host, dim, questionIdx));
  lines.push(accent("─".repeat(renderWidth)));

  return lines.map((line) => truncateToWidth(line, width));
}

function renderSubmitTab(
  host: QuestionDialogRenderHost,
  width: number,
): string[] {
  const accent = (text: string) => currentTheme.fg("primary", text);
  const dim = (text: string) => currentTheme.fg("textDim", text);
  const text = (t: string) => currentTheme.fg("text", t);
  const warning = (text: string) => currentTheme.fg("warning", text);

  const renderWidth = Math.max(1, width);
  const lines: string[] = [
    accent("─".repeat(renderWidth)),
    currentTheme.boldFg("primary", " question"),
    "",
  ];
  pushTabs(host, lines);
  lines.push("");
  lines.push(currentTheme.boldFg("text", ` ${REVIEW_TITLE}`));
  const reviewWarning =
    host.reviewMessage ??
    (host.hasUnansweredQuestions() ? UNANSWERED_WARNING : undefined);
  if (reviewWarning !== undefined) {
    lines.push(warning(`  ${reviewWarning}`));
  }
  lines.push("");

  for (let i = 0; i < host.request.data.questions.length; i++) {
    const question = host.request.data.questions[i];
    if (question === undefined) continue;
    const answer = host.answers[i];
    appendWrapped(
      lines,
      `  ${dim("Q")}  `,
      "       ",
      question.question,
      renderWidth,
    );
    if (answer !== undefined && answer.length > 0) {
      appendWrapped(
        lines,
        `  ${accent("→")}  `,
        "       ",
        text(answer),
        renderWidth,
      );
    } else {
      lines.push(`  ${dim("→")}  ${dim(NOT_ANSWERED_LABEL)}`);
    }
  }

  lines.push("");
  lines.push(text(` ${SUBMIT_PROMPT}`));
  lines.push("");

  for (let i = 0; i < SUBMIT_ACTIONS.length; i++) {
    const label = SUBMIT_ACTIONS[i];
    if (label === undefined) continue;
    const num = i + 1;
    if (i === host.submitActionIdx) {
      lines.push(accent(`  → [${String(num)}] ${label}`));
    } else {
      lines.push(dim(`    [${String(num)}] ${label}`));
    }
  }

  lines.push("");
  lines.push(buildSubmitHint(host, dim));
  lines.push(accent("─".repeat(renderWidth)));

  return lines.map((line) => truncateToWidth(line, width));
}

function pushTabs(host: QuestionDialogRenderHost, lines: string[]): void {
  const dim = (text: string) => currentTheme.fg("textDim", text);
  const active = (text: string) =>
    currentTheme.bg("primary", currentTheme.boldFg("text", text));

  const tabs: string[] = [];
  for (let i = 0; i < host.request.data.questions.length; i++) {
    const question = host.request.data.questions[i];
    if (question === undefined) continue;
    const label =
      question.header !== undefined && question.header.length > 0
        ? question.header
        : `Q${String(i + 1)}`;
    if (i === host.currentTab) tabs.push(active(` ${label} `));
    else if (host.isAnswered(i))
      tabs.push(currentTheme.fg("success", `(✓) ${label}`));
    else tabs.push(dim(`(○) ${label}`));
  }

  const submitLabel = "Submit";
  if (host.isSubmitTab()) tabs.push(active(` ${submitLabel} `));
  else tabs.push(dim(` ${submitLabel} `));

  lines.push(` ${tabs.join("  ")}`);
}

function buildQuestionHint(
  host: QuestionDialogRenderHost,
  dim: (s: string) => string,
  questionIdx: number,
): string {
  if (host.isEditingOther()) {
    const parts: string[] = [
      "type answer",
      "↵ save",
      ...(host.totalTabs() > 1 ? ["tab switch"] : []),
      "esc cancel",
    ];
    return dim(`  ${parts.join("  ")}`);
  }

  const optionCount = Math.min(
    host.displayOptions(questionIdx).length,
    9,
  );
  const numberHint = optionCount <= 1 ? "1" : `1-${String(optionCount)}`;
  const question = host.request.data.questions[questionIdx];
  if (question === undefined) return dim("  esc cancel");

  const parts: string[] = [
    "↑↓ select",
    `${numberHint} / ↵ ${question.multi_select ? "toggle" : "choose"}`,
  ];
  if (host.totalTabs() > 1) parts.push("←/→/tab switch");
  parts.push("esc cancel");
  return dim(`  ${parts.join("  ")}`);
}

function buildSubmitHint(
  host: QuestionDialogRenderHost,
  dim: (s: string) => string,
): string {
  const parts: string[] = ["↑↓ select", "1/2 choose", "↵ confirm"];
  if (host.totalTabs() > 1) parts.push("←/→/tab switch");
  parts.push("esc cancel");
  return dim(`  ${parts.join("  ")}`);
}

function computeVisibleStart(
  maxVisibleOptions: number,
  cursor: number,
  total: number,
): number {
  if (total <= maxVisibleOptions) return 0;
  const half = Math.floor(maxVisibleOptions / 2);
  const max = Math.max(0, total - maxVisibleOptions);
  return Math.max(0, Math.min(cursor - half, max));
}

function renderOptionLabel(
  host: QuestionDialogRenderHost,
  questionIdx: number,
  option: QuestionDisplayOption,
  isCursor: boolean,
): string {
  if (option.kind !== "other") return option.label;

  const value = host.otherDraftValue(questionIdx);
  if (host.isEditingOther() && isCursor) {
    return `${option.label}: ${value}█`;
  }
  if (value.length > 0) return `${option.label}: ${value}`;
  return option.label;
}

function renderEditingOtherLine(
  host: QuestionDialogRenderHost,
  width: number,
  questionIdx: number,
  option: QuestionDisplayOption,
  num: number,
  isSelected: boolean,
): string {
  const question = host.request.data.questions[questionIdx];
  if (question === undefined) return option.label;

  let prefix: string;
  if (question.multi_select) {
    const checked = isSelected ? "✓" : " ";
    const body = `  [${checked}] ${option.label}: `;
    prefix = isSelected
      ? currentTheme.boldFg("success", body)
      : currentTheme.fg("primary", body);
  } else {
    const body = `  → [${String(num)}] ${option.label}: `;
    prefix =
      isSelected && host.isAnswered(questionIdx)
        ? currentTheme.boldFg("success", body)
        : currentTheme.fg("primary", body);
  }

  const inputWidth = Math.max(4, width - visibleWidth(prefix) + 2);
  const inputLine = host.otherInput.render(inputWidth)[0] ?? "> ";
  const inlineInput = inputLine.startsWith("> ")
    ? inputLine.slice(2)
    : inputLine;
  return prefix + inlineInput;
}

export function displayOptionsForQuestion(
  host: QuestionDialogRenderHost,
  questionIdx: number,
): readonly QuestionDisplayOption[] {
  const question = host.request.data.questions[questionIdx];
  if (question === undefined) return [];
  return buildQuestionDisplayOptions(question);
}

export function isOtherOption(
  host: QuestionDialogRenderHost,
  questionIdx: number,
  optionIdx: number,
): boolean {
  const question = host.request.data.questions[questionIdx];
  if (question === undefined) return false;
  return isQuestionOtherOption(question, optionIdx);
}

export function otherOptionIndex(
  host: QuestionDialogRenderHost,
  questionIdx: number,
): number {
  const question = host.request.data.questions[questionIdx];
  if (question === undefined) return 0;
  return question.options.length;
}

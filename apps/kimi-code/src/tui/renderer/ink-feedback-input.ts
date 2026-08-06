import type {
  FeedbackInputDialogOptions,
  FeedbackInputDialogResult,
} from "#/tui/components/dialogs/feedback-input-dialog";
import {
  InkSingleLineInputSession,
  type InkSingleLineInputView,
} from "./ink-input-dialog-common";

const TITLE = "Send feedback to Kimi Code";
const SUBTITLE_DEFAULT = "Tell us what's working or what's not.";
const SUBTITLE_EMPTY = "Feedback cannot be empty.";
const FOOTER = "Enter to submit  ·  Esc to cancel";

export type InkFeedbackInputView = InkSingleLineInputView;

export function createInkFeedbackInputSession(
  opts: FeedbackInputDialogOptions,
): InkSingleLineInputSession<FeedbackInputDialogResult> {
  return new InkSingleLineInputSession({
    title: TITLE,
    subtitleLines: [SUBTITLE_DEFAULT],
    footer: FOOTER,
    mask: false,
    emptyHint: SUBTITLE_EMPTY,
    onDone: opts.onDone,
    doneResult: (value) => ({ kind: "ok", value }),
    cancelResult: () => ({ kind: "cancel" }),
  });
}

export function projectInkFeedbackInputView(
  session: InkSingleLineInputSession<FeedbackInputDialogResult>,
  width = 120,
): InkFeedbackInputView {
  return session.projectView(width);
}

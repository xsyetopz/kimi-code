import type {
  ApiKeyInputDialogOptions,
  ApiKeyInputResult,
} from "#/tui/components/dialogs/api-key-input-dialog";
import {
  InkSingleLineInputSession,
  type InkSingleLineInputView,
} from "./ink-input-dialog-common";

const FOOTER = "Enter to submit  ·  Esc to cancel";

export type InkApiKeyInputView = InkSingleLineInputView;

export function createInkApiKeyInputSession(
  opts: ApiKeyInputDialogOptions,
): InkSingleLineInputSession<ApiKeyInputResult> {
  return new InkSingleLineInputSession({
    title: opts.title ?? `Enter API key for ${opts.platformName}`,
    subtitleLines: opts.subtitleLines,
    footer: FOOTER,
    mask: opts.mask ?? true,
    emptyHint: opts.emptyHint ?? "API key cannot be empty.",
    onDone: opts.onDone,
    doneResult: (value) => ({ kind: "ok", value }),
    cancelResult: () => ({ kind: "cancel" }),
  });
}

export function projectInkApiKeyInputView(
  session: InkSingleLineInputSession<ApiKeyInputResult>,
  width = 120,
): InkApiKeyInputView {
  return session.projectView(width);
}

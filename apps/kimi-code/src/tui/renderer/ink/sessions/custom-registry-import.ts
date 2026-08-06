import { Input, Key, matchesKey } from "@moonshot-ai/kimi-tui";

import type {
  CustomRegistryImportDialogOptions,
  CustomRegistryImportResult,
} from "#/tui/components/dialogs/custom-registry-import";
import { maskInputLine } from "./input-single-line";

const TITLE = "Import custom provider registry";
const SUBTITLE_DEFAULT = "Paste an api.json URL and its Bearer token.";
const SUBTITLE_URL_EMPTY = "Registry URL cannot be empty.";
const SUBTITLE_TOKEN_EMPTY = "Bearer token cannot be empty.";
const FOOTER_NOT_LAST =
  "Tab / ↑↓ to switch  ·  Enter for next field  ·  Esc to cancel";
const FOOTER_LAST = "Tab / ↑↓ to switch  ·  Enter to submit  ·  Esc to cancel";

type FieldId = "url" | "token";

export interface InkCustomRegistryImportView {
  readonly title: string;
  readonly subtitle: string;
  readonly urlLabel: string;
  readonly urlInputLine: string;
  readonly tokenLabel: string;
  readonly tokenInputLine: string;
  readonly footer: string;
  readonly activeField: FieldId;
}

export class InkCustomRegistryImportSession {
  private readonly opts: CustomRegistryImportDialogOptions;
  private readonly urlInput = new Input();
  private readonly tokenInput = new Input();
  private activeField: FieldId = "url";
  private done = false;
  private hint: "none" | "url-empty" | "token-empty" = "none";

  constructor(opts: CustomRegistryImportDialogOptions) {
    this.opts = opts;
    if (opts.defaultUrl !== undefined && opts.defaultUrl.length > 0) {
      this.urlInput.setValue(opts.defaultUrl);
    }
    this.urlInput.onSubmit = () => {
      this.focusField("token");
    };
    this.tokenInput.onSubmit = () => {
      this.handleSubmit();
    };
  }

  handleInput(data: string): boolean {
    if (this.done) return true;
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl("c")) ||
      matchesKey(data, Key.ctrl("d"))
    ) {
      this.done = true;
      this.opts.onDone({ kind: "cancel" });
      return true;
    }

    if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
      this.toggleField();
      return true;
    }
    if (matchesKey(data, Key.down)) {
      this.focusField("token");
      return true;
    }
    if (matchesKey(data, Key.up)) {
      this.focusField("url");
      return true;
    }

    if (this.hint !== "none") {
      this.hint = "none";
    }

    if (this.activeField === "url") {
      this.urlInput.handleInput(data);
    } else {
      this.tokenInput.handleInput(data);
    }
    return true;
  }

  projectView(width = 120): InkCustomRegistryImportView {
    const innerWidth = Math.max(1, width - 4);
    this.urlInput.focused = !this.done && this.activeField === "url";
    this.tokenInput.focused = !this.done && this.activeField === "token";
    const subtitle =
      this.hint === "url-empty"
        ? SUBTITLE_URL_EMPTY
        : this.hint === "token-empty"
          ? SUBTITLE_TOKEN_EMPTY
          : SUBTITLE_DEFAULT;
    const rawTokenLine = this.tokenInput.render(innerWidth)[0] ?? "> ";
    return {
      title: TITLE,
      subtitle,
      urlLabel: "Registry URL",
      urlInputLine: this.urlInput.render(innerWidth)[0] ?? "> ",
      tokenLabel: "Bearer token",
      tokenInputLine: maskInputLine(rawTokenLine),
      footer: this.activeField === "url" ? FOOTER_NOT_LAST : FOOTER_LAST,
      activeField: this.activeField,
    };
  }

  private toggleField(): void {
    this.focusField(this.activeField === "url" ? "token" : "url");
  }

  private focusField(field: FieldId): void {
    this.hint = "none";
    this.activeField = field;
  }

  private handleSubmit(): void {
    if (this.done) return;

    const urlValue = this.urlInput.getValue().trim();
    const tokenValue = this.tokenInput.getValue().trim();

    if (urlValue.length === 0) {
      this.hint = "url-empty";
      this.activeField = "url";
      return;
    }
    if (tokenValue.length === 0) {
      this.hint = "token-empty";
      this.activeField = "token";
      return;
    }

    this.done = true;
    this.opts.onDone({
      kind: "ok",
      value: { url: urlValue, apiKey: tokenValue },
    });
  }
}

export function createInkCustomRegistryImportSession(
  opts: CustomRegistryImportDialogOptions,
): InkCustomRegistryImportSession {
  return new InkCustomRegistryImportSession(opts);
}

export function projectInkCustomRegistryImportView(
  session: InkCustomRegistryImportSession,
  width = 120,
): InkCustomRegistryImportView {
  return session.projectView(width);
}

export type { CustomRegistryImportDialogOptions, CustomRegistryImportResult };

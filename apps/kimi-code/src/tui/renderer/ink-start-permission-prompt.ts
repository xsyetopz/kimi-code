import { Key, matchesKey, truncateToWidth, visibleWidth } from "@moonshot-ai/kimi-tui";

import type {
  StartPermissionOption,
  StartPermissionPromptOptions,
} from "#/tui/components/dialogs/start-permission-prompt";

export interface InkStartPermissionNoticeView {
  readonly lines: readonly string[];
}

export interface InkStartPermissionOptionView {
  readonly value: string;
  readonly label: string;
  readonly descriptionLines: readonly string[];
  readonly selected: boolean;
}

export interface InkStartPermissionPromptView {
  readonly title: string;
  readonly hint: string;
  readonly notices: readonly InkStartPermissionNoticeView[];
  readonly options: readonly InkStartPermissionOptionView[];
}

export class InkStartPermissionPromptSession<
  TChoice extends string = string,
> {
  private readonly opts: StartPermissionPromptOptions<TChoice>;
  private selectedIndex = 0;

  constructor(opts: StartPermissionPromptOptions<TChoice>) {
    this.opts = opts;
  }

  handleInput(
    data: string,
    callbacks: {
      readonly onSelect: (choice: TChoice) => void;
      readonly onCancel: () => void;
    },
  ): boolean {
    if (matchesKey(data, Key.escape)) {
      callbacks.onCancel();
      return true;
    }
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return true;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(
        this.opts.options.length - 1,
        this.selectedIndex + 1,
      );
      return true;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
      const option = this.opts.options[this.selectedIndex];
      if (option !== undefined) callbacks.onSelect(option.value);
      return true;
    }
    return true;
  }

  projectView(width = 120): InkStartPermissionPromptView {
    const textWidth = Math.max(20, width - 2);
    const descriptionWidth = Math.max(20, width - 4);
    return {
      title: this.opts.title,
      hint: "↑↓ navigate · Enter select · Esc cancel",
      notices: this.opts.noticeLines.map((paragraph) => ({
        lines: wrapPlain(paragraph, textWidth),
      })),
      options: this.opts.options.map((option, index) => ({
        value: option.value,
        label: option.label,
        descriptionLines: wrapPlain(option.description, descriptionWidth),
        selected: index === this.selectedIndex,
      })),
    };
  }
}

function wrapPlain(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (visibleWidth(candidate) <= width) {
      current = candidate;
      continue;
    }
    if (current.length > 0) lines.push(current);
    current =
      visibleWidth(word) <= width ? word : truncateToWidth(word, width, "…");
  }
  if (current.length > 0) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

export function createInkStartPermissionPromptSession<
  TChoice extends string = string,
>(opts: StartPermissionPromptOptions<TChoice>): InkStartPermissionPromptSession<TChoice> {
  return new InkStartPermissionPromptSession(opts);
}

export function projectInkStartPermissionPromptView<
  TChoice extends string = string,
>(
  session: InkStartPermissionPromptSession<TChoice>,
  width = 120,
): InkStartPermissionPromptView {
  return session.projectView(width);
}

export type { StartPermissionOption, StartPermissionPromptOptions };

import { Input, Key, matchesKey } from "@moonshot-ai/kimi-tui";

export function maskInputLine(raw: string): string {
  const prefix = "> ";
  if (!raw.startsWith(prefix)) return raw;

  let end = raw.length;
  while (end > prefix.length && raw[end - 1] === " ") {
    end--;
  }
  const padding = raw.slice(end);
  const content = raw.slice(prefix.length, end);

  const parts = content.split(/(\u001B(?:\[[0-9;]*m|_pi:c\u0007))/);
  const maskedContent = parts
    .map((part, index) => {
      if (index % 2 === 1) return part;
      return part.replaceAll(/[^ ]/g, "•");
    })
    .join("");

  return prefix + maskedContent + padding;
}

export interface InkSingleLineInputView {
  readonly title: string;
  readonly subtitleLines: readonly string[];
  readonly inputLine: string;
  readonly footer: string;
}

export class InkSingleLineInputSession<TResult> {
  private readonly input = new Input();
  private readonly title: string;
  private readonly subtitleLines: readonly string[];
  private readonly footer: string;
  private readonly mask: boolean;
  private readonly emptyHint: string;
  private readonly onDone: (result: TResult) => void;
  private readonly doneResult: (value: string) => TResult;
  private readonly cancelResult: () => TResult;
  private done = false;
  private emptyHinted = false;

  constructor(options: {
    readonly title: string;
    readonly subtitleLines: readonly string[];
    readonly footer: string;
    readonly mask?: boolean;
    readonly emptyHint: string;
    readonly initialValue?: string;
    readonly onDone: (result: TResult) => void;
    readonly doneResult: (value: string) => TResult;
    readonly cancelResult: () => TResult;
  }) {
    this.title = options.title;
    this.subtitleLines = options.subtitleLines;
    this.footer = options.footer;
    this.mask = options.mask ?? false;
    this.emptyHint = options.emptyHint;
    this.onDone = options.onDone;
    this.doneResult = options.doneResult;
    this.cancelResult = options.cancelResult;
    if (options.initialValue !== undefined && options.initialValue.length > 0) {
      this.input.setValue(options.initialValue);
    }
    this.input.onSubmit = (value) => {
      this.submit(value);
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
      this.onDone(this.cancelResult());
      return true;
    }
    if (this.emptyHinted) {
      this.emptyHinted = false;
    }
    this.input.handleInput(data);
    return true;
  }

  projectView(width = 120): InkSingleLineInputView {
    this.input.focused = !this.done;
    const innerWidth = Math.max(1, width - 4);
    const rawInputLine = this.input.render(innerWidth)[0] ?? "> ";
    const inputLine =
      this.mask && this.input.getValue() !== ""
        ? maskInputLine(rawInputLine)
        : rawInputLine;
    return {
      title: this.title,
      subtitleLines: this.emptyHinted
        ? [this.emptyHint]
        : this.subtitleLines,
      inputLine,
      footer: this.footer,
    };
  }

  private submit(value: string): void {
    if (this.done) return;
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      this.emptyHinted = true;
      return;
    }
    this.done = true;
    this.onDone(this.doneResult(trimmed));
  }
}

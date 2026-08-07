import type { ThinkingEffort } from "@moonshot-ai/kimi-code-sdk";
import { Key, matchesKey } from "@moonshot-ai/kimi-tui";

import { type EffortSelectorOptions } from "#/tui/components/dialogs/effort-selector";
import { effortLabel } from "#/tui/components/dialogs/model-selector";

export interface InkEffortSelectorSegmentView {
  readonly effort: ThinkingEffort;
  readonly label: string;
  readonly active: boolean;
}

export interface InkEffortSelectorView {
  readonly title: string;
  readonly hint: string;
  readonly warning: string | undefined;
  readonly segments: readonly InkEffortSelectorSegmentView[];
}

export class InkEffortSelectorSession {
  private readonly opts: EffortSelectorOptions;
  private activeIndex: number;

  constructor(opts: EffortSelectorOptions) {
    this.opts = opts;
    const idx = opts.efforts.indexOf(opts.currentValue);
    this.activeIndex = Math.max(idx, 0);
  }

  handleInput(
    data: string,
    callbacks: {
      readonly onSelect: (effort: ThinkingEffort) => void;
      readonly onSessionOnlySelect?: (effort: ThinkingEffort) => void;
      readonly onCancel: () => void;
    },
  ): boolean {
    if (matchesKey(data, Key.escape)) {
      callbacks.onCancel();
      return true;
    }
    if (matchesKey(data, Key.left)) {
      this.activeIndex = Math.max(0, this.activeIndex - 1);
      return true;
    }
    if (matchesKey(data, Key.right)) {
      this.activeIndex = Math.min(
        this.opts.efforts.length - 1,
        this.activeIndex + 1,
      );
      return true;
    }
    if (
      matchesKey(data, Key.alt("s")) &&
      callbacks.onSessionOnlySelect !== undefined
    ) {
      callbacks.onSessionOnlySelect(this.opts.efforts[this.activeIndex]!);
      return true;
    }
    if (matchesKey(data, Key.enter)) {
      callbacks.onSelect(this.opts.efforts[this.activeIndex]!);
      return true;
    }
    return true;
  }

  projectView(): InkEffortSelectorView {
    const hintParts = ["←→ switch", "Enter select"];
    if (this.opts.onSessionOnlySelect !== undefined) {
      hintParts.push("Alt+S session-only");
    }
    hintParts.push("Esc cancel");

    return {
      title: this.opts.title ?? "Select thinking effort",
      hint: hintParts.join(" · "),
      warning: this.opts.warning,
      segments: this.opts.efforts.map((effort, index) => ({
        effort,
        label: effortLabel(effort),
        active: index === this.activeIndex,
      })),
    };
  }
}

export function createInkEffortSelectorSession(
  opts: EffortSelectorOptions,
): InkEffortSelectorSession {
  return new InkEffortSelectorSession(opts);
}

export function projectInkEffortSelectorView(
  session: InkEffortSelectorSession,
): InkEffortSelectorView {
  return session.projectView();
}

import { Key, matchesKey } from "@moonshot-ai/kimi-tui";

import type {
  UndoChoice,
  UndoSelectorOptions,
} from "#/tui/components/dialogs/undo-selector";
import { SearchableList } from "#/tui/utils/searchable-list";

const MAX_VISIBLE_CHOICES = 5;
const PREFERRED_SELECTED_OFFSET = 2;

export interface InkUndoSelectorRowView {
  readonly id: string;
  readonly label: string;
  readonly isSelected: boolean;
  readonly inUndoRange: boolean;
}

export interface InkUndoSelectorView {
  readonly title: string;
  readonly hint: string;
  readonly selectedIndex: number;
  readonly rows: readonly InkUndoSelectorRowView[];
}

export class InkUndoSelectorSession {
  private readonly opts: UndoSelectorOptions;
  private readonly list: SearchableList<UndoChoice>;
  private submitted = false;

  constructor(opts: UndoSelectorOptions) {
    this.opts = opts;
    this.list = new SearchableList({
      items: opts.choices,
      toSearchText: (choice) => choice.label,
      initialIndex: Math.max(0, opts.choices.length - 1),
    });
  }

  handleInput(
    data: string,
    callbacks: {
      readonly onSelect: (choice: UndoChoice) => void;
      readonly onCancel: () => void;
    },
  ): boolean {
    if (this.submitted) return true;
    if (matchesKey(data, Key.escape)) {
      callbacks.onCancel();
      return true;
    }
    if (this.list.handleKey(data)) return true;
    if (matchesKey(data, Key.enter)) {
      const selected = this.list.selected();
      if (selected !== undefined) {
        this.submitted = true;
        callbacks.onSelect(selected);
      }
      return true;
    }
    return true;
  }

  projectView(): InkUndoSelectorView {
    const view = this.list.view();
    const visibleCount = Math.min(MAX_VISIBLE_CHOICES, view.items.length);
    const maxStart = view.items.length - visibleCount;
    const start = Math.min(
      Math.max(0, view.selectedIndex - PREFERRED_SELECTED_OFFSET),
      maxStart,
    );
    const end = start + visibleCount;

    return {
      title: "Select messages to undo",
      hint: "↑↓ navigate · Enter select · Esc cancel",
      selectedIndex: view.selectedIndex,
      rows:
        view.items.length === 0
          ? []
          : view.items.slice(start, end).map((choice, offset) => {
              const index = start + offset;
              return {
                id: choice.id,
                label: choice.label,
                isSelected: index === view.selectedIndex,
                inUndoRange: index > view.selectedIndex,
              };
            }),
    };
  }
}

export function createInkUndoSelectorSession(
  opts: UndoSelectorOptions,
): InkUndoSelectorSession {
  return new InkUndoSelectorSession(opts);
}

export function projectInkUndoSelectorView(
  session: InkUndoSelectorSession,
): InkUndoSelectorView {
  return session.projectView();
}

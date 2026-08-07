import { Key, matchesKey } from "@moonshot-ai/kimi-tui";

import type {
  ChoiceOption,
  ChoicePickerOptions,
} from "#/tui/components/dialogs/choice-picker";
import { SearchableList } from "#/tui/utils/searchable-list";
import { printableChar } from "#/tui/utils/printable-key";

export interface InkChoicePickerView {
  readonly title: string;
  readonly hint: string | undefined;
  readonly notice: string | undefined;
  readonly noticeTone: "success" | "warning";
  readonly currentValue: string | undefined;
  readonly searchable: boolean;
  readonly query: string;
  readonly selectedIndex: number;
  readonly pageStart: number;
  readonly pageEnd: number;
  readonly pageCount: number;
  readonly options: readonly {
    readonly value: string;
    readonly label: string;
    readonly description?: string | undefined;
    readonly tone?: "danger";
    readonly descriptionTone?: string;
    readonly isCurrent: boolean;
  }[];
}

export function createInkChoicePickerList(
  opts: ChoicePickerOptions,
): SearchableList<ChoiceOption> {
  const currentIdx = opts.options.findIndex(
    (o) => o.value === opts.currentValue,
  );
  return new SearchableList({
    items: opts.options,
    toSearchText: (option) => `${option.label} ${option.description ?? ""}`,
    pageSize: opts.pageSize,
    initialIndex: Math.max(currentIdx, 0),
    searchable: opts.searchable === true,
  });
}

export function projectInkChoicePickerView(
  opts: ChoicePickerOptions,
  list: SearchableList<ChoiceOption>,
): InkChoicePickerView {
  const view = list.view();
  const navParts = ["↑↓ navigate"];
  if (view.page.pageCount > 1) navParts.push("←→ page");
  navParts.push("Enter select", "Esc cancel");
  return {
    title: opts.title,
    hint: opts.hint ?? navParts.join(" · "),
    notice: opts.notice,
    noticeTone: opts.noticeTone ?? "success",
    currentValue: opts.currentValue,
    searchable: opts.searchable === true,
    query: view.query,
    selectedIndex: view.selectedIndex,
    pageStart: view.page.start,
    pageEnd: view.page.end,
    pageCount: view.page.pageCount,
    options: view.items.map((option, index) => ({
      value: option.value,
      label: option.label,
      description: option.description,
      tone: option.tone,
      descriptionTone: option.descriptionTone,
      isCurrent: option.value === opts.currentValue,
    })),
  };
}

export function handleInkChoicePickerInput(
  opts: ChoicePickerOptions,
  list: SearchableList<ChoiceOption>,
  data: string,
  callbacks: {
    readonly onSelect: (value: string) => void;
    readonly onSessionOnlySelect?: (value: string) => void;
    readonly onCancel: () => void;
  },
): boolean {
  if (matchesKey(data, Key.escape)) {
    if (list.clearQuery()) return true;
    callbacks.onCancel();
    return true;
  }
  if (
    matchesKey(data, Key.alt("s")) &&
    callbacks.onSessionOnlySelect !== undefined
  ) {
    const chosen = list.selected();
    if (chosen !== undefined) callbacks.onSessionOnlySelect(chosen.value);
    return true;
  }
  if (matchesKey(data, Key.left)) {
    list.pageUp();
    return true;
  }
  if (matchesKey(data, Key.right)) {
    list.pageDown();
    return true;
  }
  const isSpace = matchesKey(data, Key.space) || printableChar(data) === " ";
  if (matchesKey(data, Key.enter) || (isSpace && opts.searchable !== true)) {
    const chosen = list.selected();
    if (chosen !== undefined) callbacks.onSelect(chosen.value);
    return true;
  }
  if (list.handleKey(data)) return true;
  return true;
}

import type { ThinkingEffort } from "@moonshot-ai/kimi-code-sdk";
import { Key, matchesKey } from "@moonshot-ai/kimi-tui";

import {
  commitModelEffort,
  createModelChoices,
  effortLabel,
  effortsOf,
  providerDisplayName,
  segmentsFor,
  thinkingAvailability,
  type ModelChoice,
  type ModelSelection,
  type ModelSelectorOptions,
} from "#/tui/components/dialogs/model-selector";
import type { TabbedModelSelectorOptions } from "#/tui/components/dialogs/tabbed-model-selector";
import { SearchableList } from "#/tui/utils/searchable-list";

export interface InkModelThinkingSegmentView {
  readonly label: string;
  readonly active: boolean;
  readonly unavailable: boolean;
}

export interface InkModelSelectorRowView {
  readonly alias: string;
  readonly name: string;
  readonly provider: string;
  readonly isCurrent: boolean;
}

export interface InkModelSelectorView {
  readonly title: string;
  readonly hint: string;
  readonly warning: string | undefined;
  readonly searchable: boolean;
  readonly query: string;
  readonly selectedIndex: number;
  readonly pageSelectedIndex: number;
  readonly pageStart: number;
  readonly pageEnd: number;
  readonly totalCount: number;
  readonly filteredCount: number;
  readonly belowCount: number;
  readonly rows: readonly InkModelSelectorRowView[];
  readonly thinkingHeader: string | undefined;
  readonly thinkingSegments: readonly InkModelThinkingSegmentView[];
  readonly tabs: readonly { readonly label: string; readonly active: boolean }[];
}

export class InkModelSelectorSession {
  private readonly opts: ModelSelectorOptions;
  private readonly list: SearchableList<ModelChoice>;
  private readonly thinkingOverrides = new Map<string, string>();

  constructor(opts: ModelSelectorOptions) {
    this.opts = opts;
    const choices = createModelChoices(opts.models);
    const selectedValue = opts.selectedValue ?? opts.currentValue;
    const selectedIdx = choices.findIndex(
      (choice) => choice.alias === selectedValue,
    );
    this.list = new SearchableList({
      items: choices,
      toSearchText: (choice) => choice.label,
      pageSize: opts.pageSize,
      initialIndex: Math.max(selectedIdx, 0),
      searchable: opts.searchable === true,
    });
  }

  handleInput(
    data: string,
    callbacks: {
      readonly onSelect: (selection: ModelSelection) => void;
      readonly onSessionOnlySelect?: (selection: ModelSelection) => void;
      readonly onCancel: () => void;
    },
  ): boolean {
    if (matchesKey(data, Key.escape)) {
      if (this.list.clearQuery()) return true;
      callbacks.onCancel();
      return true;
    }
    if (this.list.handleKey(data)) return true;
    if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
      this.adjustThinkingEffort(data);
      return true;
    }
    if (matchesKey(data, Key.enter)) {
      const selected = this.selectedChoice();
      if (selected === undefined) return true;
      callbacks.onSelect({
        alias: selected.alias,
        thinking: commitModelEffort(
          selected,
          this.effectiveEffort(selected) as ThinkingEffort,
        ),
      });
      return true;
    }
    if (
      matchesKey(data, Key.alt("s")) &&
      callbacks.onSessionOnlySelect !== undefined
    ) {
      const selected = this.selectedChoice();
      if (selected === undefined) return true;
      callbacks.onSessionOnlySelect({
        alias: selected.alias,
        thinking: commitModelEffort(
          selected,
          this.effectiveEffort(selected) as ThinkingEffort,
        ),
      });
      return true;
    }
    return true;
  }

  projectView(tabs: InkModelSelectorView["tabs"] = []): InkModelSelectorView {
    const searchable = this.opts.searchable === true;
    const view = this.list.view();
    const totalCount = Object.keys(this.opts.models).length;
    const hintParts: string[] = [];
    if (this.opts.providerSwitchHint) hintParts.push("Tab toggle provider");
    hintParts.push("↑↓ navigate");
    if (searchable && view.query.length > 0) hintParts.push("Backspace clear");
    hintParts.push("←→ thinking");
    hintParts.push("Enter select");
    if (this.opts.onSessionOnlySelect !== undefined) {
      hintParts.push("Alt+S session-only");
    }
    hintParts.push("Esc cancel");

    const selected = this.selectedChoice();
    const segments = selected === undefined ? [] : segmentsFor(selected.model);
    const thinkingHeader =
      selected === undefined
        ? undefined
        : segments.length > 1
          ? "Thinking (←→ to switch)"
          : "Thinking";

    return {
      title: this.opts.title ?? "Select a model",
      hint: hintParts.join(" · "),
      warning: this.opts.warning,
      searchable,
      query: view.query,
      selectedIndex: view.selectedIndex,
      pageSelectedIndex: Math.max(0, view.selectedIndex - view.page.start),
      pageStart: view.page.start,
      pageEnd: view.page.end,
      totalCount,
      filteredCount: view.items.length,
      belowCount: Math.max(0, view.items.length - view.page.end),
      rows: view.items
        .slice(view.page.start, view.page.end)
        .map((choice) => ({
          alias: choice.alias,
          name: choice.name,
          provider: choice.provider,
          isCurrent: choice.alias === this.opts.currentValue,
        })),
      thinkingHeader,
      thinkingSegments:
        selected === undefined
          ? []
          : this.projectThinkingSegments(selected),
      tabs,
    };
  }

  private selectedChoice(): ModelChoice | undefined {
    return this.list.selected();
  }

  private draftFor(choice: ModelChoice): string {
    const override = this.thinkingOverrides.get(choice.alias);
    if (override !== undefined) return override;
    if (choice.alias === this.opts.currentValue) {
      return this.opts.currentThinkingEffort;
    }
    const efforts = effortsOf(choice.model);
    if (efforts.length > 0) {
      const def =
        choice.model.defaultEffort ?? efforts[Math.floor(efforts.length / 2)];
      if (def !== undefined && efforts.includes(def)) return def;
      return efforts[0]!;
    }
    return thinkingAvailability(choice.model) !== "unsupported" ? "on" : "off";
  }

  private effectiveEffort(choice: ModelChoice): string {
    const draft = this.draftFor(choice);
    const segments = segmentsFor(choice.model);
    return segments.includes(draft) ? draft : segments[0]!;
  }

  private adjustThinkingEffort(data: string): void {
    const selected = this.selectedChoice();
    if (selected === undefined) return;
    const segments = segmentsFor(selected.model);
    if (segments.length <= 1) return;
    const current = this.effectiveEffort(selected);
    const idx = segments.indexOf(current);
    let next: number;
    if (segments.length === 2) {
      next = idx === 0 ? 1 : 0;
    } else {
      const delta = matchesKey(data, Key.left) ? -1 : 1;
      next = Math.max(0, Math.min(segments.length - 1, idx + delta));
    }
    if (next !== idx) {
      this.thinkingOverrides.set(selected.alias, segments[next]!);
    }
  }

  private projectThinkingSegments(
    choice: ModelChoice,
  ): readonly InkModelThinkingSegmentView[] {
    const efforts = effortsOf(choice.model);
    const availability = thinkingAvailability(choice.model);
    if (efforts.length === 0 && availability === "always-on") {
      return [
        { label: "On", active: true, unavailable: false },
        { label: "Off (Unsupported)", active: false, unavailable: true },
      ];
    }
    if (efforts.length === 0 && availability === "unsupported") {
      return [
        { label: "On (Unsupported)", active: false, unavailable: true },
        { label: "Off", active: true, unavailable: false },
      ];
    }
    const active = this.effectiveEffort(choice);
    return segmentsFor(choice.model).map((effort) => ({
      label: effortLabel(effort),
      active: effort === active,
      unavailable: false,
    }));
  }
}

interface InkModelTab {
  readonly id: string;
  readonly label: string;
  readonly session: InkModelSelectorSession;
}

export class InkTabbedModelSelectorSession {
  private readonly opts: TabbedModelSelectorOptions;
  private readonly tabs: readonly InkModelTab[];
  private activeIndex: number;

  constructor(opts: TabbedModelSelectorOptions) {
    this.opts = opts;
    this.tabs = buildInkModelTabs(opts);
    const initialTabIdx = opts.initialTabId
      ? this.tabs.findIndex((tab) => tab.id === opts.initialTabId)
      : -1;
    this.activeIndex = Math.max(initialTabIdx, 0);
  }

  handleInput(
    data: string,
    callbacks: {
      readonly onSelect: (selection: ModelSelection) => void;
      readonly onSessionOnlySelect?: (selection: ModelSelection) => void;
      readonly onCancel: () => void;
    },
  ): boolean {
    if (this.tabs.length > 1) {
      if (matchesKey(data, Key.tab)) {
        this.activeIndex = (this.activeIndex + 1) % this.tabs.length;
        return true;
      }
      if (matchesKey(data, Key.shift("tab"))) {
        this.activeIndex =
          (this.activeIndex - 1 + this.tabs.length) % this.tabs.length;
        return true;
      }
    }
    const active = this.tabs[this.activeIndex];
    if (active === undefined) return true;
    return active.session.handleInput(data, callbacks);
  }

  projectView(): InkModelSelectorView {
    const active = this.tabs[this.activeIndex];
    if (active === undefined) {
      return {
        title: this.opts.title ?? "Select a model",
        hint: "",
        warning: this.opts.warning,
        searchable: true,
        query: "",
        selectedIndex: 0,
        pageSelectedIndex: 0,
        pageStart: 0,
        pageEnd: 0,
        totalCount: 0,
        filteredCount: 0,
        belowCount: 0,
        rows: [],
        thinkingHeader: undefined,
        thinkingSegments: [],
        tabs: [],
      };
    }
    const tabs =
      this.tabs.length <= 1
        ? []
        : this.tabs.map((tab, index) => ({
            label: tab.label,
            active: index === this.activeIndex,
          }));
    return active.session.projectView(tabs);
  }
}

const ALL_TAB_ID = "all";
const ALL_TAB_LABEL = "All";

function buildInkModelTabs(
  opts: TabbedModelSelectorOptions,
): readonly InkModelTab[] {
  const entries = Object.entries(opts.models);
  const providerIds: string[] = [];
  const seen = new Set<string>();
  for (const [, model] of entries) {
    const provider = model.provider;
    if (!seen.has(provider)) {
      seen.add(provider);
      providerIds.push(provider);
    }
  }

  const tabs: InkModelTab[] = [
    {
      id: ALL_TAB_ID,
      label: ALL_TAB_LABEL,
      session: new InkModelSelectorSession(
        makeInnerModelSelectorOptions(opts, opts.models),
      ),
    },
  ];
  for (const providerId of providerIds) {
    const subset: TabbedModelSelectorOptions["models"] = {};
    for (const [alias, model] of entries) {
      if (model.provider === providerId) subset[alias] = model;
    }
    tabs.push({
      id: providerId,
      label: providerDisplayName(providerId),
      session: new InkModelSelectorSession(
        makeInnerModelSelectorOptions(opts, subset),
      ),
    });
  }
  return tabs;
}

function makeInnerModelSelectorOptions(
  opts: TabbedModelSelectorOptions,
  subset: TabbedModelSelectorOptions["models"],
): ModelSelectorOptions {
  const candidate = opts.selectedValue ?? opts.currentValue;
  const selectedValue = subset[candidate] !== undefined ? candidate : undefined;
  return {
    models: subset,
    currentValue: opts.currentValue,
    ...(selectedValue !== undefined ? { selectedValue } : {}),
    currentThinkingEffort: opts.currentThinkingEffort,
    title: opts.title,
    searchable: true,
    providerSwitchHint: true,
    warning: opts.warning,
    onSelect: opts.onSelect,
    onSessionOnlySelect: opts.onSessionOnlySelect,
    onCancel: opts.onCancel,
  };
}

export function createInkModelSelectorSession(
  opts: ModelSelectorOptions,
): InkModelSelectorSession {
  return new InkModelSelectorSession(opts);
}

export function createInkTabbedModelSelectorSession(
  opts: TabbedModelSelectorOptions,
): InkTabbedModelSelectorSession {
  return new InkTabbedModelSelectorSession(opts);
}

export function projectInkModelSelectorView(
  session: InkModelSelectorSession | InkTabbedModelSelectorSession,
): InkModelSelectorView {
  return session.projectView();
}

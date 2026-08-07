import type { ExperimentalFeatureState } from "@moonshot-ai/kimi-code-sdk";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@moonshot-ai/kimi-tui";

import {
  type ExperimentalFeatureDraftChange,
  type ExperimentsSelectorOptions,
} from "#/tui/components/dialogs/experiments-selector";
import { printableChar } from "#/tui/utils/printable-key";
import { SearchableList } from "#/tui/utils/searchable-list";

const ELLIPSIS = "…";

export interface InkExperimentsFeatureRowView {
  readonly id: ExperimentalFeatureState["id"];
  readonly title: string;
  readonly selected: boolean;
  readonly enabled: boolean;
  readonly modified: boolean;
  readonly locked: boolean;
  readonly detail: string;
  readonly descriptionLines: readonly string[];
}

export interface InkExperimentsSelectorView {
  readonly title: string;
  readonly hint: string;
  readonly searchable: boolean;
  readonly query: string;
  readonly selectedIndex: number;
  readonly pageStart: number;
  readonly pageEnd: number;
  readonly pageCount: number;
  readonly filteredCount: number;
  readonly totalCount: number;
  readonly belowCount: number;
  readonly rows: readonly InkExperimentsFeatureRowView[];
  readonly applyLabel: string;
  readonly applySummary: string;
  readonly applyEnabled: boolean;
}

export class InkExperimentsSelectorSession {
  private readonly opts: ExperimentsSelectorOptions;
  private readonly list: SearchableList<ExperimentalFeatureState>;
  private readonly draft = new Map<ExperimentalFeatureState["id"], boolean>();

  constructor(opts: ExperimentsSelectorOptions) {
    this.opts = opts;
    this.list = new SearchableList({
      items: opts.features,
      toSearchText: (feature) =>
        `${feature.title} ${feature.id} ${feature.description}`,
      searchable: true,
    });
  }

  handleInput(
    data: string,
    callbacks: {
      readonly onApply: (
        changes: readonly ExperimentalFeatureDraftChange[],
      ) => void;
      readonly onCancel: () => void;
    },
  ): boolean {
    if (matchesKey(data, Key.escape)) {
      if (this.list.clearQuery()) return true;
      callbacks.onCancel();
      return true;
    }
    if (matchesKey(data, Key.enter)) {
      const changes = this.draftChanges();
      if (changes.length > 0) callbacks.onApply(changes);
      return true;
    }
    const decoded = printableChar(data);
    if (matchesKey(data, Key.space) || decoded === " ") {
      const selected = this.list.selected();
      if (selected !== undefined) this.toggleDraft(selected);
      return true;
    }
    if (this.list.handleKey(data)) return true;
    return true;
  }

  projectView(width = 120): InkExperimentsSelectorView {
    const view = this.list.view();
    const hintParts = ["↑↓ navigate"];
    if (view.page.pageCount > 1) hintParts.push("PgUp/PgDn page");
    hintParts.push("Space toggle", "Enter apply", "Esc cancel");
    if (view.query.length > 0) hintParts.push("Backspace clear");

    const changes = this.draftChanges();
    const count = changes.length;
    const applySummary =
      count === 0
        ? "no changes"
        : `${String(count)} ${count === 1 ? "change" : "changes"}`;

    const descriptionWidth = Math.max(1, width - 4);
    const rows: InkExperimentsFeatureRowView[] = [];
    for (let i = view.page.start; i < view.page.end; i++) {
      const feature = view.items[i];
      if (feature === undefined) continue;
      const enabled = this.effectiveEnabled(feature);
      const modified = this.isDraftChanged(feature);
      rows.push({
        id: feature.id,
        title: feature.title,
        selected: i === view.selectedIndex,
        enabled,
        modified,
        locked: isLocked(feature),
        detail: modified
          ? `${featureDetail(feature)} · modified`
          : featureDetail(feature),
        descriptionLines: wrapText(feature.description, descriptionWidth),
      });
    }

    return {
      title: "Experimental features",
      hint: hintParts.join(" · "),
      searchable: true,
      query: view.query,
      selectedIndex: view.selectedIndex,
      pageStart: view.page.start,
      pageEnd: view.page.end,
      pageCount: view.page.pageCount,
      filteredCount: view.items.length,
      totalCount: this.opts.features.length,
      belowCount: Math.max(0, view.items.length - view.page.end),
      rows,
      applyLabel: "[ Apply changes and reload ]",
      applySummary,
      applyEnabled: count > 0,
    };
  }

  private toggleDraft(feature: ExperimentalFeatureState): void {
    if (isLocked(feature)) return;

    const enabled = !this.effectiveEnabled(feature);
    if (enabled === feature.enabled) {
      this.draft.delete(feature.id);
      return;
    }
    this.draft.set(feature.id, enabled);
  }

  private effectiveEnabled(feature: ExperimentalFeatureState): boolean {
    return this.draft.get(feature.id) ?? feature.enabled;
  }

  private isDraftChanged(feature: ExperimentalFeatureState): boolean {
    return this.effectiveEnabled(feature) !== feature.enabled;
  }

  private draftChanges(): ExperimentalFeatureDraftChange[] {
    const changes: ExperimentalFeatureDraftChange[] = [];
    for (const feature of this.opts.features) {
      if (this.isDraftChanged(feature)) {
        changes.push({
          id: feature.id,
          enabled: this.effectiveEnabled(feature),
        });
      }
    }
    return changes;
  }
}

function isLocked(feature: ExperimentalFeatureState): boolean {
  return feature.source === "env" || feature.source === "master-env";
}

function featureDetail(feature: ExperimentalFeatureState): string {
  const source = sourceLabel(feature);
  if (feature.source === "env" || feature.source === "master-env") {
    return `id ${feature.id} · ${source}`;
  }
  return `id ${feature.id} · ${source} · ${feature.env}`;
}

function sourceLabel(feature: ExperimentalFeatureState): string {
  switch (feature.source) {
    case "master-env":
      return "locked by KIMI_CODE_EXPERIMENTAL_FLAG";
    case "env":
      return `locked by ${feature.env}`;
    case "config":
      return "config";
    case "default":
      return "default";
  }
}

function wrapText(text: string, width: number): string[] {
  const maxWidth = Math.max(1, width);
  const words = text
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (visibleWidth(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current.length > 0) lines.push(current);
    current =
      visibleWidth(word) <= maxWidth
        ? word
        : truncateToWidth(word, maxWidth, ELLIPSIS);
  }

  if (current.length > 0) lines.push(current);
  return lines;
}

export function createInkExperimentsSelectorSession(
  opts: ExperimentsSelectorOptions,
): InkExperimentsSelectorSession {
  return new InkExperimentsSelectorSession(opts);
}

export function projectInkExperimentsSelectorView(
  session: InkExperimentsSelectorSession,
  width = 120,
): InkExperimentsSelectorView {
  return session.projectView(width);
}

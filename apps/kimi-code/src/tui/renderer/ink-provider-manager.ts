import { Key, matchesKey } from "@moonshot-ai/kimi-tui";

import {
  buildProviderManagerRows,
  PROVIDER_MANAGER_HEADER_HINT,
  PROVIDER_MANAGER_PAGE_SIZE,
  type ProviderManagerOptions,
  type ProviderManagerRow,
} from "#/tui/components/dialogs/provider-manager";
import { printableChar } from "#/tui/utils/printable-key";
import { pageView } from "#/tui/utils/paging";

export interface InkProviderManagerRowView {
  readonly kind: "source" | "add";
  readonly label: string;
  readonly baseUrl: string | undefined;
  readonly hasActive: boolean;
  readonly selected: boolean;
}

export interface InkProviderManagerView {
  readonly title: string;
  readonly hint: string;
  readonly rows: readonly InkProviderManagerRowView[];
  readonly empty: boolean;
  readonly confirmPrompt: string | undefined;
  readonly pageLabel: string | undefined;
}

interface ConfirmState {
  readonly label: string;
  readonly providerIds: readonly string[];
}

export class InkProviderManagerSession {
  private readonly opts: ProviderManagerOptions;
  private rows: readonly ProviderManagerRow[];
  private selectedIndex: number;
  private confirm: ConfirmState | undefined;

  constructor(opts: ProviderManagerOptions) {
    this.opts = opts;
    this.rows = buildProviderManagerRows(opts);
    const activeIdx = opts.activeProviderId
      ? this.rows.findIndex(
          (row) =>
            row.kind === "source" &&
            row.providerIds.includes(opts.activeProviderId ?? ""),
        )
      : -1;
    this.selectedIndex = Math.max(activeIdx, 0);
    this.confirm = undefined;
  }

  handleInput(
    data: string,
    callbacks: {
      readonly onAdd: () => void;
      readonly onDeleteSource: (providerIds: readonly string[]) => void;
      readonly onClose: () => void;
    },
  ): boolean {
    if (this.confirm !== undefined) {
      return this.handleConfirmInput(data, callbacks);
    }

    if (matchesKey(data, Key.escape)) {
      callbacks.onClose();
      return true;
    }

    const rows = this.rows;

    if (matchesKey(data, Key.up)) {
      if (rows.length === 0) return true;
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return true;
    }
    if (matchesKey(data, Key.down)) {
      if (rows.length === 0) return true;
      this.selectedIndex = Math.min(rows.length - 1, this.selectedIndex + 1);
      return true;
    }

    if (matchesKey(data, Key.left) || matchesKey(data, Key.pageUp)) {
      if (rows.length === 0) return true;
      this.selectedIndex = Math.max(
        0,
        this.selectedIndex - PROVIDER_MANAGER_PAGE_SIZE,
      );
      return true;
    }
    if (matchesKey(data, Key.right) || matchesKey(data, Key.pageDown)) {
      if (rows.length === 0) return true;
      this.selectedIndex = Math.min(
        rows.length - 1,
        this.selectedIndex + PROVIDER_MANAGER_PAGE_SIZE,
      );
      return true;
    }

    if (matchesKey(data, Key.enter)) {
      const selected = rows[this.selectedIndex];
      if (selected?.kind === "add") {
        callbacks.onAdd();
      }
      return true;
    }

    const ch = printableChar(data);
    if (ch === "d" || ch === "D") {
      this.armDeleteConfirm();
      return true;
    }
    return true;
  }

  projectView(): InkProviderManagerView {
    const view = pageView(
      this.rows.length,
      this.selectedIndex,
      PROVIDER_MANAGER_PAGE_SIZE,
    );
    const visibleRows = this.rows
      .slice(view.start, view.end)
      .map((row, offset) => ({
        kind: row.kind,
        label: row.label,
        baseUrl: row.kind === "source" ? row.baseUrl : undefined,
        hasActive: row.kind === "source" ? row.hasActive : false,
        selected: view.start + offset === this.selectedIndex,
      }));

    return {
      title: "Providers",
      hint: PROVIDER_MANAGER_HEADER_HINT,
      rows: visibleRows,
      empty: this.rows.length === 0,
      confirmPrompt:
        this.confirm === undefined ? undefined : `${this.confirm.label} [y/N]`,
      pageLabel:
        this.confirm !== undefined || view.pageCount <= 1
          ? undefined
          : `Page ${String(view.page + 1)}/${String(view.pageCount)}`,
    };
  }

  private armDeleteConfirm(): void {
    const selected = this.rows[this.selectedIndex];
    if (selected === undefined || selected.kind === "add") return;
    const ids = selected.providerIds;
    const prompt =
      ids.length === 1
        ? `Delete platform "${selected.label}"?`
        : `Delete platform "${selected.label}" and all ${String(ids.length)} providers?`;
    this.confirm = {
      label: prompt,
      providerIds: ids,
    };
  }

  private handleConfirmInput(
    data: string,
    callbacks: {
      readonly onDeleteSource: (providerIds: readonly string[]) => void;
    },
  ): boolean {
    const k = printableChar(data);
    if (matchesKey(data, Key.escape) || k === "n" || k === "N") {
      this.confirm = undefined;
      return true;
    }
    if (k === "y" || k === "Y") {
      const confirm = this.confirm;
      this.confirm = undefined;
      if (confirm !== undefined) {
        callbacks.onDeleteSource(confirm.providerIds);
      }
      return true;
    }
    return true;
  }
}

export function createInkProviderManagerSession(
  opts: ProviderManagerOptions,
): InkProviderManagerSession {
  return new InkProviderManagerSession(opts);
}

export function projectInkProviderManagerView(
  session: InkProviderManagerSession,
): InkProviderManagerView {
  return session.projectView();
}

import type { Component, Focusable } from "@moonshot-ai/kimi-tui";

import {
  ChoicePickerComponent,
  type ChoiceOption,
  type ChoicePickerOptions,
} from "#/tui/components/dialogs/choice-picker";
import { EffortSelectorComponent } from "#/tui/components/dialogs/effort-selector";
import type { EffortSelectorOptions } from "#/tui/components/dialogs/effort-selector";
import {
  ExperimentsSelectorComponent,
  type ExperimentalFeatureDraftChange,
  type ExperimentsSelectorOptions,
} from "#/tui/components/dialogs/experiments-selector";
import { ModelSelectorComponent } from "#/tui/components/dialogs/model-selector";
import type { ModelSelectorOptions } from "#/tui/components/dialogs/model-selector";
import { TabbedModelSelectorComponent } from "#/tui/components/dialogs/tabbed-model-selector";
import type { TabbedModelSelectorOptions } from "#/tui/components/dialogs/tabbed-model-selector";
import { UndoSelectorComponent } from "#/tui/components/dialogs/undo-selector";
import type { UndoSelectorOptions } from "#/tui/components/dialogs/undo-selector";
import {
  createInkChoicePickerList,
  handleInkChoicePickerInput,
  projectInkChoicePickerView,
  type InkChoicePickerView,
} from "#/tui/renderer/ink/sessions/choice-picker";
import {
  createInkEffortSelectorSession,
  type InkEffortSelectorSession,
  projectInkEffortSelectorView,
  type InkEffortSelectorView,
} from "#/tui/renderer/ink/sessions/effort-selector";
import {
  createInkExperimentsSelectorSession,
  type InkExperimentsSelectorSession,
  projectInkExperimentsSelectorView,
  type InkExperimentsSelectorView,
} from "#/tui/renderer/ink/sessions/experiments-selector";
import {
  createInkModelSelectorSession,
  createInkTabbedModelSelectorSession,
  type InkModelSelectorSession,
  type InkTabbedModelSelectorSession,
  projectInkModelSelectorView,
  type InkModelSelectorView,
} from "#/tui/renderer/ink/sessions/model-selector";
import {
  createInkUndoSelectorSession,
  type InkUndoSelectorSession,
  projectInkUndoSelectorView,
  type InkUndoSelectorView,
} from "#/tui/renderer/ink/sessions/undo-selector";
import { SearchableList } from "../utils/searchable-list";
import type { InkDialogsControllerHost } from "./ink-dialogs";

/** Model / effort / undo / experiments / choice Ink dialog sessions. */
export class InkDialogsSelectors {
  private inkChoicePickerOptions: ChoicePickerOptions | null = null;
  private inkChoicePickerList: SearchableList<ChoiceOption> | null = null;
  private inkModelSelector:
    | {
        readonly kind: "flat";
        readonly session: InkModelSelectorSession;
        readonly opts: ModelSelectorOptions;
      }
    | {
        readonly kind: "tabbed";
        readonly session: InkTabbedModelSelectorSession;
        readonly opts: TabbedModelSelectorOptions;
      }
    | null = null;
  private inkEffortSelector: {
    readonly session: InkEffortSelectorSession;
    readonly opts: EffortSelectorOptions;
  } | null = null;
  private inkUndoSelector: {
    readonly session: InkUndoSelectorSession;
    readonly opts: UndoSelectorOptions;
  } | null = null;
  private inkExperimentsSelector: {
    readonly session: InkExperimentsSelectorSession;
    readonly opts: ExperimentsSelectorOptions;
  } | null = null;

  constructor(private readonly host: InkDialogsControllerHost) {}

  closeAll(): void {
    this.closeInkChoicePicker();
    this.closeInkModelSelector();
    this.closeInkEffortSelector();
    this.closeInkUndoSelector();
    this.closeInkExperimentsSelector();
  }

  tryOpenFromPanel(panel: Component & Focusable): boolean {
    if (panel instanceof TabbedModelSelectorComponent) {
      this.openInkTabbedModelSelector(panel.getTabbedModelSelectorOptions());
      return true;
    }
    if (panel instanceof ModelSelectorComponent) {
      this.openInkModelSelector(panel.getModelSelectorOptions());
      return true;
    }
    if (panel instanceof EffortSelectorComponent) {
      this.openInkEffortSelector(panel.getEffortSelectorOptions());
      return true;
    }
    if (panel instanceof UndoSelectorComponent) {
      this.openInkUndoSelector(panel.getUndoSelectorOptions());
      return true;
    }
    if (panel instanceof ExperimentsSelectorComponent) {
      this.openInkExperimentsSelector(panel.getExperimentsSelectorOptions());
      return true;
    }
    if (panel instanceof ChoicePickerComponent) {
      this.openInkChoicePicker(panel.getChoicePickerOptions());
      return true;
    }
    return false;
  }

  projectFields(): {
    choicePicker: InkChoicePickerView | null;
    modelSelector: InkModelSelectorView | null;
    effortSelector: InkEffortSelectorView | null;
    undoSelector: InkUndoSelectorView | null;
    experimentsSelector: InkExperimentsSelectorView | null;
  } {
    return {
      choicePicker:
        this.inkChoicePickerOptions === null ||
        this.inkChoicePickerList === null
          ? null
          : projectInkChoicePickerView(
              this.inkChoicePickerOptions,
              this.inkChoicePickerList,
            ),
      modelSelector:
        this.inkModelSelector === null
          ? null
          : projectInkModelSelectorView(this.inkModelSelector.session),
      effortSelector:
        this.inkEffortSelector === null
          ? null
          : projectInkEffortSelectorView(this.inkEffortSelector.session),
      undoSelector:
        this.inkUndoSelector === null
          ? null
          : projectInkUndoSelectorView(this.inkUndoSelector.session),
      experimentsSelector:
        this.inkExperimentsSelector === null
          ? null
          : projectInkExperimentsSelectorView(
              this.inkExperimentsSelector.session,
            ),
    };
  }

  handleDialogInput(data: string): boolean {
    const dialog = this.host.state.activeDialog;
    if (dialog === "choice-picker") {
      return this.handleInkChoicePickerInput(data);
    }
    if (dialog === "model-selector") {
      return this.handleInkModelSelectorInput(data);
    }
    if (dialog === "effort-selector") {
      return this.handleInkEffortSelectorInput(data);
    }
    if (dialog === "undo-selector") {
      return this.handleInkUndoSelectorInput(data);
    }
    if (dialog === "experiments-selector") {
      return this.handleInkExperimentsSelectorInput(data);
    }
    return false;
  }

  handleInkChoicePickerInput(data: string): boolean {
    const opts = this.inkChoicePickerOptions;
    const list = this.inkChoicePickerList;
    if (opts === null || list === null) return false;
    const consumed = handleInkChoicePickerInput(opts, list, data, {
      onSelect: (value) => {
        this.closeInkChoicePicker();
        opts.onSelect(value);
      },
      onSessionOnlySelect: opts.onSessionOnlySelect,
      onCancel: () => {
        this.closeInkChoicePicker();
        opts.onCancel();
      },
    });
    if (consumed) {
      this.host.updateInkRenderer();
    }
    return consumed;
  }

  private openInkChoicePicker(opts: ChoicePickerOptions): void {
    this.closeInkChoicePicker();
    this.inkChoicePickerOptions = opts;
    this.inkChoicePickerList = createInkChoicePickerList(opts);
    this.host.state.activeDialog = "choice-picker";
    this.host.updateInkRenderer();
  }

  private closeInkChoicePicker(): void {
    this.inkChoicePickerOptions = null;
    this.inkChoicePickerList = null;
    if (this.host.state.activeDialog === "choice-picker") {
      this.host.state.activeDialog = null;
    }
  }

  private handleInkModelSelectorInput(data: string): boolean {
    const handle = this.inkModelSelector;
    if (handle === null) return false;
    const callbacks = {
      onSelect: (selection: { alias: string; thinking: string }) => {
        this.closeInkModelSelector();
        if (handle.kind === "flat") {
          handle.opts.onSelect(selection);
          return;
        }
        handle.opts.onSelect(selection);
      },
      onSessionOnlySelect:
        handle.kind === "flat"
          ? handle.opts.onSessionOnlySelect
          : handle.opts.onSessionOnlySelect,
      onCancel: () => {
        this.closeInkModelSelector();
        if (handle.kind === "flat") {
          handle.opts.onCancel();
          return;
        }
        handle.opts.onCancel();
      },
    };
    const consumed =
      handle.kind === "flat"
        ? handle.session.handleInput(data, callbacks)
        : handle.session.handleInput(data, callbacks);
    if (consumed) {
      this.host.updateInkRenderer();
    }
    return consumed;
  }

  private openInkModelSelector(opts: ModelSelectorOptions): void {
    this.closeInkModelSelector();
    this.inkModelSelector = {
      kind: "flat",
      session: createInkModelSelectorSession(opts),
      opts,
    };
    this.host.state.activeDialog = "model-selector";
    this.host.updateInkRenderer();
  }

  private openInkTabbedModelSelector(opts: TabbedModelSelectorOptions): void {
    this.closeInkModelSelector();
    this.inkModelSelector = {
      kind: "tabbed",
      session: createInkTabbedModelSelectorSession(opts),
      opts,
    };
    this.host.state.activeDialog = "model-selector";
    this.host.updateInkRenderer();
  }

  private closeInkModelSelector(): void {
    this.inkModelSelector = null;
    if (this.host.state.activeDialog === "model-selector") {
      this.host.state.activeDialog = null;
    }
  }

  private handleInkEffortSelectorInput(data: string): boolean {
    const handle = this.inkEffortSelector;
    if (handle === null) return false;
    const callbacks = {
      onSelect: (effort: EffortSelectorOptions["efforts"][number]) => {
        this.closeInkEffortSelector();
        handle.opts.onSelect(effort);
      },
      onSessionOnlySelect: handle.opts.onSessionOnlySelect,
      onCancel: () => {
        this.closeInkEffortSelector();
        handle.opts.onCancel();
      },
    };
    const consumed = handle.session.handleInput(data, callbacks);
    if (consumed) {
      this.host.updateInkRenderer();
    }
    return consumed;
  }

  private openInkEffortSelector(opts: EffortSelectorOptions): void {
    this.closeInkEffortSelector();
    this.inkEffortSelector = {
      session: createInkEffortSelectorSession(opts),
      opts,
    };
    this.host.state.activeDialog = "effort-selector";
    this.host.updateInkRenderer();
  }

  private closeInkEffortSelector(): void {
    this.inkEffortSelector = null;
    if (this.host.state.activeDialog === "effort-selector") {
      this.host.state.activeDialog = null;
    }
  }

  private handleInkUndoSelectorInput(data: string): boolean {
    const handle = this.inkUndoSelector;
    if (handle === null) return false;
    const callbacks = {
      onSelect: (choice: UndoSelectorOptions["choices"][number]) => {
        this.closeInkUndoSelector();
        handle.opts.onSelect(choice);
      },
      onCancel: () => {
        this.closeInkUndoSelector();
        handle.opts.onCancel();
      },
    };
    const consumed = handle.session.handleInput(data, callbacks);
    if (consumed) {
      this.host.updateInkRenderer();
    }
    return consumed;
  }

  private openInkUndoSelector(opts: UndoSelectorOptions): void {
    this.closeInkUndoSelector();
    this.inkUndoSelector = {
      session: createInkUndoSelectorSession(opts),
      opts,
    };
    this.host.state.activeDialog = "undo-selector";
    this.host.updateInkRenderer();
  }

  private closeInkUndoSelector(): void {
    this.inkUndoSelector = null;
    if (this.host.state.activeDialog === "undo-selector") {
      this.host.state.activeDialog = null;
    }
  }

  private handleInkExperimentsSelectorInput(data: string): boolean {
    const handle = this.inkExperimentsSelector;
    if (handle === null) return false;
    const callbacks = {
      onApply: (changes: readonly ExperimentalFeatureDraftChange[]) => {
        handle.opts.onApply(changes);
      },
      onCancel: () => {
        this.closeInkExperimentsSelector();
        handle.opts.onCancel();
      },
    };
    const consumed = handle.session.handleInput(data, callbacks);
    if (consumed) {
      this.host.updateInkRenderer();
    }
    return consumed;
  }

  private openInkExperimentsSelector(opts: ExperimentsSelectorOptions): void {
    this.closeInkExperimentsSelector();
    this.inkExperimentsSelector = {
      session: createInkExperimentsSelectorSession(opts),
      opts,
    };
    this.host.state.activeDialog = "experiments-selector";
    this.host.updateInkRenderer();
  }

  private closeInkExperimentsSelector(): void {
    this.inkExperimentsSelector = null;
    if (this.host.state.activeDialog === "experiments-selector") {
      this.host.state.activeDialog = null;
    }
  }
}

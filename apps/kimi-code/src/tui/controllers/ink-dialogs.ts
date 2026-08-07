import type { Component, Focusable } from "@moonshot-ai/kimi-tui";
import { Key, matchesKey } from "@moonshot-ai/kimi-tui";

import type { ApprovalPreviewBlock } from "#/tui/components/dialogs/approval-preview-body";
import type { SessionRow } from "#/tui/components/dialogs/session-picker";
import {
  approvalPreviewMaxScroll,
  approvalPreviewViewableRows,
  buildApprovalPreviewBody,
  findApprovalPreviewBlock,
} from "#/tui/components/dialogs/approval-preview-body";
import type { InkChoicePickerView } from "#/tui/renderer/ink/sessions/choice-picker";
import type { InkCustomRegistryImportView } from "#/tui/renderer/ink/sessions/custom-registry-import";
import type { InkEffortSelectorView } from "#/tui/renderer/ink/sessions/effort-selector";
import type { InkExperimentsSelectorView } from "#/tui/renderer/ink/sessions/experiments-selector";
import type { InkGoalQueueEditView } from "#/tui/renderer/ink/sessions/goal-queue-edit";
import type { InkGoalQueueManagerView } from "#/tui/renderer/ink/sessions/goal-queue-manager";
import type { InkSingleLineInputView } from "#/tui/renderer/ink/sessions/input-single-line";
import type { InkModelSelectorView } from "#/tui/renderer/ink/sessions/model-selector";
import type { InkPluginMcpSelectorView } from "#/tui/renderer/ink/sessions/plugin-mcp-selector";
import type { InkPluginsPanelView } from "#/tui/renderer/ink/sessions/plugins-panel";
import type { InkProviderManagerView } from "#/tui/renderer/ink/sessions/provider-manager";
import type { InkStartPermissionPromptView } from "#/tui/renderer/ink/sessions/start-permission-prompt";
import type { InkUndoSelectorView } from "#/tui/renderer/ink/sessions/undo-selector";
import type { InkQuestionWizardView } from "#/tui/renderer/ink/question-wizard";
import type { TerminalApprovalPreviewView } from "#/tui/renderer/terminal-view-state";
import { adaptPanelResponse } from "#/tui/reverse-rpc/approval/adapter";
import type { ApprovalController } from "#/tui/reverse-rpc/approval/controller";
import type { QuestionController } from "#/tui/reverse-rpc/question/controller";
import type { TUIState } from "../tui-state";
import { isPrintableChar, printableChar } from "../utils/printable-key";
import { InkDialogsPanels } from "./ink-dialogs-panels";
import { InkDialogsSelectors } from "./ink-dialogs-selectors";

export interface InkDialogsHost {
  readonly state: TUIState;
  readonly approvalController: ApprovalController;
  readonly questionController: QuestionController;
  updateInkRenderer(): void;
  hideHelpPanel(): void;
  resolveTrustPrompt(choice: "trust" | "distrust"): void;
  cancelSessionPicker(): void;
  selectSessionPickerRow(session: SessionRow): void;
  toggleSessionPickerScope(sessionId: string): void;
}

export type InkDialogsControllerHost = InkDialogsHost;

export interface InkDialogProjection {
  dialogSelectedIndex: number;
  dialogScrollTop: number;
  approvalFeedbackMode: boolean;
  approvalFeedbackText: string;
  questionWizard: InkQuestionWizardView | null;
  choicePicker: InkChoicePickerView | null;
  modelSelector: InkModelSelectorView | null;
  effortSelector: InkEffortSelectorView | null;
  undoSelector: InkUndoSelectorView | null;
  experimentsSelector: InkExperimentsSelectorView | null;
  pluginMcpSelector: InkPluginMcpSelectorView | null;
  pluginsPanel: InkPluginsPanelView | null;
  startPermissionPrompt: InkStartPermissionPromptView | null;
  goalQueueManager: InkGoalQueueManagerView | null;
  goalQueueEdit: InkGoalQueueEditView | null;
  providerManager: InkProviderManagerView | null;
  apiKeyInput: InkSingleLineInputView | null;
  feedbackInput: InkSingleLineInputView | null;
  customRegistryImport: InkCustomRegistryImportView | null;
  approvalPreview: TerminalApprovalPreviewView | null;
}

/** Routes Ink overlay dialogs to selector and panel handlers. */
export class InkDialogsController implements InkDialogsControllerHost {
  private readonly selectors: InkDialogsSelectors;
  private readonly panels: InkDialogsPanels;

  constructor(private readonly host: InkDialogsHost) {
    const controllerHost: InkDialogsControllerHost = this;
    this.selectors = new InkDialogsSelectors(controllerHost);
    this.panels = new InkDialogsPanels(controllerHost);
  }

  get state(): TUIState {
    return this.host.state;
  }

  get approvalController(): ApprovalController {
    return this.host.approvalController;
  }

  get questionController(): QuestionController {
    return this.host.questionController;
  }

  private get inkOverlay() {
    return this.host.state.inkOverlay;
  }

  updateInkRenderer(): void {
    this.host.updateInkRenderer();
  }

  hideHelpPanel(): void {
    this.host.hideHelpPanel();
  }

  resolveTrustPrompt(choice: "trust" | "distrust"): void {
    this.host.resolveTrustPrompt(choice);
  }

  cancelSessionPicker(): void {
    this.host.cancelSessionPicker();
  }

  selectSessionPickerRow(session: SessionRow): void {
    this.host.selectSessionPickerRow(session);
  }

  toggleSessionPickerScope(sessionId: string): void {
    this.host.toggleSessionPickerScope(sessionId);
  }

  handleApprovalPreviewInput(data: string): boolean {
    if (this.inkOverlay.approvalPreviewBlock === null) return false;
    const rows = this.host.state.terminal.rows;
    const viewable = approvalPreviewViewableRows(rows);
    const printable = printableChar(data);

    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl("e")) ||
      printable === "q" ||
      printable === "Q"
    ) {
      this.closeApprovalPreview();
      return true;
    }
    if (matchesKey(data, Key.up) || printable === "k") {
      this.scrollInkApprovalPreview(-1, viewable);
      return true;
    }
    if (matchesKey(data, Key.down) || printable === "j") {
      this.scrollInkApprovalPreview(1, viewable);
      return true;
    }
    if (matchesKey(data, Key.pageUp) || printable === " " || data === "\x02") {
      this.scrollInkApprovalPreview(-Math.max(1, viewable - 1), viewable);
      return true;
    }
    if (matchesKey(data, Key.pageDown) || data === "\x06") {
      this.scrollInkApprovalPreview(Math.max(1, viewable - 1), viewable);
      return true;
    }
    if (matchesKey(data, Key.home) || printable === "g") {
      this.inkOverlay.approvalPreviewScrollTop = 0;
      this.host.updateInkRenderer();
      return true;
    }
    if (matchesKey(data, Key.end) || printable === "G") {
      const lineCount = buildApprovalPreviewBody(
        this.inkOverlay.approvalPreviewBlock,
      ).lines.length;
      this.inkOverlay.approvalPreviewScrollTop = approvalPreviewMaxScroll(
        lineCount,
        viewable,
      );
      this.host.updateInkRenderer();
      return true;
    }
    return true;
  }

  handleDialogInput(data: string): boolean {
    if (this.host.state.livePane.pendingApproval !== null) {
      return this.handleInkApprovalInput(data);
    }
    if (this.host.state.livePane.pendingQuestion !== null) {
      return this.panels.handlePendingQuestionInput(data);
    }
    const dialog = this.host.state.activeDialog;
    if (dialog === "help") {
      return this.handleHelpDialogInput(data);
    }
    if (this.selectors.handleDialogInput(data)) return true;
    if (this.panels.handleDialogInput(data)) return true;
    if (dialog !== "trust-prompt" && dialog !== "session-picker") return false;
    return this.handleTrustOrSessionPickerInput(data, dialog);
  }

  tryOpenFromPanel(panel: Component & Focusable): boolean {
    if (this.selectors.tryOpenFromPanel(panel)) return true;
    if (this.panels.tryOpenFromPanel(panel)) return true;
    return false;
  }

  closeAll(): void {
    this.selectors.closeAll();
    this.panels.closeAll();
  }

  resetApprovalState(): void {
    this.panels.resetApprovalState();
  }

  resetQuestionState(): void {
    this.panels.resetQuestionState();
  }

  initQuestionState(questionCount: number): void {
    this.panels.initQuestionState(questionCount);
  }

  openApprovalPreview(block: ApprovalPreviewBlock): void {
    if (this.inkOverlay.approvalPreviewBlock !== null) return;
    this.inkOverlay.approvalPreviewBlock = block;
    this.inkOverlay.approvalPreviewScrollTop = 0;
    this.host.updateInkRenderer();
  }

  closeApprovalPreview(): void {
    if (this.inkOverlay.approvalPreviewBlock === null) return;
    this.inkOverlay.approvalPreviewBlock = null;
    this.inkOverlay.approvalPreviewScrollTop = 0;
    this.host.updateInkRenderer();
  }

  projectDialogFields(): InkDialogProjection {
    const overlay = this.inkOverlay;
    const selectorFields = this.selectors.projectFields();
    const panelFields = this.panels.projectFields();
    return {
      dialogSelectedIndex: overlay.dialogSelectedIndex,
      dialogScrollTop: overlay.dialogScrollTop,
      approvalFeedbackMode: overlay.approvalFeedbackMode,
      approvalFeedbackText: overlay.approvalFeedbackText,
      ...panelFields,
      ...selectorFields,
      approvalPreview:
        overlay.approvalPreviewBlock === null
          ? null
          : {
              block: overlay.approvalPreviewBlock,
              scrollTop: overlay.approvalPreviewScrollTop,
            },
    };
  }

  private handleInkApprovalInput(data: string): boolean {
    const approval = this.host.state.livePane.pendingApproval;
    if (approval === null) return false;
    const choices = approval.data.choices;
    const count = choices.length;

    if (this.inkOverlay.approvalFeedbackMode) {
      if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
        this.inkOverlay.approvalFeedbackMode = false;
        this.inkOverlay.approvalFeedbackText = "";
        if (count > 0) {
          const delta = matchesKey(data, Key.up) ? -1 : 1;
          this.inkOverlay.dialogSelectedIndex =
            (this.inkOverlay.dialogSelectedIndex + delta + count) % count;
        }
        this.host.updateInkRenderer();
        return true;
      }
      if (matchesKey(data, Key.escape)) {
        this.inkOverlay.approvalFeedbackMode = false;
        this.inkOverlay.approvalFeedbackText = "";
        this.host.updateInkRenderer();
        return true;
      }
      if (matchesKey(data, Key.enter)) {
        this.submitInkApproval(
          this.inkOverlay.dialogSelectedIndex,
          this.inkOverlay.approvalFeedbackText,
        );
        return true;
      }
      if (matchesKey(data, Key.backspace) || data === "\u007f") {
        this.inkOverlay.approvalFeedbackText =
          this.inkOverlay.approvalFeedbackText.slice(0, -1);
        this.host.updateInkRenderer();
        return true;
      }
      const printable = printableChar(data);
      if (isPrintableChar(printable)) {
        this.inkOverlay.approvalFeedbackText += printable;
        this.host.updateInkRenderer();
      }
      return true;
    }

    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl("c")) ||
      matchesKey(data, Key.ctrl("d"))
    ) {
      this.host.approvalController.respond(
        adaptPanelResponse({ response: "rejected" }),
      );
      return true;
    }

    if (matchesKey(data, Key.ctrl("e"))) {
      const block = this.findApprovalPreviewBlock();
      if (block !== undefined) this.openApprovalPreview(block);
      return true;
    }

    if (count === 0) return true;
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      const delta = matchesKey(data, Key.up) ? -1 : 1;
      this.inkOverlay.dialogSelectedIndex =
        (this.inkOverlay.dialogSelectedIndex + delta + count) % count;
      this.host.updateInkRenderer();
      return true;
    }
    if (matchesKey(data, Key.enter)) {
      this.selectInkApproval(this.inkOverlay.dialogSelectedIndex);
      return true;
    }

    const printable = printableChar(data);
    const numericIndex = Number(printable) - 1;
    if (
      Number.isInteger(numericIndex) &&
      numericIndex >= 0 &&
      numericIndex < count
    ) {
      this.selectInkApproval(numericIndex);
      return true;
    }
    return true;
  }

  private selectInkApproval(index: number): void {
    const approval = this.host.state.livePane.pendingApproval;
    if (approval === null) return;
    const option = approval.data.choices[index];
    if (option === undefined) return;
    if (option.requires_feedback === true) {
      this.inkOverlay.dialogSelectedIndex = index;
      this.inkOverlay.approvalFeedbackMode = true;
      this.inkOverlay.approvalFeedbackText = "";
      this.host.updateInkRenderer();
      return;
    }
    this.submitInkApproval(index);
  }

  private submitInkApproval(index: number, feedback = ""): void {
    const approval = this.host.state.livePane.pendingApproval;
    if (approval === null) return;
    const option = approval.data.choices[index];
    if (option === undefined) return;
    this.host.approvalController.respond(
      adaptPanelResponse({
        response: option.response,
        feedback: feedback.length > 0 ? feedback : undefined,
        selected_label: option.selected_label,
      }),
    );
  }

  private findApprovalPreviewBlock(): ApprovalPreviewBlock | undefined {
    const approval = this.host.state.livePane.pendingApproval;
    if (approval === null) return;
    return findApprovalPreviewBlock(approval.data.display);
  }

  private scrollInkApprovalPreview(delta: number, viewable: number): void {
    if (this.inkOverlay.approvalPreviewBlock === null) return;
    const lineCount = buildApprovalPreviewBody(
      this.inkOverlay.approvalPreviewBlock,
    ).lines.length;
    const maxScroll = approvalPreviewMaxScroll(lineCount, viewable);
    this.inkOverlay.approvalPreviewScrollTop = Math.max(
      0,
      Math.min(this.inkOverlay.approvalPreviewScrollTop + delta, maxScroll),
    );
    this.host.updateInkRenderer();
  }

  private handleHelpDialogInput(data: string): boolean {
    const printable = printableChar(data);
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.enter) ||
      printable === "q" ||
      printable === "Q"
    ) {
      this.host.hideHelpPanel();
      return true;
    }
    if (matchesKey(data, Key.up)) {
      this.inkOverlay.dialogScrollTop = Math.max(
        0,
        this.inkOverlay.dialogScrollTop - 1,
      );
      this.host.updateInkRenderer();
      return true;
    }
    if (matchesKey(data, Key.down)) {
      this.inkOverlay.dialogScrollTop += 1;
      this.host.updateInkRenderer();
      return true;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.inkOverlay.dialogScrollTop = Math.max(
        0,
        this.inkOverlay.dialogScrollTop - 10,
      );
      this.host.updateInkRenderer();
      return true;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.inkOverlay.dialogScrollTop += 10;
      this.host.updateInkRenderer();
      return true;
    }
    return true;
  }

  private handleTrustOrSessionPickerInput(
    data: string,
    dialog: "trust-prompt" | "session-picker",
  ): boolean {
    const count =
      dialog === "trust-prompt"
        ? 2
        : Math.min(8, this.host.state.sessions.length);
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      if (count === 0) return true;
      const delta = matchesKey(data, Key.up) ? -1 : 1;
      this.inkOverlay.dialogSelectedIndex =
        (this.inkOverlay.dialogSelectedIndex + delta + count) % count;
      this.host.updateInkRenderer();
      return true;
    }
    if (matchesKey(data, Key.escape)) {
      if (dialog === "trust-prompt") {
        this.host.resolveTrustPrompt("distrust");
      } else {
        this.host.cancelSessionPicker();
      }
      return true;
    }
    if (dialog === "session-picker" && matchesKey(data, Key.ctrl("a"))) {
      const selected =
        this.host.state.sessions[this.inkOverlay.dialogSelectedIndex];
      this.host.toggleSessionPickerScope(
        selected?.id ?? this.host.state.appState.sessionId,
      );
      return true;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
      if (dialog === "trust-prompt") {
        this.host.resolveTrustPrompt(
          this.inkOverlay.dialogSelectedIndex === 0 ? "trust" : "distrust",
        );
      } else {
        const selected =
          this.host.state.sessions[this.inkOverlay.dialogSelectedIndex];
        if (selected !== undefined) {
          this.host.selectSessionPickerRow(selected);
        }
      }
      return true;
    }
    return false;
  }
}

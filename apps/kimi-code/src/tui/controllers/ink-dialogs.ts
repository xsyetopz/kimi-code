import type { Component, Focusable } from "@moonshot-ai/kimi-tui";
import { Key, matchesKey } from "@moonshot-ai/kimi-tui";

import {
  type ApprovalPreviewBlock,
  approvalPreviewMaxScroll,
  approvalPreviewViewableRows,
  buildApprovalPreviewBody,
  findApprovalPreviewBlock,
} from "#/tui/components/dialogs/approval-preview-body";
import {
  ApiKeyInputDialogComponent,
  type ApiKeyInputDialogOptions,
  type ApiKeyInputResult,
} from "#/tui/components/dialogs/api-key-input-dialog";
import {
  ChoicePickerComponent,
  type ChoiceOption,
  type ChoicePickerOptions,
} from "#/tui/components/dialogs/choice-picker";
import { CustomRegistryImportDialogComponent } from "#/tui/components/dialogs/custom-registry-import";
import type { CustomRegistryImportDialogOptions } from "#/tui/components/dialogs/custom-registry-import";
import { EffortSelectorComponent } from "#/tui/components/dialogs/effort-selector";
import type { EffortSelectorOptions } from "#/tui/components/dialogs/effort-selector";
import {
  ExperimentsSelectorComponent,
  type ExperimentalFeatureDraftChange,
  type ExperimentsSelectorOptions,
} from "#/tui/components/dialogs/experiments-selector";
import {
  FeedbackInputDialogComponent,
  type FeedbackInputDialogOptions,
  type FeedbackInputDialogResult,
} from "#/tui/components/dialogs/feedback-input-dialog";
import {
  GoalQueueEditDialogComponent,
  GoalQueueManagerComponent,
  type GoalQueueEditDialogOptions,
  type GoalQueueManagerOptions,
} from "#/tui/components/dialogs/goal-queue-manager";
import { ModelSelectorComponent } from "#/tui/components/dialogs/model-selector";
import type { ModelSelectorOptions } from "#/tui/components/dialogs/model-selector";
import {
  PluginMcpSelectorComponent,
  PluginsPanelComponent,
  type PluginMcpSelectorOptions,
  type PluginsPanelOptions,
} from "#/tui/components/dialogs/plugins-selector";
import { ProviderManagerComponent } from "#/tui/components/dialogs/provider-manager";
import type { ProviderManagerOptions } from "#/tui/components/dialogs/provider-manager";
import type { SessionRow } from "#/tui/components/dialogs/session-picker";
import { StartPermissionPromptComponent } from "#/tui/components/dialogs/start-permission-prompt";
import type { StartPermissionPromptOptions } from "#/tui/components/dialogs/start-permission-prompt";
import { TabbedModelSelectorComponent } from "#/tui/components/dialogs/tabbed-model-selector";
import type { TabbedModelSelectorOptions } from "#/tui/components/dialogs/tabbed-model-selector";
import { UndoSelectorComponent } from "#/tui/components/dialogs/undo-selector";
import type { UndoSelectorOptions } from "#/tui/components/dialogs/undo-selector";
import {
  initInkOverlayQuestion,
  resetInkOverlayApproval,
  resetInkOverlayQuestion,
} from "#/tui/renderer/ink/overlay-state";
import {
  handleInkQuestionWizardInput,
  projectInkQuestionWizardView,
  type InkQuestionWizardView,
} from "#/tui/renderer/ink/question-wizard";
import {
  createInkApiKeyInputSession,
  projectInkApiKeyInputView,
} from "#/tui/renderer/ink/sessions/api-key-input";
import {
  createInkChoicePickerList,
  handleInkChoicePickerInput,
  projectInkChoicePickerView,
  type InkChoicePickerView,
} from "#/tui/renderer/ink/sessions/choice-picker";
import {
  createInkCustomRegistryImportSession,
  type InkCustomRegistryImportSession,
  projectInkCustomRegistryImportView,
  type InkCustomRegistryImportView,
} from "#/tui/renderer/ink/sessions/custom-registry-import";
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
  createInkFeedbackInputSession,
  projectInkFeedbackInputView,
} from "#/tui/renderer/ink/sessions/feedback-input";
import {
  createInkGoalQueueEditSession,
  type InkGoalQueueEditSession,
  projectInkGoalQueueEditView,
  type InkGoalQueueEditView,
} from "#/tui/renderer/ink/sessions/goal-queue-edit";
import {
  createInkGoalQueueManagerSession,
  type InkGoalQueueManagerSession,
  projectInkGoalQueueManagerView,
  type InkGoalQueueManagerView,
} from "#/tui/renderer/ink/sessions/goal-queue-manager";
import type { InkSingleLineInputSession } from "#/tui/renderer/ink/sessions/input-single-line";
import type { InkSingleLineInputView } from "#/tui/renderer/ink/sessions/input-single-line";
import {
  createInkModelSelectorSession,
  createInkTabbedModelSelectorSession,
  type InkModelSelectorSession,
  type InkTabbedModelSelectorSession,
  projectInkModelSelectorView,
  type InkModelSelectorView,
} from "#/tui/renderer/ink/sessions/model-selector";
import {
  createInkPluginMcpSelectorSession,
  type InkPluginMcpSelectorSession,
  projectInkPluginMcpSelectorView,
  type InkPluginMcpSelectorView,
} from "#/tui/renderer/ink/sessions/plugin-mcp-selector";
import {
  createInkPluginsPanelSession,
  type InkPluginsPanelSession,
  projectInkPluginsPanelView,
  type InkPluginsPanelView,
} from "#/tui/renderer/ink/sessions/plugins-panel";
import {
  createInkProviderManagerSession,
  type InkProviderManagerSession,
  projectInkProviderManagerView,
  type InkProviderManagerView,
} from "#/tui/renderer/ink/sessions/provider-manager";
import {
  createInkStartPermissionPromptSession,
  type InkStartPermissionPromptSession,
  projectInkStartPermissionPromptView,
  type InkStartPermissionPromptView,
} from "#/tui/renderer/ink/sessions/start-permission-prompt";
import {
  createInkUndoSelectorSession,
  type InkUndoSelectorSession,
  projectInkUndoSelectorView,
  type InkUndoSelectorView,
} from "#/tui/renderer/ink/sessions/undo-selector";
import type { TerminalApprovalPreviewView } from "#/tui/renderer/terminal-view-state";
import { adaptPanelResponse } from "#/tui/reverse-rpc/approval/adapter";
import type { ApprovalController } from "#/tui/reverse-rpc/approval/controller";
import type { QuestionController } from "#/tui/reverse-rpc/question/controller";
import type { TUIState } from "../tui-state";
import { SearchableList } from "../utils/searchable-list";
import { isPrintableChar, printableChar } from "../utils/printable-key";

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

export class InkDialogsController {
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
  private inkPluginMcpSelector: {
    readonly session: InkPluginMcpSelectorSession;
    readonly opts: PluginMcpSelectorOptions;
  } | null = null;
  private inkPluginsPanel: {
    readonly session: InkPluginsPanelSession;
    readonly opts: PluginsPanelOptions;
    readonly panel: PluginsPanelComponent;
  } | null = null;
  private inkStartPermissionPrompt: {
    readonly session: InkStartPermissionPromptSession;
    readonly opts: StartPermissionPromptOptions;
  } | null = null;
  private inkGoalQueueManager: {
    readonly session: InkGoalQueueManagerSession;
    readonly opts: GoalQueueManagerOptions;
    readonly panel: GoalQueueManagerComponent;
  } | null = null;
  private inkGoalQueueEdit: {
    readonly session: InkGoalQueueEditSession;
    readonly opts: GoalQueueEditDialogOptions;
  } | null = null;
  private inkProviderManager: {
    readonly session: InkProviderManagerSession;
    readonly opts: ProviderManagerOptions;
  } | null = null;
  private inkApiKeyInput: {
    readonly session: InkSingleLineInputSession<ApiKeyInputResult>;
    readonly opts: ApiKeyInputDialogOptions;
  } | null = null;
  private inkFeedbackInput: {
    readonly session: InkSingleLineInputSession<FeedbackInputDialogResult>;
    readonly opts: FeedbackInputDialogOptions;
  } | null = null;
  private inkCustomRegistryImport: {
    readonly session: InkCustomRegistryImportSession;
    readonly opts: CustomRegistryImportDialogOptions;
  } | null = null;

  constructor(private readonly host: InkDialogsHost) {}

  private get inkOverlay() {
    return this.host.state.inkOverlay;
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

  /** Handle dialogs whose interaction model is represented in the Ink snapshot. */
  handleDialogInput(data: string): boolean {
    if (this.host.state.livePane.pendingApproval !== null) {
      return this.handleInkApprovalInput(data);
    }
    if (this.host.state.livePane.pendingQuestion !== null) {
      return this.handleInkQuestionInput(data);
    }
    const dialog = this.host.state.activeDialog;
    if (dialog === "help") {
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
    if (dialog === "plugin-mcp-selector") {
      return this.handleInkPluginMcpSelectorInput(data);
    }
    if (dialog === "plugins-panel") {
      return this.handleInkPluginsPanelInput(data);
    }
    if (dialog === "start-permission-prompt") {
      return this.handleInkStartPermissionPromptInput(data);
    }
    if (dialog === "goal-queue-manager") {
      return this.handleInkGoalQueueManagerInput(data);
    }
    if (dialog === "goal-queue-edit") {
      return this.handleInkGoalQueueEditInput(data);
    }
    if (dialog === "provider-manager") {
      return this.handleInkProviderManagerInput(data);
    }
    if (dialog === "api-key-input") {
      return this.handleInkApiKeyInput(data);
    }
    if (dialog === "feedback-input") {
      return this.handleInkFeedbackInput(data);
    }
    if (dialog === "custom-registry-import") {
      return this.handleInkCustomRegistryImportInput(data);
    }
    if (dialog !== "trust-prompt" && dialog !== "session-picker") return false;
    const count =
      dialog === "trust-prompt" ? 2 : Math.min(8, this.host.state.sessions.length);
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
    if (panel instanceof PluginMcpSelectorComponent) {
      this.openInkPluginMcpSelector(panel.getPluginMcpSelectorOptions());
      return true;
    }
    if (panel instanceof PluginsPanelComponent) {
      this.openInkPluginsPanel(panel);
      return true;
    }
    if (panel instanceof StartPermissionPromptComponent) {
      this.openInkStartPermissionPrompt(panel.getStartPermissionPromptOptions());
      return true;
    }
    if (panel instanceof GoalQueueManagerComponent) {
      this.openInkGoalQueueManager(panel);
      return true;
    }
    if (panel instanceof GoalQueueEditDialogComponent) {
      this.openInkGoalQueueEdit(panel.getGoalQueueEditDialogOptions());
      return true;
    }
    if (panel instanceof ProviderManagerComponent) {
      this.openInkProviderManager(panel.getProviderManagerOptions());
      return true;
    }
    if (panel instanceof ApiKeyInputDialogComponent) {
      this.openInkApiKeyInput(panel.getApiKeyInputDialogOptions());
      return true;
    }
    if (panel instanceof FeedbackInputDialogComponent) {
      this.openInkFeedbackInput(panel.getFeedbackInputDialogOptions());
      return true;
    }
    if (panel instanceof CustomRegistryImportDialogComponent) {
      this.openInkCustomRegistryImport(
        panel.getCustomRegistryImportDialogOptions(),
      );
      return true;
    }
    if (panel instanceof ChoicePickerComponent) {
      this.openInkChoicePicker(panel.getChoicePickerOptions());
      return true;
    }
    return false;
  }

  closeAll(): void {
    this.closeInkChoicePicker();
    this.closeInkModelSelector();
    this.closeInkEffortSelector();
    this.closeInkUndoSelector();
    this.closeInkExperimentsSelector();
    this.closeInkPluginMcpSelector();
    this.closeInkPluginsPanel();
    this.closeInkStartPermissionPrompt();
    this.closeInkGoalQueueManager();
    this.closeInkGoalQueueEdit();
    this.closeInkProviderManager();
    this.closeInkApiKeyInput();
    this.closeInkFeedbackInput();
    this.closeInkCustomRegistryImport();
  }

  resetApprovalState(): void {
    resetInkOverlayApproval(this.inkOverlay);
  }

  resetQuestionState(): void {
    resetInkOverlayQuestion(this.inkOverlay);
  }

  initQuestionState(questionCount: number): void {
    initInkOverlayQuestion(this.inkOverlay, questionCount);
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
    return {
      dialogSelectedIndex: overlay.dialogSelectedIndex,
      dialogScrollTop: overlay.dialogScrollTop,
      approvalFeedbackMode: overlay.approvalFeedbackMode,
      approvalFeedbackText: overlay.approvalFeedbackText,
      questionWizard:
        overlay.questionWizard === null ||
        this.host.state.livePane.pendingQuestion === null
          ? null
          : projectInkQuestionWizardView(
              this.host.state.livePane.pendingQuestion,
              overlay.questionWizard,
            ),
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
      pluginMcpSelector:
        this.inkPluginMcpSelector === null
          ? null
          : projectInkPluginMcpSelectorView(this.inkPluginMcpSelector.session),
      pluginsPanel:
        this.inkPluginsPanel === null
          ? null
          : projectInkPluginsPanelView(this.inkPluginsPanel.session),
      startPermissionPrompt:
        this.inkStartPermissionPrompt === null
          ? null
          : projectInkStartPermissionPromptView(
              this.inkStartPermissionPrompt.session,
            ),
      goalQueueManager:
        this.inkGoalQueueManager === null
          ? null
          : projectInkGoalQueueManagerView(this.inkGoalQueueManager.session),
      goalQueueEdit:
        this.inkGoalQueueEdit === null
          ? null
          : projectInkGoalQueueEditView(this.inkGoalQueueEdit.session),
      providerManager:
        this.inkProviderManager === null
          ? null
          : projectInkProviderManagerView(this.inkProviderManager.session),
      apiKeyInput:
        this.inkApiKeyInput === null
          ? null
          : projectInkApiKeyInputView(this.inkApiKeyInput.session),
      feedbackInput:
        this.inkFeedbackInput === null
          ? null
          : projectInkFeedbackInputView(this.inkFeedbackInput.session),
      customRegistryImport:
        this.inkCustomRegistryImport === null
          ? null
          : projectInkCustomRegistryImportView(
              this.inkCustomRegistryImport.session,
            ),
      approvalPreview:
        overlay.approvalPreviewBlock === null
          ? null
          : {
              block: overlay.approvalPreviewBlock,
              scrollTop: overlay.approvalPreviewScrollTop,
            },
    };
  }

  private findApprovalPreviewBlock(): ApprovalPreviewBlock | undefined {
    const approval = this.host.state.livePane.pendingApproval;
    if (approval === null) return;
    return findApprovalPreviewBlock(approval.data.display);
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

  private handleInkQuestionInput(data: string): boolean {
    const pending = this.host.state.livePane.pendingQuestion;
    if (pending === null) return false;
    if (this.inkOverlay.questionWizard === null) {
      initInkOverlayQuestion(this.inkOverlay, pending.data.questions.length);
    }
    const wizard = this.inkOverlay.questionWizard;
    if (wizard === null) return false;
    const consumed = handleInkQuestionWizardInput(
      pending,
      wizard,
      data,
      (response) => {
        this.host.questionController.respond(response);
      },
    );
    if (consumed) {
      this.inkOverlay.dialogSelectedIndex = projectInkQuestionWizardView(
        pending,
        wizard,
      ).selectedIndex;
      this.host.updateInkRenderer();
    }
    return consumed;
  }

  private handleInkChoicePickerInput(data: string): boolean {
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

  private handleInkPluginMcpSelectorInput(data: string): boolean {
    const handle = this.inkPluginMcpSelector;
    if (handle === null) return false;
    const callbacks = {
      onSelect: (
        selection: Parameters<PluginMcpSelectorOptions["onSelect"]>[0],
      ) => {
        handle.opts.onSelect(selection);
      },
      onCancel: () => {
        this.closeInkPluginMcpSelector();
        handle.opts.onCancel();
      },
    };
    const consumed = handle.session.handleInput(data, callbacks);
    if (consumed) {
      this.host.updateInkRenderer();
    }
    return consumed;
  }

  private openInkPluginMcpSelector(opts: PluginMcpSelectorOptions): void {
    this.closeInkPluginMcpSelector();
    this.inkPluginMcpSelector = {
      session: createInkPluginMcpSelectorSession(opts),
      opts,
    };
    this.host.state.activeDialog = "plugin-mcp-selector";
    this.host.updateInkRenderer();
  }

  private closeInkPluginMcpSelector(): void {
    this.inkPluginMcpSelector = null;
    if (this.host.state.activeDialog === "plugin-mcp-selector") {
      this.host.state.activeDialog = null;
    }
  }

  private handleInkPluginsPanelInput(data: string): boolean {
    const handle = this.inkPluginsPanel;
    if (handle === null) return false;
    const callbacks = {
      onSelect: (selection: Parameters<PluginsPanelOptions["onSelect"]>[0]) => {
        handle.opts.onSelect(selection);
      },
      onCancel: () => {
        this.closeInkPluginsPanel();
        handle.opts.onCancel();
      },
    };
    const consumed = handle.session.handleInput(data, callbacks);
    if (consumed) {
      this.host.updateInkRenderer();
    }
    return consumed;
  }

  private openInkPluginsPanel(panel: PluginsPanelComponent): void {
    this.closeInkPluginsPanel();
    const opts = panel.getPluginsPanelOptions();
    const session = createInkPluginsPanelSession(opts);
    panel.attachInkSession(session, () => {
      this.host.updateInkRenderer();
    });
    this.inkPluginsPanel = { session, opts, panel };
    this.host.state.activeDialog = "plugins-panel";
    this.host.updateInkRenderer();
  }

  private closeInkPluginsPanel(): void {
    this.inkPluginsPanel = null;
    if (this.host.state.activeDialog === "plugins-panel") {
      this.host.state.activeDialog = null;
    }
  }

  private handleInkStartPermissionPromptInput(data: string): boolean {
    const handle = this.inkStartPermissionPrompt;
    if (handle === null) return false;
    const callbacks = {
      onSelect: (
        choice: Parameters<StartPermissionPromptOptions["onSelect"]>[0],
      ) => {
        handle.opts.onSelect(choice);
      },
      onCancel: () => {
        this.closeInkStartPermissionPrompt();
        handle.opts.onCancel();
      },
    };
    const consumed = handle.session.handleInput(data, callbacks);
    if (consumed) {
      this.host.updateInkRenderer();
    }
    return consumed;
  }

  private openInkStartPermissionPrompt(
    opts: StartPermissionPromptOptions,
  ): void {
    this.closeInkStartPermissionPrompt();
    this.inkStartPermissionPrompt = {
      session: createInkStartPermissionPromptSession(opts),
      opts,
    };
    this.host.state.activeDialog = "start-permission-prompt";
    this.host.updateInkRenderer();
  }

  private closeInkStartPermissionPrompt(): void {
    this.inkStartPermissionPrompt = null;
    if (this.host.state.activeDialog === "start-permission-prompt") {
      this.host.state.activeDialog = null;
    }
  }

  private handleInkGoalQueueManagerInput(data: string): boolean {
    const handle = this.inkGoalQueueManager;
    if (handle === null) return false;
    const callbacks = {
      onAction: (action: Parameters<GoalQueueManagerOptions["onAction"]>[0]) =>
        handle.opts.onAction(action),
      onCancel: () => {
        this.closeInkGoalQueueManager();
        handle.opts.onCancel();
      },
    };
    const consumed = handle.session.handleInput(data, callbacks);
    if (consumed) {
      this.host.updateInkRenderer();
    }
    return consumed;
  }

  private openInkGoalQueueManager(panel: GoalQueueManagerComponent): void {
    this.closeInkGoalQueueManager();
    this.closeInkGoalQueueEdit();
    const opts = panel.getGoalQueueManagerOptions();
    const session = createInkGoalQueueManagerSession(opts);
    panel.attachInkSession(session, () => {
      this.host.updateInkRenderer();
    });
    this.inkGoalQueueManager = { session, opts, panel };
    this.host.state.activeDialog = "goal-queue-manager";
    this.host.updateInkRenderer();
  }

  private closeInkGoalQueueManager(): void {
    this.inkGoalQueueManager = null;
    if (this.host.state.activeDialog === "goal-queue-manager") {
      this.host.state.activeDialog = null;
    }
  }

  private handleInkGoalQueueEditInput(data: string): boolean {
    const handle = this.inkGoalQueueEdit;
    if (handle === null) return false;
    const callbacks = {
      onDone: (result: Parameters<GoalQueueEditDialogOptions["onDone"]>[0]) => {
        handle.opts.onDone(result);
      },
    };
    const consumed = handle.session.handleInput(data, callbacks);
    if (consumed) {
      this.host.updateInkRenderer();
    }
    return consumed;
  }

  private openInkGoalQueueEdit(opts: GoalQueueEditDialogOptions): void {
    this.closeInkGoalQueueEdit();
    this.closeInkGoalQueueManager();
    this.inkGoalQueueEdit = {
      session: createInkGoalQueueEditSession(opts),
      opts,
    };
    this.host.state.activeDialog = "goal-queue-edit";
    this.host.updateInkRenderer();
  }

  private closeInkGoalQueueEdit(): void {
    this.inkGoalQueueEdit = null;
    if (this.host.state.activeDialog === "goal-queue-edit") {
      this.host.state.activeDialog = null;
    }
  }

  private handleInkProviderManagerInput(data: string): boolean {
    const handle = this.inkProviderManager;
    if (handle === null) return false;
    const callbacks = {
      onAdd: () => {
        handle.opts.onAdd();
      },
      onDeleteSource: (providerIds: readonly string[]) => {
        handle.opts.onDeleteSource(providerIds);
      },
      onClose: () => {
        this.closeInkProviderManager();
        handle.opts.onClose();
      },
    };
    const consumed = handle.session.handleInput(data, callbacks);
    if (consumed) {
      this.host.updateInkRenderer();
    }
    return consumed;
  }

  private openInkProviderManager(opts: ProviderManagerOptions): void {
    this.closeInkProviderManager();
    this.inkProviderManager = {
      session: createInkProviderManagerSession(opts),
      opts,
    };
    this.host.state.activeDialog = "provider-manager";
    this.host.updateInkRenderer();
  }

  private closeInkProviderManager(): void {
    this.inkProviderManager = null;
    if (this.host.state.activeDialog === "provider-manager") {
      this.host.state.activeDialog = null;
    }
  }

  private handleInkApiKeyInput(data: string): boolean {
    const handle = this.inkApiKeyInput;
    if (handle === null) return false;
    const consumed = handle.session.handleInput(data);
    if (consumed) {
      this.host.updateInkRenderer();
    }
    return consumed;
  }

  private openInkApiKeyInput(opts: ApiKeyInputDialogOptions): void {
    this.closeInkApiKeyInput();
    this.inkApiKeyInput = {
      session: createInkApiKeyInputSession(opts),
      opts,
    };
    this.host.state.activeDialog = "api-key-input";
    this.host.updateInkRenderer();
  }

  private closeInkApiKeyInput(): void {
    this.inkApiKeyInput = null;
    if (this.host.state.activeDialog === "api-key-input") {
      this.host.state.activeDialog = null;
    }
  }

  private handleInkFeedbackInput(data: string): boolean {
    const handle = this.inkFeedbackInput;
    if (handle === null) return false;
    const consumed = handle.session.handleInput(data);
    if (consumed) {
      this.host.updateInkRenderer();
    }
    return consumed;
  }

  private openInkFeedbackInput(opts: FeedbackInputDialogOptions): void {
    this.closeInkFeedbackInput();
    this.inkFeedbackInput = {
      session: createInkFeedbackInputSession(opts),
      opts,
    };
    this.host.state.activeDialog = "feedback-input";
    this.host.updateInkRenderer();
  }

  private closeInkFeedbackInput(): void {
    this.inkFeedbackInput = null;
    if (this.host.state.activeDialog === "feedback-input") {
      this.host.state.activeDialog = null;
    }
  }

  private handleInkCustomRegistryImportInput(data: string): boolean {
    const handle = this.inkCustomRegistryImport;
    if (handle === null) return false;
    const consumed = handle.session.handleInput(data);
    if (consumed) {
      this.host.updateInkRenderer();
    }
    return consumed;
  }

  private openInkCustomRegistryImport(
    opts: CustomRegistryImportDialogOptions,
  ): void {
    this.closeInkCustomRegistryImport();
    this.inkCustomRegistryImport = {
      session: createInkCustomRegistryImportSession(opts),
      opts,
    };
    this.host.state.activeDialog = "custom-registry-import";
    this.host.updateInkRenderer();
  }

  private closeInkCustomRegistryImport(): void {
    this.inkCustomRegistryImport = null;
    if (this.host.state.activeDialog === "custom-registry-import") {
      this.host.state.activeDialog = null;
    }
  }
}

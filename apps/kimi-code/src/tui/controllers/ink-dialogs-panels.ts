import type { Component, Focusable } from "@moonshot-ai/kimi-tui";

import {
  ApiKeyInputDialogComponent,
  type ApiKeyInputDialogOptions,
  type ApiKeyInputResult,
} from "#/tui/components/dialogs/api-key-input-dialog";
import { CustomRegistryImportDialogComponent } from "#/tui/components/dialogs/custom-registry-import";
import type { CustomRegistryImportDialogOptions } from "#/tui/components/dialogs/custom-registry-import";
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
import {
  PluginMcpSelectorComponent,
  PluginsPanelComponent,
  type PluginMcpSelectorOptions,
  type PluginsPanelOptions,
} from "#/tui/components/dialogs/plugins-selector";
import { ProviderManagerComponent } from "#/tui/components/dialogs/provider-manager";
import type { ProviderManagerOptions } from "#/tui/components/dialogs/provider-manager";
import { StartPermissionPromptComponent } from "#/tui/components/dialogs/start-permission-prompt";
import type { StartPermissionPromptOptions } from "#/tui/components/dialogs/start-permission-prompt";
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
  createInkCustomRegistryImportSession,
  type InkCustomRegistryImportSession,
  projectInkCustomRegistryImportView,
  type InkCustomRegistryImportView,
} from "#/tui/renderer/ink/sessions/custom-registry-import";
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
import type { InkDialogsControllerHost } from "./ink-dialogs";

/** Plugin / provider / goal / approval / question Ink dialog sessions. */
export class InkDialogsPanels {
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

  constructor(private readonly host: InkDialogsControllerHost) {}

  private get inkOverlay() {
    return this.host.state.inkOverlay;
  }

  closeAll(): void {
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

  handlePendingQuestionInput(data: string): boolean {
    return this.handleInkQuestionInput(data);
  }

  handleDialogInput(data: string): boolean {
    const dialog = this.host.state.activeDialog;
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
    return false;
  }

  tryOpenFromPanel(panel: Component & Focusable): boolean {
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
    return false;
  }

  projectFields(): {
    questionWizard: InkQuestionWizardView | null;
    pluginMcpSelector: InkPluginMcpSelectorView | null;
    pluginsPanel: InkPluginsPanelView | null;
    startPermissionPrompt: InkStartPermissionPromptView | null;
    goalQueueManager: InkGoalQueueManagerView | null;
    goalQueueEdit: InkGoalQueueEditView | null;
    providerManager: InkProviderManagerView | null;
    apiKeyInput: InkSingleLineInputView | null;
    feedbackInput: InkSingleLineInputView | null;
    customRegistryImport: InkCustomRegistryImportView | null;
  } {
    const overlay = this.inkOverlay;
    return {
      questionWizard:
        overlay.questionWizard === null ||
        this.host.state.livePane.pendingQuestion === null
          ? null
          : projectInkQuestionWizardView(
              this.host.state.livePane.pendingQuestion,
              overlay.questionWizard,
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
    };
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

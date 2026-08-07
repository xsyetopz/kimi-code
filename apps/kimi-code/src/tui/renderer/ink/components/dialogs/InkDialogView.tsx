import { Box, Text } from "ink";
import { type ReactNode } from "react";

import type { TerminalViewState } from "../../../terminal-view-state";

import { InkApprovalDialog } from "./InkApprovalDialog";
import { InkChoicePickerDialog } from "./InkChoicePickerDialog";
import { InkEffortSelectorDialog } from "./InkEffortSelectorDialog";
import { InkCustomRegistryImportDialog } from "./InkCustomRegistryImportDialog";
import { InkGoalQueueEditDialog } from "./InkGoalQueueEditDialog";
import { InkGoalQueueManagerDialog } from "./InkGoalQueueManagerDialog";
import { InkHelpDialog } from "./InkHelpDialog";
import { InkModelSelectorDialog } from "./InkModelSelectorDialog";
import { InkExperimentsSelectorDialog } from "./InkExperimentsSelectorDialog";
import { InkPluginMcpSelectorDialog } from "./InkPluginMcpSelectorDialog";
import { InkPluginsPanelDialog } from "./InkPluginsPanelDialog";
import { InkProviderManagerDialog } from "./InkProviderManagerDialog";
import { InkSingleLineInputDialog } from "./InkSingleLineInputDialog";
import { InkStartPermissionPromptDialog } from "./InkStartPermissionPromptDialog";
import { InkUndoSelectorDialog } from "./InkUndoSelectorDialog";
import { InkQuestionDialog } from "./InkQuestionDialog";
import { InkSessionPickerDialog } from "./InkSessionPickerDialog";
import { InkTrustDialog } from "./InkTrustDialog";

export interface InkDialogViewProps {
  readonly view: TerminalViewState;
  readonly width?: number;
  readonly maxVisible?: number;
}

function dialogTitle(view: TerminalViewState): string | undefined {
  if (view.dialog.pendingApproval !== null) {
    return `Approval required: ${view.dialog.pendingApproval.data.tool_name}`;
  }
  if (view.dialog.pendingQuestion !== null) return "Question required";
  switch (view.dialog.active) {
    case "trust-prompt":
      return "Trust this workspace to enable project integrations?";
    case "session-picker":
      return "Select a session";
    case "help":
      return "Help";
    case "choice-picker":
      return view.dialog.choicePicker?.title;
    case "model-selector":
      return view.dialog.modelSelector?.title;
    case "effort-selector":
      return view.dialog.effortSelector?.title;
    case "undo-selector":
      return view.dialog.undoSelector?.title;
    case "experiments-selector":
      return view.dialog.experimentsSelector?.title;
    case "plugin-mcp-selector":
      return view.dialog.pluginMcpSelector?.title;
    case "plugins-panel":
      return view.dialog.pluginsPanel?.title;
    case "start-permission-prompt":
      return view.dialog.startPermissionPrompt?.title;
    case "goal-queue-manager":
      return view.dialog.goalQueueManager?.title;
    case "goal-queue-edit":
      return view.dialog.goalQueueEdit?.title;
    case "provider-manager":
      return view.dialog.providerManager?.title;
    case "api-key-input":
      return view.dialog.apiKeyInput?.title;
    case "feedback-input":
      return view.dialog.feedbackInput?.title;
    case "custom-registry-import":
      return view.dialog.customRegistryImport?.title;
    default:
      return;
  }
}

function dialogBody(
  view: TerminalViewState,
  width: number,
  maxVisible: number,
): ReactNode {
  const { dialog } = view;
  if (dialog.pendingApproval !== null) {
    return (
      <InkApprovalDialog
        request={dialog.pendingApproval}
        selectedIndex={dialog.selectedIndex}
        feedbackMode={dialog.approvalFeedbackMode}
        feedbackText={dialog.approvalFeedbackText}
      />
    );
  }
  if (dialog.pendingQuestion !== null) {
    if (dialog.questionWizard === null) return null;
    return (
      <InkQuestionDialog
        request={dialog.pendingQuestion}
        wizard={dialog.questionWizard}
      />
    );
  }
  switch (dialog.active) {
    case "trust-prompt":
      if (dialog.trustPrompt === null) return null;
      return (
        <InkTrustDialog
          trustPrompt={dialog.trustPrompt}
          selectedIndex={dialog.selectedIndex}
        />
      );
    case "session-picker":
      return (
        <InkSessionPickerDialog
          dialog={dialog}
          currentSessionId={view.app.sessionId}
        />
      );
    case "help":
      return (
        <InkHelpDialog dialog={dialog} width={width} maxVisible={maxVisible} />
      );
    case "choice-picker":
      if (dialog.choicePicker === null) return null;
      return <InkChoicePickerDialog picker={dialog.choicePicker} />;
    case "model-selector":
      if (dialog.modelSelector === null) return null;
      return <InkModelSelectorDialog selector={dialog.modelSelector} />;
    case "effort-selector":
      if (dialog.effortSelector === null) return null;
      return <InkEffortSelectorDialog selector={dialog.effortSelector} />;
    case "undo-selector":
      if (dialog.undoSelector === null) return null;
      return <InkUndoSelectorDialog selector={dialog.undoSelector} />;
    case "experiments-selector":
      if (dialog.experimentsSelector === null) return null;
      return (
        <InkExperimentsSelectorDialog selector={dialog.experimentsSelector} />
      );
    case "plugin-mcp-selector":
      if (dialog.pluginMcpSelector === null) return null;
      return <InkPluginMcpSelectorDialog selector={dialog.pluginMcpSelector} />;
    case "plugins-panel":
      if (dialog.pluginsPanel === null) return null;
      return <InkPluginsPanelDialog panel={dialog.pluginsPanel} />;
    case "start-permission-prompt":
      if (dialog.startPermissionPrompt === null) return null;
      return (
        <InkStartPermissionPromptDialog prompt={dialog.startPermissionPrompt} />
      );
    case "goal-queue-manager":
      if (dialog.goalQueueManager === null) return null;
      return <InkGoalQueueManagerDialog manager={dialog.goalQueueManager} />;
    case "goal-queue-edit":
      if (dialog.goalQueueEdit === null) return null;
      return <InkGoalQueueEditDialog edit={dialog.goalQueueEdit} />;
    case "provider-manager":
      if (dialog.providerManager === null) return null;
      return <InkProviderManagerDialog manager={dialog.providerManager} />;
    case "api-key-input":
      if (dialog.apiKeyInput === null) return null;
      return <InkSingleLineInputDialog dialog={dialog.apiKeyInput} />;
    case "feedback-input":
      if (dialog.feedbackInput === null) return null;
      return <InkSingleLineInputDialog dialog={dialog.feedbackInput} />;
    case "custom-registry-import":
      if (dialog.customRegistryImport === null) return null;
      return (
        <InkCustomRegistryImportDialog dialog={dialog.customRegistryImport} />
      );
    default:
      return null;
  }
}

/**
 * Dispatch the active dialog to its React component. Returns null when no
 * dialog is open.
 */
export function InkDialogView({
  view,
  width = 80,
  maxVisible = 24,
}: InkDialogViewProps): ReactNode {
  const title = dialogTitle(view);
  const body = dialogBody(view, width, maxVisible);
  if (title === undefined || body === null) return null;

  // Help and choice pickers render their own title row; skip the outer chrome there.
  if (
    view.dialog.active === "help" ||
    view.dialog.active === "choice-picker" ||
    view.dialog.active === "model-selector" ||
    view.dialog.active === "effort-selector" ||
    view.dialog.active === "undo-selector" ||
    view.dialog.active === "experiments-selector" ||
    view.dialog.active === "plugin-mcp-selector" ||
    view.dialog.active === "plugins-panel" ||
    view.dialog.active === "start-permission-prompt" ||
    view.dialog.active === "goal-queue-manager" ||
    view.dialog.active === "goal-queue-edit" ||
    view.dialog.active === "provider-manager" ||
    view.dialog.active === "api-key-input" ||
    view.dialog.active === "feedback-input" ||
    view.dialog.active === "custom-registry-import"
  ) {
    return body;
  }

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      <Text bold>{title}</Text>
      {body}
    </Box>
  );
}

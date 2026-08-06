import { Box, Text } from "ink";
import { type ReactNode } from "react";

import type { TerminalViewState } from "../../terminal-view-state";

import { InkApprovalDialog } from "./InkApprovalDialog";
import { InkChoicePickerDialog } from "./InkChoicePickerDialog";
import { InkEffortSelectorDialog } from "./InkEffortSelectorDialog";
import { InkHelpDialog } from "./InkHelpDialog";
import { InkModelSelectorDialog } from "./InkModelSelectorDialog";
import { InkExperimentsSelectorDialog } from "./InkExperimentsSelectorDialog";
import { InkPluginMcpSelectorDialog } from "./InkPluginMcpSelectorDialog";
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
        <InkHelpDialog
          dialog={dialog}
          width={width}
          maxVisible={maxVisible}
        />
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
      return (
        <InkPluginMcpSelectorDialog selector={dialog.pluginMcpSelector} />
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
    view.dialog.active === "plugin-mcp-selector"
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

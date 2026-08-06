import { Box, Text } from "ink";
import { type ReactNode } from "react";

import type { TerminalViewState } from "../../terminal-view-state";

import { InkApprovalDialog } from "./InkApprovalDialog";
import { InkHelpDialog } from "./InkHelpDialog";
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
    return (
      <InkQuestionDialog
        request={dialog.pendingQuestion}
        selectedIndex={dialog.selectedIndex}
        otherMode={dialog.questionOtherMode}
        otherText={dialog.questionOtherText}
        multiSelections={new Set(dialog.questionMultiSelections)}
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

  // Help renders its own top rule and title row; skip the outer chrome there.
  if (view.dialog.active === "help") {
    return body;
  }

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      <Text bold>{title}</Text>
      {body}
    </Box>
  );
}

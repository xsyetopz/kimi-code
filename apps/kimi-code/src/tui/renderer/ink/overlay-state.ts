import type { ApprovalPreviewBlock } from "#/tui/components/dialogs/approval-preview-body";

import {
  createInkQuestionWizardState,
  type InkQuestionWizardState,
} from "./question-wizard";

/** Ink-owned dialog and overlay state. Unused when the rollback renderer is active. */
export interface InkOverlayState {
  dialogSelectedIndex: number;
  dialogScrollTop: number;
  approvalFeedbackMode: boolean;
  approvalFeedbackText: string;
  approvalPreviewBlock: ApprovalPreviewBlock | null;
  approvalPreviewScrollTop: number;
  questionWizard: InkQuestionWizardState | null;
}

export function createInkOverlayState(): InkOverlayState {
  return {
    dialogSelectedIndex: 0,
    dialogScrollTop: 0,
    approvalFeedbackMode: false,
    approvalFeedbackText: "",
    approvalPreviewBlock: null,
    approvalPreviewScrollTop: 0,
    questionWizard: null,
  };
}

export function resetInkOverlayApproval(overlay: InkOverlayState): void {
  overlay.approvalFeedbackMode = false;
  overlay.approvalFeedbackText = "";
  overlay.dialogSelectedIndex = 0;
  overlay.approvalPreviewBlock = null;
  overlay.approvalPreviewScrollTop = 0;
}

export function resetInkOverlayQuestion(overlay: InkOverlayState): void {
  overlay.dialogSelectedIndex = 0;
  overlay.questionWizard = null;
}

export function initInkOverlayQuestion(
  overlay: InkOverlayState,
  questionCount: number,
): void {
  overlay.dialogSelectedIndex = 0;
  overlay.questionWizard = createInkQuestionWizardState(questionCount);
}

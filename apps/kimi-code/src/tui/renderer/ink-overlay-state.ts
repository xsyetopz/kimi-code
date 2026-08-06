import type { ApprovalPreviewBlock } from "#/tui/components/dialogs/approval-preview-body";

/** Ink-owned dialog and overlay state. Unused when the rollback renderer is active. */
export interface InkOverlayState {
  dialogSelectedIndex: number;
  dialogScrollTop: number;
  approvalFeedbackMode: boolean;
  approvalFeedbackText: string;
  questionMultiSelections: Set<number>;
  approvalPreviewBlock: ApprovalPreviewBlock | null;
  approvalPreviewScrollTop: number;
  questionOtherMode: boolean;
  questionOtherText: string;
  questionCommittedOtherText: string;
}

export function createInkOverlayState(): InkOverlayState {
  return {
    dialogSelectedIndex: 0,
    dialogScrollTop: 0,
    approvalFeedbackMode: false,
    approvalFeedbackText: "",
    questionMultiSelections: new Set(),
    approvalPreviewBlock: null,
    approvalPreviewScrollTop: 0,
    questionOtherMode: false,
    questionOtherText: "",
    questionCommittedOtherText: "",
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
  overlay.questionMultiSelections = new Set();
  overlay.questionOtherMode = false;
  overlay.questionOtherText = "";
  overlay.questionCommittedOtherText = "";
}

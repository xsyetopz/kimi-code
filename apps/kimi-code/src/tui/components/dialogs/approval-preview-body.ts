import {
  highlightLines,
  langFromPath,
} from "#/tui/components/media/code-highlight";
import { renderDiffLinesClustered } from "#/tui/components/media/diff-preview";
import type {
  DiffDisplayBlock,
  DisplayBlock,
  FileContentDisplayBlock,
} from "#/tui/reverse-rpc/types";
import { currentTheme } from "#/tui/theme";

export type ApprovalPreviewBlock = DiffDisplayBlock | FileContentDisplayBlock;

export interface ApprovalPreviewBody {
  readonly lines: readonly string[];
  readonly title: string;
}

export function findApprovalPreviewBlock(
  display: readonly DisplayBlock[],
): ApprovalPreviewBlock | undefined {
  for (const block of display) {
    if (block.type === "diff" || block.type === "file_content") return block;
  }
  return;
}

export function buildApprovalPreviewBody(
  block: ApprovalPreviewBlock,
): ApprovalPreviewBody {
  if (block.type === "diff") {
    return buildDiffBody(block);
  }
  return buildFileContentBody(block);
}

function buildDiffBody(block: DiffDisplayBlock): ApprovalPreviewBody {
  const rendered = renderDiffLinesClustered(
    block.old_text,
    block.new_text,
    block.path,
    {
      contextLines: 3,
      oldStart: block.old_start ?? 1,
      newStart: block.new_start ?? 1,
    },
  );
  const [header = "", ...rest] = rendered;
  return { lines: rest, title: stripLeadingSpace(header) };
}

function buildFileContentBody(block: FileContentDisplayBlock): ApprovalPreviewBody {
  const lang = block.language ?? langFromPath(block.path);
  const highlighted = highlightLines(block.content, lang);
  const lines = highlighted.map(
    (line, index) =>
      currentTheme.fg("diffGutter", String(index + 1).padStart(4) + "  ") + line,
  );
  const title = currentTheme.fg("textStrong", block.path);
  return { lines, title };
}

function stripLeadingSpace(text: string): string {
  return text.replace(/^ +/, "");
}

export function approvalPreviewViewableRows(height: number): number {
  return Math.max(1, height - 4);
}

export function approvalPreviewMaxScroll(
  lineCount: number,
  viewableRows: number,
): number {
  return Math.max(0, lineCount - viewableRows);
}

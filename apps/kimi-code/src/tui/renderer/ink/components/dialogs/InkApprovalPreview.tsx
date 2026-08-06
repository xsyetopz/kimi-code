import { truncateToWidth, visibleWidth } from "@moonshot-ai/kimi-tui";
import { Box, Text, useStdout } from "ink";
import { type ReactNode, useMemo } from "react";

import {
  approvalPreviewMaxScroll,
  approvalPreviewViewableRows,
  buildApprovalPreviewBody,
  type ApprovalPreviewBlock,
} from "../../../../components/dialogs/approval-preview-body";
import { currentTheme } from "../../../../theme";

export interface InkApprovalPreviewProps {
  readonly block: ApprovalPreviewBlock;
  readonly scrollTop: number;
  readonly width?: number;
  readonly height?: number;
}

const ELLIPSIS = "…";

function padToWidth(line: string, width: number): string {
  const w = visibleWidth(line);
  if (w === width) return line;
  if (w > width) return truncateToWidth(line, width, ELLIPSIS);
  return line + " ".repeat(width - w);
}

function fitExactly(line: string, width: number): string {
  let s = line;
  if (visibleWidth(s) > width) s = truncateToWidth(s, width, ELLIPSIS);
  return padToWidth(s, width);
}

export function inkApprovalPreviewViewableRows(height: number): number {
  return approvalPreviewViewableRows(height);
}

export function inkApprovalPreviewMaxScroll(
  lineCount: number,
  viewableRows: number,
): number {
  return approvalPreviewMaxScroll(lineCount, viewableRows);
}

/**
 * Full-screen approval diff/content preview for the Ink renderer.
 * Mirrors ApprovalPreviewViewer layout without mounting kimi-tui components.
 */
export function InkApprovalPreview({
  block,
  scrollTop,
  width: widthOverride,
  height: heightOverride,
}: InkApprovalPreviewProps): ReactNode {
  const { stdout } = useStdout();
  const width = Math.max(20, widthOverride ?? stdout.columns ?? 80);
  const height = Math.max(5, heightOverride ?? stdout.rows ?? 24);
  const built = useMemo(() => buildApprovalPreviewBody(block), [block]);
  const viewableRows = inkApprovalPreviewViewableRows(height);
  const maxScroll = inkApprovalPreviewMaxScroll(
    built.lines.length,
    viewableRows,
  );
  const clampedScroll = Math.max(0, Math.min(scrollTop, maxScroll));
  const innerWidth = Math.max(1, width - 4);
  const bodyHeight = height - 2;
  const viewRows = Math.max(1, bodyHeight - 2);
  const lineFrom = built.lines.length === 0 ? 0 : clampedScroll + 1;
  const lineTo = Math.min(built.lines.length, clampedScroll + viewRows);
  const percent =
    maxScroll === 0
      ? 100
      : Math.round((clampedScroll / maxScroll) * 100);

  const header = fitExactly(
    currentTheme.boldFg("primary", " Preview ") + built.title,
    width,
  );
  const topBorder = currentTheme.fg(
    "primary",
    "┌" + "─".repeat(Math.max(0, width - 2)) + "┐",
  );
  const bottomBorder = currentTheme.fg(
    "primary",
    "└" + "─".repeat(Math.max(0, width - 2)) + "┘",
  );
  const footerLeft =
    ` ${currentTheme.boldFg("primary", "↑↓")} ${currentTheme.fg("textMuted", "line")}` +
    `  ${currentTheme.boldFg("primary", "PgUp/PgDn")} ${currentTheme.fg("textMuted", "page")}` +
    `  ${currentTheme.boldFg("primary", "g/G")} ${currentTheme.fg("textMuted", "top/bot")}` +
    `  ${currentTheme.boldFg("primary", "Q/Esc/Ctrl+E")} ${currentTheme.fg("textMuted", "cancel")}`;
  const footerRight = currentTheme.fg(
    "textMuted",
    ` ${String(lineFrom)}-${String(lineTo)} / ${String(built.lines.length)} (${String(percent)}%) `,
  );

  return (
    <Box flexDirection="column" height={height}>
      <Text>{header}</Text>
      <Text>{topBorder}</Text>
      {Array.from({ length: viewRows }, (_, index) => {
        const raw = built.lines[clampedScroll + index] ?? "";
        const line =
          currentTheme.fg("primary", "│ ") +
          fitExactly(raw, innerWidth) +
          currentTheme.fg("primary", " │");
        return <Text key={`preview-line-${index}`}>{line}</Text>;
      })}
      <Text>{bottomBorder}</Text>
      <Text>{fitExactly(footerLeft + footerRight, width)}</Text>
    </Box>
  );
}

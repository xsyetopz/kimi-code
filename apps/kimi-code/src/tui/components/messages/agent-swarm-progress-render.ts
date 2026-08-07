import { truncateToWidth, visibleWidth } from "@moonshot-ai/kimi-tui";
import chalk from "chalk";

import {
  brailleBar,
  BRAILLE_LEVELS,
} from "#/tui/components/messages/agent-swarm-progress-braille";
import { calculateAgentSwarmGridLayout } from "#/tui/components/messages/agent-swarm-progress-layout";
import type { AgentSwarmGridLayout } from "#/tui/components/messages/agent-swarm-progress-render-types";
import {
  collapseWhitespace,
  latestNonEmptyLine,
  normalizeFinalOutputText,
} from "#/tui/components/messages/agent-swarm-progress-parse";
import {
  ABORTED_LABEL,
  type AgentSwarmMember,
  type AgentSwarmPhase,
  type AgentSwarmSnapshot,
  PHASE_LABELS,
  type AgentSwarmProgressCoreState,
  runningCellLabelText,
  terminalPhaseElapsedMs,
} from "#/tui/components/messages/agent-swarm-progress-state";
import { FAILURE_MARK, SUCCESS_MARK } from "#/tui/constant/symbols";
import type { ColorPalette } from "#/tui/theme/colors";
import { gradientText } from "#/tui/theme/gradient-text";

const STATUS_BAR_CHAR = "━";
const CANCELLED_MARK = "⊘ ";
const TOTAL_STATUS_BAR_GAP = 2;
const PROMPTING_TEXT_TRAILING_GAP = 1;
const ACTIVITY_SPINNER_PLACEHOLDER = "  ";
const AGENT_SWARM_LEFT_INDENT = " ";
const AGENT_SWARM_RIGHT_GAP = 1;
const ORCHESTRATING_LABEL = "Orchestrating...";
const PROMPTING_LABEL = "Prompting...";
const WORKING_LABEL = "Working...";
const COMPLETED_LABEL = "Completed.";
const FAILED_LABEL = "Failed.";
const QUEUED_LABEL = "Queued...";
const SUSPENDED_LABEL = "Rate limited...";
const AGENT_SWARM_TITLE_ACCENT_BIAS = 1.3;

const STATUS_BAR_ORDER = [
  "completed",
  "working",
  "suspended",
  "queued",
  "cancelled",
  "failed",
] as const;

type StatusBarPhase = (typeof STATUS_BAR_ORDER)[number];
type TotalStatus = "working" | "completed" | "suspended" | "failed" | "aborted";

interface AgentSwarmSummary {
  readonly active: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
}

interface StatusBarCount {
  readonly phase: StatusBarPhase;
  readonly count: number;
}

export interface AgentSwarmProgressRenderInput {
  readonly state: AgentSwarmProgressCoreState;
  readonly colors: ColorPalette;
  readonly activitySpinnerText: (() => string) | undefined;
  readonly availableGridHeight: (() => number | undefined) | undefined;
}

export function renderAgentSwarmProgressLines(
  input: AgentSwarmProgressRenderInput,
  width: number,
): string[] {
  const { state, colors, activitySpinnerText, availableGridHeight } = input;
  const outerWidth = Math.max(1, width);
  const innerWidth = Math.max(
    1,
    outerWidth -
      visibleWidth(AGENT_SWARM_LEFT_INDENT) -
      AGENT_SWARM_RIGHT_GAP,
  );
  if (state.members.length === 0) {
    const lines = [
      "",
      renderHeader(state, innerWidth, undefined, colors),
      "",
      renderStatusLine(state, innerWidth, colors, activitySpinnerText),
      "",
    ];
    return indentLines(lines, outerWidth);
  }

  const nowMs = Date.now();
  const snapshots = state.members.map(
    (member): AgentSwarmSnapshot => ({
      phase: member.phase,
      ticks: member.ticks,
      latestModelText: member.latestModelText,
      phaseElapsedMs: terminalPhaseElapsedMs(member, nowMs),
    }),
  );
  const summary = summarizeSnapshots(snapshots);
  const gridLines =
    state.swarmFailureText === undefined
      ? renderGrid(
          state,
          innerWidth,
          availableGridHeight?.(),
          snapshots,
          nowMs,
          colors,
        )
      : [renderSwarmFailureLine(state, innerWidth, colors)];
  const lines = [
    "",
    renderHeader(state, innerWidth, summary, colors),
    "",
    ...gridLines,
    "",
    renderStatusLine(state, innerWidth, colors, activitySpinnerText),
    "",
  ];
  return indentLines(lines, outerWidth);
}

function renderSwarmFailureLine(
  state: AgentSwarmProgressCoreState,
  width: number,
  colors: ColorPalette,
): string {
  const text = `${FAILURE_MARK}${state.swarmFailureText ?? ""}`;
  return truncateWithColor(text, width, colors.error);
}

function indentLines(lines: readonly string[], width: number): string[] {
  const contentWidth = Math.max(
    0,
    width - visibleWidth(AGENT_SWARM_LEFT_INDENT) - AGENT_SWARM_RIGHT_GAP,
  );
  return lines.map((line) =>
    truncateToWidth(
      AGENT_SWARM_LEFT_INDENT + truncateToWidth(line, contentWidth),
      width,
    ),
  );
}

function renderHeader(
  state: AgentSwarmProgressCoreState,
  width: number,
  _summary: AgentSwarmSummary | undefined,
  colors: ColorPalette,
): string {
  if (width <= 3) return chalk.hex(colors.primary)("─".repeat(width));

  const title = gradientText(
    "Agent Swarm",
    colors.primary,
    colors.accent,
    AGENT_SWARM_TITLE_ACCENT_BIAS,
  );
  const description =
    state.description.length > 0
      ? chalk.hex(colors.primary)(" ─ ") +
        chalk.hex(colors.text)(state.description)
      : "";
  const model =
    state.modelDisplay.length > 0
      ? chalk.hex(colors.primary)(" ─ ") +
        chalk.hex(colors.textDim)(state.modelDisplay)
      : "";
  const prefixText = "─ ";
  const labelWidth = Math.max(1, width - visibleWidth(prefixText) - 1);
  const label = truncateToWidth(title + description + model, labelWidth);
  const suffixWidth = Math.max(
    0,
    width - visibleWidth(prefixText) - visibleWidth(label),
  );
  const suffix =
    suffixWidth === 0 ? "" : ` ${"─".repeat(Math.max(0, suffixWidth - 1))}`;
  return (
    chalk.hex(colors.primary)(prefixText) +
    label +
    chalk.hex(colors.primary)(suffix)
  );
}

function renderStatusLine(
  state: AgentSwarmProgressCoreState,
  width: number,
  colors: ColorPalette,
  activitySpinnerText: (() => string) | undefined,
): string {
  const status = totalStatus(state.members, {
    failed: state.failed,
    aborted: state.aborted,
  });
  const prefix = renderActivityPrefix(
    state,
    status,
    colors,
    activitySpinnerText,
  );
  if (prefix.length > 0) {
    const contentWidth = Math.max(0, width - visibleWidth(prefix));
    if (contentWidth <= 0) return truncateToWidth(prefix, width);
    return truncateToWidth(
      `${prefix}${renderStatusLineContent(state, contentWidth, status, colors)}`,
      width,
    );
  }
  return renderStatusLineContent(state, width, status, colors);
}

function renderActivityPrefix(
  state: AgentSwarmProgressCoreState,
  status: TotalStatus,
  colors: ColorPalette,
  activitySpinnerText: (() => string) | undefined,
): string {
  if (state.toolCallActive) return activitySpinnerText?.() ?? "";
  return activityPrefixForTotalStatus(status, colors);
}

function renderStatusLineContent(
  state: AgentSwarmProgressCoreState,
  width: number,
  status: TotalStatus,
  colors: ColorPalette,
): string {
  if (status !== "working")
    return renderProgressStatusLine(state, width, status, colors);

  if (!state.inputComplete) {
    return renderOrchestratingStatusLine(state, width, colors);
  }

  return renderProgressStatusLine(state, width, status, colors);
}

function renderProgressStatusLine(
  state: AgentSwarmProgressCoreState,
  width: number,
  status: TotalStatus,
  colors: ColorPalette,
): string {
  const label = renderStatusLabel(
    totalStatusLabel(status),
    totalStatusLabelColor(status, state.members, colors),
  );
  if (state.members.length === 0) return truncateToWidth(label, width);
  const barWidth = Math.max(
    0,
    width - visibleWidth(label) - TOTAL_STATUS_BAR_GAP,
  );
  if (barWidth <= 0) return truncateToWidth(label, width);
  return truncateToWidth(
    `${label}${" ".repeat(TOTAL_STATUS_BAR_GAP)}${renderStatusPipBar(state.members, barWidth, colors)}`,
    width,
  );
}

function renderOrchestratingStatusLine(
  state: AgentSwarmProgressCoreState,
  width: number,
  colors: ColorPalette,
): string {
  if (state.itemsStarted) {
    return truncateToWidth(
      renderStatusLabel(ORCHESTRATING_LABEL, colors.primary),
      width,
    );
  }

  const promptTemplate = collapseWhitespace(state.promptTemplateText);
  const label = renderStatusLabel(
    promptTemplate.length > 0 ? PROMPTING_LABEL : ORCHESTRATING_LABEL,
    colors.primary,
  );
  if (promptTemplate.length === 0) return truncateToWidth(label, width);

  const availablePromptWidth = Math.max(
    0,
    width - visibleWidth(label) - PROMPTING_TEXT_TRAILING_GAP,
  );
  const separator =
    visibleWidth(promptTemplate) <= availablePromptWidth - 1 ? " " : "  ";
  const promptWidth = Math.max(
    0,
    availablePromptWidth - visibleWidth(separator),
  );
  if (promptWidth <= 0) return truncateToWidth(label, width);
  const prompt = chalk.hex(colors.textDim)(
    truncateStartToWidth(promptTemplate, promptWidth),
  );
  return truncateToWidth(`${label}${separator}${prompt}`, width);
}

function renderGrid(
  state: AgentSwarmProgressCoreState,
  width: number,
  height: number | undefined,
  snapshots: readonly AgentSwarmSnapshot[],
  nowMs: number,
  colors: ColorPalette,
): string[] {
  const layout = calculateAgentSwarmGridLayout({
    width,
    height: height ?? Number.POSITIVE_INFINITY,
    count: state.members.length,
  });
  const columns = Math.max(1, layout.columns);
  const rows = layout.rows;
  const cellGap = " ".repeat(layout.columnGap);
  const leftPadding = " ".repeat(layout.leftPadding);
  const lines: string[] = [];

  for (let row = 0; row < rows; row += 1) {
    const cells: string[] = [];
    for (let col = 0; col < columns; col += 1) {
      const index = row * columns + col;
      const member = state.members[index];
      const snapshot = snapshots[index];
      if (member === undefined || snapshot === undefined) continue;
      cells.push(
        padAnsi(
          renderCell(state, member, snapshot, layout, nowMs, colors),
          layout.cellWidth,
        ),
      );
    }
    lines.push(leftPadding + cells.join(cellGap));
  }
  return lines;
}

function renderCell(
  state: AgentSwarmProgressCoreState,
  member: AgentSwarmMember,
  snapshot: AgentSwarmSnapshot,
  layout: AgentSwarmGridLayout,
  nowMs: number,
  colors: ColorPalette,
): string {
  const width = layout.cellWidth;
  if (snapshot.phase === "pending") {
    return renderPendingCell(member, width, colors);
  }
  if (snapshot.phase === "cancelled" && snapshot.ticks <= 0) {
    return renderCancelledUnstartedCell(member, width, colors);
  }
  if (!layout.renderText) {
    return renderCompactCell(
      state,
      member,
      snapshot,
      layout.barCells,
      nowMs,
      colors,
    );
  }
  if (snapshot.phase === "queued" && snapshot.ticks <= 0) {
    return renderQueuedCell(member, width, colors);
  }

  const estimate = state.progressEstimator.estimate({
    memberKey: member.id,
    phase: snapshot.phase,
    capacityTicks: layout.barCells * BRAILLE_LEVELS.length,
    nowMs,
  });
  const id = chalk.hex(colors.primary)(member.id);
  const bar = brailleBar(
    estimate.displayTicks,
    snapshot.phase,
    layout.barCells,
    colors,
    snapshot.phaseElapsedMs,
    cancelledProgressColor(member, snapshot.phase, colors),
  );
  const prefix = `${id} ${bar} `;
  const labelWidth = Math.max(1, width - visibleWidth(prefix));
  const label = renderCellLabel(member, snapshot, labelWidth, colors);
  return prefix + label;
}

function renderCompactCell(
  state: AgentSwarmProgressCoreState,
  member: AgentSwarmMember,
  snapshot: AgentSwarmSnapshot,
  barCells: number,
  nowMs: number,
  colors: ColorPalette,
): string {
  const estimatePhase =
    snapshot.phase === "pending" ? "queued" : snapshot.phase;
  const estimate = state.progressEstimator.estimate({
    memberKey: member.id,
    phase: estimatePhase,
    capacityTicks: barCells * BRAILLE_LEVELS.length,
    nowMs,
  });
  const id = chalk.hex(colors.primary)(member.id);
  const bar = brailleBar(
    estimate.displayTicks,
    estimatePhase,
    barCells,
    colors,
    snapshot.phaseElapsedMs,
    cancelledProgressColor(member, snapshot.phase, colors),
  );
  return `${id} ${bar}${compactTerminalMark(member, snapshot.phase, colors)}`;
}

function summarizeSnapshots(
  snapshots: readonly AgentSwarmSnapshot[],
): AgentSwarmSummary {
  let completed = 0;
  let failed = 0;
  let cancelled = 0;
  for (const snapshot of snapshots) {
    if (snapshot.phase === "completed") completed += 1;
    if (snapshot.phase === "failed") failed += 1;
    if (snapshot.phase === "cancelled") cancelled += 1;
  }
  return {
    active: snapshots.length - completed - failed - cancelled,
    completed,
    failed,
    cancelled,
  };
}

function cancelledProgressColor(
  member: AgentSwarmMember,
  phase: AgentSwarmPhase,
  colors: ColorPalette,
): string | undefined {
  if (phase !== "cancelled") return undefined;
  return member.cancelledBarColor ?? colors.warning;
}

function phaseColor(phase: AgentSwarmPhase, colors: ColorPalette): string {
  const map: Record<AgentSwarmPhase, string> = {
    pending: colors.textDim,
    queued: colors.textDim,
    suspended: colors.textDim,
    running: colors.textDim,
    completed: colors.success,
    failed: colors.error,
    cancelled: colors.warning,
  };
  return map[phase];
}

function renderStatusPipBar(
  members: readonly AgentSwarmMember[],
  width: number,
  colors: ColorPalette,
): string {
  const safeWidth = Math.max(1, width);
  const counts = statusBarCounts(members);
  if (counts.length === 0) {
    return chalk.hex(colors.textMuted)(STATUS_BAR_CHAR.repeat(safeWidth));
  }

  const segmentWidths = allocateSegmentWidths(
    counts.map((entry) => entry.count),
    safeWidth,
  );
  return counts
    .map((entry, index) => {
      const segmentWidth = segmentWidths[index] ?? 0;
      if (segmentWidth <= 0) return "";
      return chalk.hex(statusBarColor(entry.phase, colors))(
        STATUS_BAR_CHAR.repeat(segmentWidth),
      );
    })
    .join("");
}

function renderStatusLabel(label: string, color: string): string {
  return ` ${chalk.hex(color)(label)}`;
}

function activityPrefixForTotalStatus(
  status: TotalStatus,
  colors: ColorPalette,
): string {
  const marks: Record<TotalStatus, string> = {
    completed: SUCCESS_MARK.trimEnd(),
    failed: FAILURE_MARK.trimEnd(),
    aborted: CANCELLED_MARK.trimEnd(),
    working: "",
    suspended: "",
  };
  const mark = marks[status];
  return mark.length > 0
    ? ` ${chalk.hex(totalStatusColor(status, colors))(mark)}`
    : ACTIVITY_SPINNER_PLACEHOLDER;
}

function statusBarCounts(
  members: readonly AgentSwarmMember[],
): StatusBarCount[] {
  const counts = new Map<StatusBarPhase, number>();
  for (const member of members) {
    const phase = statusBarPhase(member.phase);
    counts.set(phase, (counts.get(phase) ?? 0) + 1);
  }
  return STATUS_BAR_ORDER.flatMap((phase) => {
    const count = counts.get(phase) ?? 0;
    return count > 0 ? [{ phase, count }] : [];
  });
}

function statusBarPhase(phase: AgentSwarmPhase): StatusBarPhase {
  const map: Record<AgentSwarmPhase, StatusBarPhase> = {
    pending: "queued",
    queued: "queued",
    suspended: "suspended",
    running: "working",
    completed: "completed",
    failed: "failed",
    cancelled: "cancelled",
  };
  return map[phase];
}

function statusBarColor(phase: StatusBarPhase, colors: ColorPalette): string {
  const map: Record<StatusBarPhase, string> = {
    queued: colors.textMuted,
    working: colors.primary,
    suspended: colors.textMuted,
    completed: colors.success,
    failed: colors.error,
    cancelled: colors.warning,
  };
  return map[phase];
}

function totalStatus(
  members: readonly AgentSwarmMember[],
  force: { readonly failed: boolean; readonly aborted: boolean },
): TotalStatus {
  if (force.aborted) return "aborted";
  const phases = new Set(members.map((m) => m.phase));
  const hasActive =
    phases.has("pending") ||
    phases.has("queued") ||
    phases.has("suspended") ||
    phases.has("running");
  if (!hasActive && members.length > 0) {
    if (phases.has("cancelled")) return "aborted";
    if (phases.has("completed")) return "completed";
    return "failed";
  }
  if (force.failed) return "failed";
  if (phases.has("suspended") && !phases.has("running")) return "suspended";
  return "working";
}

function totalStatusLabel(status: TotalStatus): string {
  const map: Record<TotalStatus, string> = {
    working: WORKING_LABEL,
    completed: COMPLETED_LABEL,
    suspended: SUSPENDED_LABEL,
    failed: FAILED_LABEL,
    aborted: ABORTED_LABEL,
  };
  return map[status];
}

function totalStatusColor(status: TotalStatus, colors: ColorPalette): string {
  const map: Record<TotalStatus, string> = {
    working: colors.success,
    completed: colors.success,
    suspended: colors.textDim,
    failed: colors.error,
    aborted: colors.warning,
  };
  return map[status];
}

function totalStatusLabelColor(
  status: TotalStatus,
  members: readonly AgentSwarmMember[],
  colors: ColorPalette,
): string {
  if (
    status === "working" &&
    !members.some((member) => member.phase === "completed")
  ) {
    return colors.primary;
  }
  return totalStatusColor(status, colors);
}

function allocateSegmentWidths(
  counts: readonly number[],
  width: number,
): number[] {
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total <= 0 || width <= 0) return counts.map(() => 0);

  const exact = counts.map((count) => (count * width) / total);
  const widths = exact.map(Math.floor);
  let remaining = width - widths.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .toSorted((a, b) => b.fraction - a.fraction || a.index - b.index);

  for (const entry of order) {
    if (remaining <= 0) break;
    widths[entry.index] = (widths[entry.index] ?? 0) + 1;
    remaining -= 1;
  }
  return widths;
}

function renderCellLabel(
  member: AgentSwarmMember,
  snapshot: AgentSwarmSnapshot,
  width: number,
  colors: ColorPalette,
): string {
  const latestLine = latestNonEmptyLine(snapshot.latestModelText);
  if (snapshot.phase === "running") {
    return truncateWithColor(
      runningCellLabelText(member),
      width,
      colors.textDim,
    );
  }
  if (snapshot.phase === "failed" && member.failureText !== undefined) {
    return truncateWithColor(
      `${FAILURE_MARK}${member.failureText}`,
      width,
      colors.error,
    );
  }
  if (snapshot.phase === "completed") {
    return renderCompletedCellLabel(
      member.completedText ?? latestLine,
      width,
      colors,
    );
  }
  if (snapshot.phase === "cancelled") {
    return renderCancelledCellLabel(member, width, colors);
  }
  return truncateWithColor(
    PHASE_LABELS[snapshot.phase],
    width,
    phaseColor(snapshot.phase, colors),
  );
}

function renderCancelledCellLabel(
  member: AgentSwarmMember,
  width: number,
  colors: ColorPalette,
): string {
  const labelText = member.cancelledLabelText ?? ABORTED_LABEL;
  const labelColor = member.cancelledLabelColor ?? colors.warning;
  const markColor = member.cancelledMarkColor ?? colors.warning;
  const labelStyle = chalk.hex(labelColor);
  return truncateToWidth(
    chalk.hex(markColor)(CANCELLED_MARK) + labelStyle(labelText),
    width,
    labelStyle("…"),
  );
}

function renderCompletedCellLabel(
  text: string,
  width: number,
  colors: ColorPalette,
): string {
  const finalText = normalizeFinalOutputText(text);
  const label =
    finalText === undefined
      ? SUCCESS_MARK.trimEnd()
      : `${SUCCESS_MARK}${finalText}`;
  return truncateWithColor(label, width, colors.success);
}

function compactTerminalMark(
  member: AgentSwarmMember,
  phase: AgentSwarmPhase,
  colors: ColorPalette,
): string {
  if (phase === "completed")
    return chalk.hex(colors.success)(SUCCESS_MARK.trimEnd());
  if (phase === "failed")
    return chalk.hex(colors.error)(FAILURE_MARK.trimEnd());
  if (phase === "cancelled") {
    return chalk.hex(member.cancelledMarkColor ?? colors.warning)(
      CANCELLED_MARK.trimEnd(),
    );
  }
  return "";
}

function renderPendingCell(
  member: AgentSwarmMember,
  width: number,
  colors: ColorPalette,
): string {
  const id = chalk.hex(colors.primary)(member.id);
  const prefix = `${id} `;
  const itemText = collapseWhitespace(member.itemText);
  const label = itemText.length > 0 ? itemText : QUEUED_LABEL;
  const labelWidth = Math.max(1, width - visibleWidth(prefix));
  return prefix + truncateWithColor(label, labelWidth, colors.textDim);
}

function renderQueuedCell(
  member: AgentSwarmMember,
  width: number,
  colors: ColorPalette,
): string {
  const id = chalk.hex(colors.primary)(member.id);
  const prefix = `${id} `;
  const labelWidth = Math.max(1, width - visibleWidth(prefix));
  return prefix + truncateWithColor(QUEUED_LABEL, labelWidth, colors.textDim);
}

function renderCancelledUnstartedCell(
  member: AgentSwarmMember,
  width: number,
  colors: ColorPalette,
): string {
  const id = chalk.hex(colors.primary)(member.id);
  const prefix = `${id} `;
  const labelWidth = Math.max(1, width - visibleWidth(prefix));
  return prefix + renderCancelledCellLabel(member, labelWidth, colors);
}

function truncateWithColor(text: string, width: number, color: string): string {
  const colorize = chalk.hex(color);
  return truncateToWidth(colorize(text), width, colorize("…"));
}

function truncateStartToWidth(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  const ellipsis = "…";
  const ellipsisWidth = visibleWidth(ellipsis);
  if (width <= ellipsisWidth) return truncateToWidth(ellipsis, width);

  const targetWidth = width - ellipsisWidth;
  const segments = Array.from(text);
  let tail = "";
  let tailWidth = 0;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index] ?? "";
    const segmentWidth = visibleWidth(segment);
    if (tailWidth + segmentWidth > targetWidth) break;
    tail = segment + tail;
    tailWidth += segmentWidth;
  }
  return ellipsis + tail;
}

function padAnsi(text: string, width: number): string {
  const truncated = truncateToWidth(text, width);
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

export type { AgentSwarmGridLayout } from "#/tui/components/messages/agent-swarm-progress-render-types";

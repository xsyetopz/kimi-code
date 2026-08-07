import type { ToolCallSubagentSnapshot } from "#/tui/components/messages/tool-call";
import { STATUS_BULLET } from "#/tui/constant/symbols";
import { currentTheme } from "#/tui/theme";
import { formatTokenCount } from "#/utils/usage/usage-format";

const DETACH_HINT_TEXT = "Press Ctrl+B to run in background";

export interface AgentGroupViewState {
  readonly agents: readonly ToolCallSubagentSnapshot[];
  readonly showDetachHint: boolean;
}

interface PhaseCounts {
  readonly done: number;
  readonly failed: number;
  readonly backgrounded: number;
  readonly running: number;
  readonly waiting: number;
  readonly starting: number;
  readonly terminal: number;
}

export function shouldShowAgentGroupDetachHint(
  snapshots: readonly ToolCallSubagentSnapshot[],
): boolean {
  return snapshots.some(
    (snapshot) =>
      snapshot.phase === "running" ||
      snapshot.phase === "queued" ||
      snapshot.phase === "spawning" ||
      snapshot.phase === undefined,
  );
}

/** Full Agent group card lines (ANSI) for Ink and parity tests. */
export function projectAgentGroupLines(state: AgentGroupViewState): string[] {
  const snapshots = state.agents;
  const lines: string[] = [""];
  lines.push(buildAgentGroupHeader(snapshots));
  snapshots.forEach((snapshot, index) => {
    lines.push(...buildAgentGroupBodyLines(snapshot, index === snapshots.length - 1));
  });
  if (state.showDetachHint) {
    lines.push(currentTheme.dim(DETACH_HINT_TEXT));
  }
  return lines;
}

function buildAgentGroupHeader(
  snapshots: readonly ToolCallSubagentSnapshot[],
): string {
  const total = snapshots.length;
  const counts = countPhases(snapshots);
  const allDone = counts.terminal === total;
  const bullet = allDone
    ? currentTheme.fg("success", STATUS_BULLET)
    : currentTheme.fg("text", STATUS_BULLET);
  const elapsedSeconds = maxElapsedSeconds(snapshots);

  if (allDone) {
    const types = new Set(
      snapshots.map((snapshot) => snapshot.agentName).filter((name) => name !== undefined),
    );
    const headerLabel =
      types.size === 1
        ? `${String(total)} ${[...types][0]} agents finished`
        : `${String(total)} agents finished`;
    const totalTools = snapshots.reduce((acc, snapshot) => acc + snapshot.toolCount, 0);
    const totalTokens = snapshots.reduce((acc, snapshot) => acc + snapshot.tokens, 0);
    const tail = formatHeaderTail({
      toolCount: totalTools,
      tokens: totalTokens,
      elapsedSeconds,
    });
    return `${bullet}${currentTheme.boldFg("primary", headerLabel)}${tail}`;
  }

  const parts = formatBreakdownParts(counts);
  const headerText =
    parts.length > 0
      ? `Running ${String(total)} agents (${parts.join(", ")})`
      : `Running ${String(total)} agents`;
  const tail = formatHeaderTail({ toolCount: 0, tokens: 0, elapsedSeconds });
  return `${bullet}${currentTheme.boldFg("primary", headerText)}${tail}`;
}

function buildAgentGroupBodyLines(
  snapshot: ToolCallSubagentSnapshot,
  isLast: boolean,
): string[] {
  const dim = (text: string): string => currentTheme.dim(text);
  const branch1 = isLast ? "└─" : "├─";
  const agentType = snapshot.agentName ?? "agent";
  const desc = snapshot.toolCallDescription || "(no description)";
  const tail = formatLineTail(snapshot);
  const namePart = currentTheme.fg("primary", agentType);
  const descPart = dim(`· ${desc}`);
  const stats = formatStats(snapshot);
  const lines = [`  ${branch1} ${namePart} ${descPart}${stats}${tail}`];

  const branch2 = isLast ? "   " : "│  ";
  if (snapshot.phase === "failed") {
    const errLine =
      (snapshot.errorText ?? "Failed").split("\n").at(0) ?? "Failed";
    lines.push(
      `  ${branch2}    ${currentTheme.fg("error", `Error: ${errLine}`)}`,
    );
    return lines;
  }
  if (snapshot.phase === "done" || snapshot.phase === "backgrounded") {
    return lines;
  }
  const activity =
    snapshot.latestActivity ?? fallbackActivityForPhase(snapshot.phase);
  lines.push(`  ${branch2}    ${dim(activity)}`);
  return lines;
}

function countPhases(
  snapshots: readonly ToolCallSubagentSnapshot[],
): PhaseCounts {
  let done = 0;
  let failed = 0;
  let backgrounded = 0;
  let running = 0;
  let waiting = 0;
  let starting = 0;

  for (const snapshot of snapshots) {
    switch (snapshot.phase) {
      case "done":
        done += 1;
        break;
      case "failed":
        failed += 1;
        break;
      case "backgrounded":
        backgrounded += 1;
        break;
      case "queued":
        waiting += 1;
        break;
      case "running":
        running += 1;
        break;
      case "spawning":
      case undefined:
        starting += 1;
        break;
    }
  }

  return {
    done,
    failed,
    backgrounded,
    running,
    waiting,
    starting,
    terminal: done + failed + backgrounded,
  };
}

function formatBreakdownParts(counts: PhaseCounts): string[] {
  const parts: string[] = [];
  if (counts.done > 0) parts.push(`${String(counts.done)} done`);
  if (counts.failed > 0) parts.push(`${String(counts.failed)} failed`);
  if (counts.backgrounded > 0) {
    parts.push(`${String(counts.backgrounded)} backgrounded`);
  }
  if (counts.running > 0) parts.push(`${String(counts.running)} running`);
  if (counts.waiting > 0) parts.push(`${String(counts.waiting)} waiting`);
  if (counts.starting > 0) parts.push(`${String(counts.starting)} starting`);
  return parts;
}

function formatStats(snapshot: ToolCallSubagentSnapshot): string {
  const parts: string[] = [];
  if (snapshot.model !== undefined) parts.push(snapshot.model);
  parts.push(
    `${String(snapshot.toolCount)} tool${snapshot.toolCount === 1 ? "" : "s"}`,
  );
  if (snapshot.elapsedSeconds !== undefined) {
    parts.push(formatElapsed(snapshot.elapsedSeconds));
  }
  if (snapshot.tokens > 0) parts.push(formatTokens(snapshot.tokens));
  return currentTheme.dim(` · ${parts.join(" · ")}`);
}

function formatLineTail(snapshot: ToolCallSubagentSnapshot): string {
  const separator = currentTheme.dim(" · ");
  switch (snapshot.phase) {
    case "done":
      return separator + currentTheme.fg("success", "✓ Completed");
    case "failed":
      return separator + currentTheme.fg("error", "✗ Failed");
    case "backgrounded":
      return separator + currentTheme.dim("◐ backgrounded");
    case "queued":
      return separator + currentTheme.fg("primary", "Waiting");
    case "running":
      return separator + currentTheme.fg("primary", "Running");
    case "spawning":
    case undefined:
      return separator + currentTheme.fg("primary", "Starting");
  }
}

function fallbackActivityForPhase(
  phase: ToolCallSubagentSnapshot["phase"],
): string {
  switch (phase) {
    case "queued":
      return "Waiting to start…";
    case "running":
      return "Still working…";
    case "spawning":
    case undefined:
      return "Starting…";
    case "done":
    case "failed":
    case "backgrounded":
      return "";
  }
}

function formatHeaderTail(args: {
  readonly toolCount: number;
  readonly tokens: number;
  readonly elapsedSeconds: number | undefined;
}): string {
  const parts: string[] = [];
  if (args.toolCount > 0) {
    parts.push(
      `${String(args.toolCount)} tool${args.toolCount === 1 ? "" : "s"}`,
    );
  }
  if (args.tokens > 0) parts.push(formatTokens(args.tokens));
  if (args.elapsedSeconds !== undefined) {
    parts.push(formatElapsed(args.elapsedSeconds));
  }
  return parts.length > 0 ? currentTheme.dim(` · ${parts.join(" · ")}`) : "";
}

function maxElapsedSeconds(
  snapshots: readonly ToolCallSubagentSnapshot[],
): number | undefined {
  let max: number | undefined;
  for (const snapshot of snapshots) {
    const elapsed = snapshot.elapsedSeconds;
    if (elapsed === undefined) continue;
    max = max === undefined ? elapsed : Math.max(max, elapsed);
  }
  return max;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes)}m ${String(remainder)}s`;
}

function formatTokens(count: number): string {
  return `${formatTokenCount(count)} tok`;
}

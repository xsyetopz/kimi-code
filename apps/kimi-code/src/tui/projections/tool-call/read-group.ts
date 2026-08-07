import type { ToolCallReadSnapshot } from "#/tui/components/messages/tool-call";
import { STATUS_BULLET } from "#/tui/constant/symbols";
import { currentTheme } from "#/tui/theme";

export interface ReadGroupViewState {
  readonly reads: readonly ToolCallReadSnapshot[];
}

/** Full Read group card lines (ANSI) for Ink and parity tests. */
export function projectReadGroupLines(state: ReadGroupViewState): string[] {
  const snapshots = state.reads;
  const lines: string[] = [""];
  let pending = 0;
  let failed = 0;
  let totalLines = 0;
  for (const snapshot of snapshots) {
    if (snapshot.phase === "pending") pending += 1;
    else if (snapshot.phase === "failed") failed += 1;
    else totalLines += snapshot.lines;
  }
  lines.push(buildReadGroupHeader(snapshots.length, pending, failed, totalLines));
  const visibleSnapshots = snapshots.filter(
    (snapshot) => snapshot.filePath !== undefined && snapshot.filePath.length > 0,
  );
  visibleSnapshots.forEach((snapshot, index) => {
    lines.push(
      buildReadGroupBodyLine(snapshot, index === visibleSnapshots.length - 1),
    );
  });
  return lines;
}

function buildReadGroupHeader(
  total: number,
  pending: number,
  failed: number,
  totalLines: number,
): string {
  const dim = (text: string): string => currentTheme.dim(text);

  if (pending > 0) {
    const bullet = currentTheme.fg("text", STATUS_BULLET);
    const label = currentTheme.boldFg(
      "primary",
      `Reading ${String(total)} files…`,
    );
    return `${bullet}${label}`;
  }

  if (failed === total) {
    const bullet = currentTheme.fg("error", "✗ ");
    const label = currentTheme.boldFg("error", `Read ${String(total)} files`);
    return `${bullet}${label}${currentTheme.fg("error", " · failed")}`;
  }

  const bullet = currentTheme.fg("success", STATUS_BULLET);
  const label = currentTheme.boldFg("primary", `Read ${String(total)} files`);
  const linesPart = dim(
    ` · ${String(totalLines)} ${totalLines === 1 ? "line" : "lines"}`,
  );
  const failPart =
    failed > 0 ? currentTheme.fg("error", ` · ${String(failed)} failed`) : "";
  return `${bullet}${label}${linesPart}${failPart}`;
}

function buildReadGroupBodyLine(
  snapshot: ToolCallReadSnapshot,
  isLast: boolean,
): string {
  const dim = (text: string): string => currentTheme.dim(text);
  const branch = isLast ? "└─" : "├─";
  const path = snapshot.filePath ?? "";
  const pathPart = currentTheme.fg("text", path);

  let tail: string;
  if (snapshot.phase === "pending") {
    tail = dim(" · reading…");
  } else if (snapshot.phase === "failed") {
    tail = currentTheme.fg("error", " · failed");
  } else {
    tail = dim(
      ` · ${String(snapshot.lines)} ${snapshot.lines === 1 ? "line" : "lines"}`,
    );
  }
  return `  ${branch} ${pathPart}${tail}`;
}

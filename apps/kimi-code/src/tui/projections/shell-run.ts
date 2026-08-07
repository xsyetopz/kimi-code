import {
  formatBashOutputForDisplay,
  sanitizeShellOutput,
} from "#/tui/utils/shell-output";
import { currentTheme } from "#/tui/theme";
import type { ShellRunViewState } from "#/tui/types";

const RUNNING_TAIL_LINES = 5;

/** ANSI lines for a live or finished `!` shell command card. */
export function projectShellRunLines(state: ShellRunViewState): string[] {
  try {
    if (state.phase === "backgrounded") {
      return [`  ${currentTheme.fg("textDim", "Moved to background.")}`];
    }
    if (state.phase === "finished") {
      return formatBashOutputForDisplay(
        state.stdout,
        state.stderr,
        state.isError,
      )
        .split("\n")
        .map((line) => `  ${line}`);
    }

    const elapsed = Math.floor((Date.now() - state.startedAtMs) / 1000);
    const dim = (s: string): string => currentTheme.fg("textDim", s);
    const trimmed = sanitizeShellOutput(state.combinedOutput).trimEnd();
    const lines: string[] = [];
    let extra = 0;
    if (trimmed.length === 0) {
      lines.push(`  ${dim("Running…")}`);
    } else {
      const bodyLines = trimmed.split("\n");
      const tail = bodyLines.slice(-RUNNING_TAIL_LINES);
      extra = Math.max(0, bodyLines.length - RUNNING_TAIL_LINES);
      lines.push(...tail.map((line) => `  ${dim(line)}`));
    }
    lines.push(
      `  ${dim(`${extra > 0 ? `+${extra} lines ` : ""}(${elapsed}s)`)}`,
    );
    lines.push(`  ${dim("(ctrl+b to run in background)")}`);
    return lines;
  } catch {
    return ["  (output unavailable)"];
  }
}

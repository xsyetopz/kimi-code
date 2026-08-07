import { STATUS_BULLET } from "#/tui/constant/symbols";
import { currentTheme } from "#/tui/theme";
import type { CompactionPhase, CompactionTranscriptData } from "#/tui/types";

export function resolveCompactionPhase(
  data: CompactionTranscriptData,
): CompactionPhase {
  if (data.phase !== undefined) return data.phase;
  if (data.result === "cancelled") return "cancelled";
  return "done";
}

export interface ProjectCompactionLinesOptions {
  readonly data: CompactionTranscriptData;
  readonly blinkOn?: boolean;
}

/** ANSI lines for a compaction block (header, instruction, optional summary). */
export function projectCompactionLines(
  options: ProjectCompactionLinesOptions,
): string[] {
  const { data, blinkOn = true } = options;
  const phase = resolveCompactionPhase(data);
  const lines: string[] = [""];
  lines.push(buildCompactionHeader(data, phase, blinkOn));
  if (data.instruction !== undefined && data.instruction.length > 0) {
    lines.push(currentTheme.dim(`  ${data.instruction}`));
  }
  if (
    phase === "done" &&
    data.expanded === true &&
    data.summary !== undefined &&
    data.summary.length > 0
  ) {
    lines.push(
      ...data.summary
        .split("\n")
        .map((line) => currentTheme.dim(`  ${line}`)),
    );
  }
  return lines;
}

function buildCompactionHeader(
  data: CompactionTranscriptData,
  phase: CompactionPhase,
  blinkOn: boolean,
): string {
  if (phase === "done") {
    const bullet = currentTheme.fg("success", STATUS_BULLET);
    const label = currentTheme.boldFg("success", "Compaction complete");
    const detail =
      data.tokensBefore !== undefined && data.tokensAfter !== undefined
        ? currentTheme.dim(
            ` (${String(data.tokensBefore)} → ${String(data.tokensAfter)} tokens)`,
          )
        : "";
    const shortcutHint =
      data.summary !== undefined && data.summary.length > 0
        ? currentTheme.dim(
            ` (Ctrl-O to ${data.expanded === true ? "hide" : "show"} compaction summary)`,
          )
        : "";
    return `${bullet}${label}${detail}${shortcutHint}`;
  }
  if (phase === "cancelled") {
    const bullet = currentTheme.fg("warning", STATUS_BULLET);
    const label = currentTheme.boldFg("warning", "Compaction cancelled");
    return `${bullet}${label}`;
  }
  const bullet = blinkOn ? currentTheme.fg("text", STATUS_BULLET) : "  ";
  const label = currentTheme.boldFg("primary", "Compacting context...");
  const tip =
    data.tip !== undefined && data.tip.length > 0
      ? currentTheme.fg("textDim", ` · Tip: ${data.tip}`)
      : "";
  return `${bullet}${label}${tip}`;
}

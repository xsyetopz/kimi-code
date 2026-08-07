import chalk from "chalk";

import type { AgentSwarmPhase } from "#/tui/components/messages/agent-swarm-progress-state";
import type { ColorPalette } from "#/tui/theme/colors";

export const BRAILLE_LEVELS = ["⣀", "⣄", "⣤", "⣦", "⣶", "⣷", "⣿"] as const;
const BRAILLE_EMPTY = "⣀";
const BRAILLE_RIGHT_COLUMN_FULL = "⢸";
const COMPLETE_FILL_MS = 360;
const FAILED_PLACEHOLDER_RED_FACTOR = 0.75;
const FAILED_PLACEHOLDER_NON_RED_FACTOR = 0.25;

export function brailleBar(
  ticks: number,
  phase: AgentSwarmPhase,
  width: number,
  colors: ColorPalette,
  phaseElapsedMs: number,
  phaseColorOverride?: string,
): string {
  const innerWidth = Math.max(1, width);
  if (phase === "pending") return "";
  if (phase === "failed")
    return bracketBar(
      failedBrailleBar(ticks, innerWidth, phaseElapsedMs, colors),
      colors,
    );
  const displayTicks =
    phase === "completed"
      ? completedDisplayTicks(ticks, innerWidth, phaseElapsedMs)
      : ticks;
  if (phase === "cancelled") {
    const cancelledColor = phaseColorOverride ?? colors.warning;
    return bracketBar(
      accumulatedBrailleBar(
        displayTicks,
        innerWidth,
        cancelledColor,
        colors,
        () => cancelledColor,
      ),
      colors,
    );
  }
  const colorMap: Record<
    Exclude<AgentSwarmPhase, "pending" | "failed" | "cancelled">,
    string
  > = {
    queued: colors.textDim,
    suspended: colors.textDim,
    running: colors.success,
    completed: colors.success,
  };
  return bracketBar(
    accumulatedBrailleBar(displayTicks, innerWidth, colorMap[phase], colors),
    colors,
  );
}

function bracketBar(content: string, colors: ColorPalette): string {
  const bracket = chalk.hex(colors.textMuted);
  return bracket("[") + content + bracket("]");
}

function completedDisplayTicks(
  ticks: number,
  width: number,
  phaseElapsedMs: number,
): number {
  const fullBarTicks = width * BRAILLE_LEVELS.length;
  if (ticks >= fullBarTicks) return fullBarTicks;
  const fillProgress = Math.max(
    0,
    Math.min(1, phaseElapsedMs / COMPLETE_FILL_MS),
  );
  return Math.min(
    fullBarTicks,
    Math.ceil(ticks + (fullBarTicks - ticks) * fillProgress),
  );
}

function failedBrailleBar(
  ticks: number,
  width: number,
  phaseElapsedMs: number,
  colors: ColorPalette,
): string {
  const redCellCount = Math.ceil(
    completedDisplayTicks(ticks, width, phaseElapsedMs) / BRAILLE_LEVELS.length,
  );
  const placeholderColor = darkenRedHexColor(colors.error);
  return accumulatedBrailleBar(
    ticks,
    width,
    colors.error,
    colors,
    (cellIndex) =>
      cellIndex < redCellCount ? placeholderColor : colors.textDim,
  );
}

function darkenRedHexColor(hex: string): string {
  return darkenHexColor(
    hex,
    FAILED_PLACEHOLDER_RED_FACTOR,
    FAILED_PLACEHOLDER_NON_RED_FACTOR,
    FAILED_PLACEHOLDER_NON_RED_FACTOR,
  );
}

function darkenHexColor(
  hex: string,
  redFactor: number,
  greenFactor = redFactor,
  blueFactor = redFactor,
): string {
  const match = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  if (match === null) return hex;
  const darken = (channel: string, factor: number): string =>
    Math.max(
      0,
      Math.min(255, Math.round(Number.parseInt(channel, 16) * factor)),
    )
      .toString(16)
      .padStart(2, "0");
  return `#${darken(match[1]!, redFactor)}${darken(match[2]!, greenFactor)}${darken(
    match[3]!,
    blueFactor,
  )}`;
}

function accumulatedBrailleBar(
  ticks: number,
  width: number,
  filledColor: string,
  colors: ColorPalette,
  emptyColorForCell?: (cellIndex: number) => string,
): string {
  const dotsPerCell = BRAILLE_LEVELS.length;
  const cycleSize = width * dotsPerCell;
  const safeTicks = Math.max(0, Math.ceil(ticks));
  const completedCycles = Math.floor(safeTicks / cycleSize);
  const cycleTicks = safeTicks % cycleSize;
  const activeCells =
    cycleTicks === 0 ? 0 : Math.ceil(cycleTicks / dotsPerCell);
  const separatorIndex =
    completedCycles > 0 && activeCells > 0 && activeCells < width
      ? activeCells
      : -1;

  let out = "";
  let pending = "";
  let pendingColor: string | undefined;
  const flush = (): void => {
    if (pending.length === 0 || pendingColor === undefined) return;
    out += chalk.hex(pendingColor)(pending);
    pending = "";
  };
  const append = (char: string, color: string): void => {
    if (pendingColor !== color) {
      flush();
      pendingColor = color;
    }
    pending += char;
  };

  for (let i = 0; i < width; i += 1) {
    if (i === separatorIndex) {
      append(BRAILLE_RIGHT_COLUMN_FULL, filledColor);
      continue;
    }

    const cellStart = i * dotsPerCell;
    const countThisCycle = Math.max(
      0,
      Math.min(dotsPerCell, cycleTicks - cellStart),
    );
    const count =
      countThisCycle > 0
        ? countThisCycle
        : completedCycles > 0
          ? dotsPerCell
          : 0;
    append(
      count === 0 ? BRAILLE_EMPTY : BRAILLE_LEVELS[count - 1]!,
      count === 0 ? (emptyColorForCell?.(i) ?? colors.textDim) : filledColor,
    );
  }
  flush();
  return out;
}

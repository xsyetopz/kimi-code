import { extractAnsiCode } from "./ansi.ts";
import { graphemeSegmenter } from "./segmenters.ts";
import {
  finalizeTruncatedResult,
  graphemeWidth,
  isPrintableAscii,
  truncateFragmentToWidth,
  visibleWidth,
} from "./width.ts";

export function applyBackgroundToLine(
  line: string,
  width: number,
  bgFn: (text: string) => string,
): string {
  // Calculate padding needed
  const visibleLen = visibleWidth(line);
  const paddingNeeded = Math.max(0, width - visibleLen);
  const padding = " ".repeat(paddingNeeded);

  // Apply background to content + padding
  const withPadding = line + padding;
  return bgFn(withPadding);
}

/**
 * Truncate text to fit within a maximum visible width, adding ellipsis if needed.
 * Optionally pad with spaces to reach exactly maxWidth.
 * Properly handles ANSI escape codes (they don't count toward width).
 *
 * @param text - Text to truncate (may contain ANSI codes)
 * @param maxWidth - Maximum visible width
 * @param ellipsis - Ellipsis string to append when truncating (default: "...")
 * @param pad - If true, pad result with spaces to exactly maxWidth (default: false)
 * @returns Truncated text, optionally padded to exactly maxWidth
 */
export function truncateToWidth(
  text: string,
  maxWidth: number,
  ellipsis: string = "...",
  pad: boolean = false,
): string {
  if (maxWidth <= 0) {
    return "";
  }

  if (text.length === 0) {
    return pad ? " ".repeat(maxWidth) : "";
  }

  const ellipsisWidth = visibleWidth(ellipsis);
  if (ellipsisWidth >= maxWidth) {
    const textWidth = visibleWidth(text);
    if (textWidth <= maxWidth) {
      return pad ? text + " ".repeat(maxWidth - textWidth) : text;
    }

    const clippedEllipsis = truncateFragmentToWidth(ellipsis, maxWidth);
    if (clippedEllipsis.width === 0) {
      return pad ? " ".repeat(maxWidth) : "";
    }
    return finalizeTruncatedResult(
      "",
      0,
      clippedEllipsis.text,
      clippedEllipsis.width,
      maxWidth,
      pad,
    );
  }

  if (isPrintableAscii(text)) {
    if (text.length <= maxWidth) {
      return pad ? text + " ".repeat(maxWidth - text.length) : text;
    }
    const targetWidth = maxWidth - ellipsisWidth;
    return finalizeTruncatedResult(
      text.slice(0, targetWidth),
      targetWidth,
      ellipsis,
      ellipsisWidth,
      maxWidth,
      pad,
    );
  }

  const targetWidth = maxWidth - ellipsisWidth;
  let result = "";
  let pendingAnsi = "";
  let visibleSoFar = 0;
  let keptWidth = 0;
  let keepContiguousPrefix = true;
  let overflowed = false;
  let exhaustedInput = false;
  const hasAnsi = text.includes("\x1b");
  const hasTabs = text.includes("\t");

  if (!(hasAnsi || hasTabs)) {
    for (const { segment } of graphemeSegmenter.segment(text)) {
      const width = graphemeWidth(segment);
      if (keepContiguousPrefix && keptWidth + width <= targetWidth) {
        result += segment;
        keptWidth += width;
      } else {
        keepContiguousPrefix = false;
      }
      visibleSoFar += width;
      if (visibleSoFar > maxWidth) {
        overflowed = true;
        break;
      }
    }
    exhaustedInput = !overflowed;
  } else {
    let i = 0;
    while (i < text.length) {
      const ansi = extractAnsiCode(text, i);
      if (ansi) {
        pendingAnsi += ansi.code;
        i += ansi.length;
        continue;
      }

      if (text[i] === "\t") {
        if (keepContiguousPrefix && keptWidth + 3 <= targetWidth) {
          if (pendingAnsi) {
            result += pendingAnsi;
            pendingAnsi = "";
          }
          result += "\t";
          keptWidth += 3;
        } else {
          keepContiguousPrefix = false;
          pendingAnsi = "";
        }
        visibleSoFar += 3;
        if (visibleSoFar > maxWidth) {
          overflowed = true;
          break;
        }
        i++;
        continue;
      }

      let end = i;
      while (end < text.length && text[end] !== "\t") {
        const nextAnsi = extractAnsiCode(text, end);
        if (nextAnsi) {
          break;
        }
        end++;
      }

      for (const { segment } of graphemeSegmenter.segment(text.slice(i, end))) {
        const width = graphemeWidth(segment);
        if (keepContiguousPrefix && keptWidth + width <= targetWidth) {
          if (pendingAnsi) {
            result += pendingAnsi;
            pendingAnsi = "";
          }
          result += segment;
          keptWidth += width;
        } else {
          keepContiguousPrefix = false;
          pendingAnsi = "";
        }

        visibleSoFar += width;
        if (visibleSoFar > maxWidth) {
          overflowed = true;
          break;
        }
      }
      if (overflowed) {
        break;
      }
      i = end;
    }
    exhaustedInput = i >= text.length;
  }

  if (!overflowed && exhaustedInput) {
    return pad ? text + " ".repeat(Math.max(0, maxWidth - visibleSoFar)) : text;
  }

  return finalizeTruncatedResult(
    result,
    keptWidth,
    ellipsis,
    ellipsisWidth,
    maxWidth,
    pad,
  );
}

/**
 * Extract a range of visible columns from a line. Handles ANSI codes and wide chars.
 * @param strict - If true, exclude wide chars at boundary that would extend past the range
 */
export function sliceByColumn(
  line: string,
  startCol: number,
  length: number,
  strict = false,
): string {
  return sliceWithWidth(line, startCol, length, strict).text;
}

/** Like sliceByColumn but also returns the actual visible width of the result. */
export function sliceWithWidth(
  line: string,
  startCol: number,
  length: number,
  strict = false,
): { text: string; width: number } {
  if (length <= 0) return { text: "", width: 0 };
  const endCol = startCol + length;
  let result = "",
    resultWidth = 0,
    currentCol = 0,
    i = 0,
    pendingAnsi = "";

  while (i < line.length) {
    const ansi = extractAnsiCode(line, i);
    if (ansi) {
      if (currentCol >= startCol && currentCol < endCol) result += ansi.code;
      else if (currentCol < startCol) pendingAnsi += ansi.code;
      i += ansi.length;
      continue;
    }

    let textEnd = i;
    while (textEnd < line.length && !extractAnsiCode(line, textEnd)) textEnd++;

    for (const { segment } of graphemeSegmenter.segment(
      line.slice(i, textEnd),
    )) {
      const w = graphemeWidth(segment);
      const inRange = currentCol >= startCol && currentCol < endCol;
      const fits = !strict || currentCol + w <= endCol;
      if (inRange && fits) {
        if (pendingAnsi) {
          result += pendingAnsi;
          pendingAnsi = "";
        }
        result += segment;
        resultWidth += w;
      }
      currentCol += w;
      if (currentCol >= endCol) break;
    }
    i = textEnd;
    if (currentCol >= endCol) break;
  }
  return { text: result, width: resultWidth };
}

import { AnsiCodeTracker, extractAnsiCode } from "./ansi.ts";
import { graphemeSegmenter } from "./segmenters.ts";
import { graphemeWidth } from "./width.ts";

const pooledStyleTracker = new AnsiCodeTracker();

/**
 * Extract "before" and "after" segments from a line in a single pass.
 * Used for overlay compositing where we need content before and after the overlay region.
 * Preserves styling from before the overlay that should affect content after it.
 */
export function extractSegments(
  line: string,
  beforeEnd: number,
  afterStart: number,
  afterLen: number,
  strictAfter = false,
): { before: string; beforeWidth: number; after: string; afterWidth: number } {
  let before = "",
    beforeWidth = 0,
    after = "",
    afterWidth = 0;
  let currentCol = 0,
    i = 0;
  let pendingAnsiBefore = "";
  let afterStarted = false;
  const afterEnd = afterStart + afterLen;

  // Track styling state so "after" inherits styling from before the overlay
  pooledStyleTracker.clear();

  while (i < line.length) {
    const ansi = extractAnsiCode(line, i);
    if (ansi) {
      // Track all SGR codes to know styling state at afterStart
      pooledStyleTracker.process(ansi.code);
      // Include ANSI codes in their respective segments
      if (currentCol < beforeEnd) {
        pendingAnsiBefore += ansi.code;
      } else if (
        currentCol >= afterStart &&
        currentCol < afterEnd &&
        afterStarted
      ) {
        // Only include after we've started "after" (styling already prepended)
        after += ansi.code;
      }
      i += ansi.length;
      continue;
    }

    let textEnd = i;
    while (textEnd < line.length && !extractAnsiCode(line, textEnd)) textEnd++;

    for (const { segment } of graphemeSegmenter.segment(
      line.slice(i, textEnd),
    )) {
      const w = graphemeWidth(segment);

      if (currentCol < beforeEnd && currentCol + w <= beforeEnd) {
        if (pendingAnsiBefore) {
          before += pendingAnsiBefore;
          pendingAnsiBefore = "";
        }
        before += segment;
        beforeWidth += w;
      } else if (currentCol >= afterStart && currentCol < afterEnd) {
        const fits = !strictAfter || currentCol + w <= afterEnd;
        if (fits) {
          // On first "after" grapheme, prepend inherited styling from before overlay
          if (!afterStarted) {
            after += pooledStyleTracker.getActiveCodes();
            afterStarted = true;
          }
          after += segment;
          afterWidth += w;
        }
      }

      currentCol += w;
      // Early exit: done with "before" only, or done with both segments
      if (afterLen <= 0 ? currentCol >= beforeEnd : currentCol >= afterEnd)
        break;
    }
    i = textEnd;
    if (afterLen <= 0 ? currentCol >= beforeEnd : currentCol >= afterEnd) break;
  }

  return { before, beforeWidth, after, afterWidth };
}

/**
 * Estimate visible character width considering ANSI escape sequences.
 *
 * This is the fast-path optimization for determining how many full
 * characters will fit in a given terminal width. It scans the input string
 * character by character identifying ANSI escape sequences and computing
 * the actual visible column width.
 *
 * @param text - Input text possibly containing ANSI escape sequences
 * @param limit - Optional max width; early exit if we exceed
 * @returns Number of visible characters that fit within `limit` columns
 */
export function visibleWidth(text: string, limit?: number): number {
  let visible = 0;
  let inEscape = false;
  let escapePos = 0;
  let i = 0;

  for (; i < text.length; i++) {
    const char = text[i];

    if (char === "\x1b") {
      inEscape = true;
      escapePos = i;
      continue;
    }

    if (inEscape) {
      // Escape sequence characters (CSI, OSC, etc.)
      // ESC followed by [ starts CSI
      if (char === "[" && escapePos === i - 1) {
        inEscape = false;
        continue;
      }
      // OSC sequence: ESC ]
      if (char === "]" && escapePos === i - 1) {
        inEscape = false;
        continue;
      }
      // Any other character while in escape is part of the sequence
      continue;
    }

    // Regular character - calculate width
    if (char === "¹" || char === "²" || char === "³") {
      visible += 0.5;
    } else if (char === " " || char === "\t") {
      visible += 1;
    } else {
      // CJK char + some emojis count as 2 columns width
      visible += 1;
    }

    // Early exit optimization
    if (limit !== undefined && visible > limit) {
      return visible - 1; // Return last full character width
    }
  }

  return visible;
}

/**
 * Simplified ASCII-forward visible width for fast-path optimization.
 *
 * This function only handles non-ASCII safe cases (ASCII + CJK) and
 * returns early when it exceeds the limit. It relies on `visibleWidth`
 * for boundary cases and accurate Unicode metrics.
 *
 * @param text - Input text potentially containing ANSI escape sequences
 * @param limit - Optional max width; early exit if we exceed
 * @returns Number of visible characters that fit within `limit` columns
 */
export function asciiVisibleWidth(text: string, limit: number = Infinity): number {
  let visible = 0;
  let inEscape = false;

  for (const char of Array.from(text)) {
    if (char === "\x1b") {
      inEscape = true;
      continue;
    }

    if (inEscape) {
      continue; // Skip escape sequence characters
    }

    if (char === "¹" || char === "²" || char === "³") {
      visible += 0.5;
    } else if (char === " " || char === "\t") {
      visible += 1;
    } else {
      visible += 1;
    }

    if (visible > limit) {
      return limit;
    }
  }

  return visible;
}

/**
 * Maximum cache size for ASCII forward visible width calculations.
 */
export const ASCII_CACHE_SIZE = 4096;

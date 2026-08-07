import { eastAsianWidth } from "get-east-asian-width";
import { extractAnsiCode } from "./ansi.ts";
import { graphemeSegmenter } from "./segmenters.ts";

function couldBeEmoji(segment: string): boolean {
  const cp = segment.codePointAt(0)!;
  return (
    (cp >= 0x1f000 && cp <= 0x1fbff) || // Emoji and Pictograph
    (cp >= 0x2300 && cp <= 0x23ff) || // Misc technical
    (cp >= 0x2600 && cp <= 0x27bf) || // Misc symbols, dingbats
    (cp >= 0x2b50 && cp <= 0x2b55) || // Specific stars/circles
    segment.includes("\uFE0F") || // Contains VS16 (emoji presentation selector)
    segment.length > 2 // Multi-codepoint sequences (ZWJ, skin tones, etc.)
  );
}

// Regexes for character classification (same as string-width library)
const zeroWidthRegex =
  /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Mark}|\p{Surrogate})+$/v;
const leadingNonPrintingRegex =
  /^[\p{Default_Ignorable_Code_Point}\p{Control}\p{Format}\p{Mark}\p{Surrogate}]+/v;
const rgiEmojiRegex = /^\p{RGI_Emoji}$/v;

// Cache for non-ASCII strings
const WIDTH_CACHE_SIZE = 4096;
const widthCache = new Map<string, number>();

export const cjkBreakRegex =
  /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]/u;

export function isPrintableAscii(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) {
      return false;
    }
  }
  return true;
}

export function truncateFragmentToWidth(
  text: string,
  maxWidth: number,
): { text: string; width: number } {
  if (maxWidth <= 0 || text.length === 0) {
    return { text: "", width: 0 };
  }

  if (isPrintableAscii(text)) {
    const clipped = text.slice(0, maxWidth);
    return { text: clipped, width: clipped.length };
  }

  const hasAnsi = text.includes("\x1b");
  const hasTabs = text.includes("\t");
  if (!hasAnsi && !hasTabs) {
    let result = "";
    let width = 0;
    for (const { segment } of graphemeSegmenter.segment(text)) {
      const w = graphemeWidth(segment);
      if (width + w > maxWidth) {
        break;
      }
      result += segment;
      width += w;
    }
    return { text: result, width };
  }

  let result = "";
  let width = 0;
  let i = 0;
  let pendingAnsi = "";

  while (i < text.length) {
    const ansi = extractAnsiCode(text, i);
    if (ansi) {
      pendingAnsi += ansi.code;
      i += ansi.length;
      continue;
    }

    if (text[i] === "\t") {
      if (width + 3 > maxWidth) {
        break;
      }
      if (pendingAnsi) {
        result += pendingAnsi;
        pendingAnsi = "";
      }
      result += "\t";
      width += 3;
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
      const w = graphemeWidth(segment);
      if (width + w > maxWidth) {
        return { text: result, width };
      }
      if (pendingAnsi) {
        result += pendingAnsi;
        pendingAnsi = "";
      }
      result += segment;
      width += w;
    }
    i = end;
  }

  return { text: result, width };
}

export function finalizeTruncatedResult(
  prefix: string,
  prefixWidth: number,
  ellipsis: string,
  ellipsisWidth: number,
  maxWidth: number,
  pad: boolean,
): string {
  const reset = "\x1b[0m";
  const visibleWidth = prefixWidth + ellipsisWidth;
  let result: string;

  if (ellipsis.length > 0) {
    result = `${prefix}${reset}${ellipsis}${reset}`;
  } else {
    result = `${prefix}${reset}`;
  }

  return pad
    ? result + " ".repeat(Math.max(0, maxWidth - visibleWidth))
    : result;
}

/**
 * Calculate the terminal width of a single grapheme cluster.
 * Based on code from the string-width library, but includes a possible-emoji
 * check to avoid running the RGI_Emoji regex unnecessarily.
 */
export function graphemeWidth(segment: string): number {
  if (segment === "\t") {
    return 3;
  }

  // Zero-width clusters
  if (zeroWidthRegex.test(segment)) {
    return 0;
  }

  // Emoji check with pre-filter
  if (couldBeEmoji(segment) && rgiEmojiRegex.test(segment)) {
    return 2;
  }

  // Get base visible codepoint
  const base = segment.replace(leadingNonPrintingRegex, "");
  const cp = base.codePointAt(0);
  if (cp === undefined) {
    return 0;
  }

  // Regional indicator symbols (U+1F1E6..U+1F1FF) are often rendered as
  // full-width emoji in terminals, even when isolated during streaming.
  // Keep width conservative (2) to avoid terminal auto-wrap drift artifacts.
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) {
    return 2;
  }

  let width = eastAsianWidth(cp);

  // Trailing halfwidth/fullwidth forms and AM vowels that segment with a base.
  if (segment.length > 1) {
    for (const char of segment.slice(1)) {
      const c = char.codePointAt(0)!;
      if (c >= 0xff00 && c <= 0xffef) {
        width += eastAsianWidth(c);
      } else if (c === 0x0e33 || c === 0x0eb3) {
        width += 1;
      }
    }
  }

  return width;
}

/**
 * Calculate the visible width of a string in terminal columns.
 */
export function visibleWidth(str: string): number {
  if (str.length === 0) {
    return 0;
  }

  // Fast path: pure ASCII printable
  if (isPrintableAscii(str)) {
    return str.length;
  }

  // Check cache
  const cached = widthCache.get(str);
  if (cached !== undefined) {
    return cached;
  }

  // Normalize: tabs to 3 spaces, strip ANSI escape codes
  let clean = str;
  if (str.includes("\t")) {
    clean = clean.replace(/\t/g, "   ");
  }
  if (clean.includes("\x1b")) {
    // Strip supported ANSI/OSC/APC escape sequences in one pass.
    // This covers CSI styling/cursor codes, OSC hyperlinks and prompt markers,
    // and APC sequences like CURSOR_MARKER.
    let stripped = "";
    let i = 0;
    while (i < clean.length) {
      const ansi = extractAnsiCode(clean, i);
      if (ansi) {
        i += ansi.length;
        continue;
      }
      stripped += clean[i];
      i++;
    }
    clean = stripped;
  }

  // Calculate width
  let width = 0;
  for (const { segment } of graphemeSegmenter.segment(clean)) {
    width += graphemeWidth(segment);
  }

  // Cache result
  if (widthCache.size >= WIDTH_CACHE_SIZE) {
    const firstKey = widthCache.keys().next().value;
    if (firstKey !== undefined) {
      widthCache.delete(firstKey);
    }
  }
  widthCache.set(str, width);

  return width;
}

/**
 * Fast visible-width scan for lines whose printable content is plain ASCII,
 * skipping over ANSI escape sequences. Returns the visible width, or
 * `undefined` when the line contains control characters or non-ASCII
 * content (caller should fall back to visibleWidth()). Early-exits as soon
 * as the width exceeds `limit`, returning the partial count (> limit).
 */
export function asciiVisibleWidth(
  line: string,
  limit: number,
): number | undefined {
  let width = 0;
  let i = 0;
  while (i < line.length) {
    const code = line.charCodeAt(i);
    if (code === 0x1b) {
      const ansi = extractAnsiCode(line, i);
      if (!ansi) return undefined;
      i += ansi.length;
      continue;
    }
    if (code < 0x20 || code > 0x7e) return undefined;
    width++;
    if (width > limit) return width;
    i++;
  }
  return width;
}

import { visibleWidth } from "@moonshot-ai/kimi-tui";

import { currentTheme } from "#/tui/theme";

// oxlint-disable-next-line no-control-regex -- ESC (\x1b) is required to match ANSI SGR escape sequences
const ANSI_SGR = /\u001B\[[0-9;]*m/g;

/** Convert a visible-char index (ANSI-stripped) back to an index into the raw ANSI-bearing string. */
function mapVisibleIdxToRaw(line: string, visibleIdx: number): number {
  let visibleCount = 0;
  let i = 0;
  const re = new RegExp(ANSI_SGR.source, "y");
  while (i < line.length && visibleCount < visibleIdx) {
    re.lastIndex = i;
    const m = re.exec(line);
    if (m !== null && m.index === i) {
      i += m[0].length;
    } else {
      visibleCount++;
      i++;
    }
  }
  return i;
}

function stripSgr(s: string): string {
  return s.replace(ANSI_SGR, "");
}

/**
 * Return a copy of `line` with the first `/token` coloured using `hex`.
 * For `/goal next manage`, also colour the command-path tokens.
 * `line` may already contain SGR escapes (cursor inverse, etc.); we
 * locate `/` via visible-index math so ANSI pass-through survives.
 * Returns `undefined` if no token is found.
 */
export function highlightFirstSlashToken(
  line: string,
  token: "primary",
): string | undefined {
  const visible = stripSgr(line);
  const slashIdx = visible.indexOf("/");
  if (slashIdx < 0) return undefined;
  // Guard: only paint when `/` is the first non-whitespace character
  // on the line (avoids colouring a mid-sentence slash).
  for (let i = 0; i < slashIdx; i++) {
    if (visible[i] !== " " && visible[i] !== "\t") return undefined;
  }
  // Token ends at the next whitespace (or the visible end).
  let endVisible = slashIdx + 1;
  while (endVisible < visible.length) {
    const ch = visible[endVisible];
    if (ch === " " || ch === "\t") break;
    endVisible++;
  }
  const visibleToken = visible.slice(slashIdx, endVisible);
  if (visibleToken.slice(1).includes("/")) return undefined;
  const ranges = [{ start: slashIdx, end: endVisible }];
  if (visibleToken === "/goal") {
    ranges.push(...goalCommandPathRanges(visible, endVisible));
  }
  return highlightVisibleRanges(line, ranges, token);
}

function goalCommandPathRanges(
  visible: string,
  commandEnd: number,
): Array<{ start: number; end: number }> {
  const nextRange = readTokenRange(visible, commandEnd);
  if (
    nextRange === null ||
    visible.slice(nextRange.start, nextRange.end) !== "next"
  ) {
    return [];
  }
  const ranges = [nextRange];
  const manageRange = readTokenRange(visible, nextRange.end);
  if (
    manageRange !== null &&
    visible.slice(manageRange.start, manageRange.end) === "manage"
  ) {
    ranges.push(manageRange);
  }
  return ranges;
}

function readTokenRange(
  visible: string,
  start: number,
): { start: number; end: number } | null {
  let tokenStart = start;
  while (tokenStart < visible.length && isTokenSpace(visible[tokenStart]))
    tokenStart++;
  if (tokenStart >= visible.length) return null;
  let tokenEnd = tokenStart;
  while (tokenEnd < visible.length && !isTokenSpace(visible[tokenEnd]))
    tokenEnd++;
  return { start: tokenStart, end: tokenEnd };
}

function isTokenSpace(ch: string | undefined): boolean {
  return ch === " " || ch === "\t";
}

function highlightVisibleRanges(
  line: string,
  ranges: Array<{ start: number; end: number }>,
  token: "primary",
): string {
  let out = "";
  let rawCursor = 0;
  for (const range of ranges) {
    const rawStart = mapVisibleIdxToRaw(line, range.start);
    const rawEnd = mapVisibleIdxToRaw(line, range.end);
    out += line.slice(rawCursor, rawStart);
    out += currentTheme.boldFg(token, line.slice(rawStart, rawEnd));
    rawCursor = rawEnd;
  }
  return out + line.slice(rawCursor);
}

// Mirrors the editor's paddingX (see constructor). The hint is spliced into
// the first content line, which starts with this many spaces of left padding.
const EDITOR_LEFT_PADDING = 4;
// kimi-tui renders the end-of-input cursor as an inverse-video space.
const CURSOR_BLOCK = "\u001B[7m \u001B[0m";

/**
 * Splice a dimmed argument-hint ghost string into the first content line.
 *
 * The hint is purely visual: it is appended after the typed command (and
 * after the cursor block when one is rendered) so the cursor stays at the
 * end of the real input. It consumes trailing padding space, so the line
 * width is preserved; if it would overflow the box it is truncated with an
 * ellipsis. Returns the line unchanged when there is no room for a hint.
 */
export function injectArgumentHint(
  line: string,
  hint: string,
  realTextLength: number,
  width: number,
): string {
  const cursorIdx = line.indexOf(CURSOR_BLOCK);
  const cursorPresent = cursorIdx !== -1;
  const contentWidth = Math.max(1, width - EDITOR_LEFT_PADDING * 2);
  // Room left in the content area after the typed text (and cursor). The hint
  // must fit within this so the rendered line keeps its width.
  const available = contentWidth - realTextLength - (cursorPresent ? 1 : 0);
  const trimmed = truncateHint(hint, available);
  if (trimmed.length === 0) return line;
  const colored = currentTheme.fg("textDim", trimmed);
  const insertAt = cursorPresent
    ? cursorIdx + CURSOR_BLOCK.length
    : mapVisibleIdxToRaw(line, EDITOR_LEFT_PADDING + realTextLength);
  // Everything after the insertion point is trailing padding + right padding
  // (plain spaces). Replace it with the hint followed by the remaining spaces
  // so the visible line width is preserved.
  const trailing = line.length - insertAt;
  return (
    line.slice(0, insertAt) +
    colored +
    " ".repeat(Math.max(0, trailing - trimmed.length))
  );
}

function truncateHint(hint: string, maxLen: number): string {
  if (maxLen <= 0) return "";
  if (hint.length <= maxLen) return hint;
  if (maxLen === 1) return "…";
  return `${hint.slice(0, maxLen - 1)}…`;
}

/**
 * Overlay a terminal-style `> ` prompt symbol on the first content line.
 * Column 0 is reserved for the left vertical border (overlaid later by
 * wrapWithSideBorders); column 1 is a single-space gap, so the `>` token
 * lives at column 2 with column 3 separating it from content.
 * Relies on the editor being configured with `paddingX >= 4` so the line
 * starts with at least four literal spaces. Emits no SGR so the terminal's
 * default foreground colour renders the symbol. Returns `undefined` if the
 * line is too short or doesn't begin with the expected padding.
 */
export function injectPromptSymbol(
  line: string,
  symbol = ">",
  paint?: (s: string) => string,
): string | undefined {
  if (line.length < 4) return undefined;
  for (let i = 0; i < 4; i++) {
    if (line[i] !== " ") return undefined;
  }
  const rendered = paint ? paint(symbol) : symbol;
  return "  " + rendered + " " + line.slice(4);
}

/**
 * Post-process kimi-tui's editor output to draw a full box around it.
 *
 * kimi-tui only renders horizontal top/bottom borders; we wrap them with
 * `╭╮╰╯` corners and add vertical `│` bars on each row's outer columns.
 * Horizontal-border rows (those whose first visible char is `─`, including
 * scroll indicators like `── ↑ N more ──`) are stripped of their existing
 * SGR and repainted as a single box-drawn span. Content rows keep their
 * inner SGR intact; only column 0 and the last column are overlaid, and
 * only if they're literal spaces — that protects the cursor-overflow
 * case where the rightmost column is an SGR-tagged inverse cursor.
 *
 * When `options.label` is set, it is overlaid on the left of the top border
 * (e.g. the `! shell mode` badge), replacing the leading dashes. It is only
 * applied to a plain dash run, never to a `↑/↓ N more` scroll indicator.
 */
export function wrapWithSideBorders(
  lines: string[],
  paint: (s: string) => string,
  options: { readonly connectedAbove?: boolean; readonly label?: string } = {},
): string[] {
  let seenTop = false;
  return lines.map((line) => {
    const plain = stripSgr(line);
    if (plain.length > 0 && plain[0] === "─") {
      const isTop = !seenTop;
      const leftCorner = seenTop
        ? "╰"
        : options.connectedAbove === true
          ? "├"
          : "╭";
      const rightCorner = seenTop
        ? "╯"
        : options.connectedAbove === true
          ? "┤"
          : "╮";
      seenTop = true;
      if (plain.length === 1) return paint(leftCorner);
      const middle = plain.slice(1, -1);
      if (isTop && options.label !== undefined && /^─+$/.test(middle)) {
        const labelWidth = visibleWidth(options.label);
        if (labelWidth <= middle.length) {
          return (
            paint(leftCorner) +
            options.label +
            paint("─".repeat(middle.length - labelWidth)) +
            paint(rightCorner)
          );
        }
      }
      return paint(leftCorner + middle + rightCorner);
    }
    if (line.length === 0) return line;
    const firstCh = line[0];
    const lastCh = line.at(-1);
    const head = firstCh === " " ? paint("│") : (firstCh ?? "");
    const tail =
      line.length > 1 && lastCh === " " ? paint("│") : (lastCh ?? "");
    if (line.length === 1) return head;
    return head + line.slice(1, -1) + tail;
  });
}

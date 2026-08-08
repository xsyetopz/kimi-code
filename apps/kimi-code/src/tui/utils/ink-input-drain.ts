import { ESC } from "#/constant/terminal";
import type { TUIState } from "#/tui/tui-state";

/**
 * Drain terminal capability replies from Ink's input path before they reach
 * the prompt editor.
 *
 * Ink owns stdin and `useInput` strips the leading ESC from unrecognized
 * CSI/OSC sequences, so theme/focus/OSC 11 replies arrive as `[I`, `]11;rgb…`,
 * `[?997;1n`, etc. Legacy TUI listeners never see them unless we re-feed the
 * stream here via `filterInput`.
 *
 * Returns `null` when the chunk was fully consumed; otherwise the remaining
 * key bytes for the editor.
 */
export function drainInkTerminalInput(
  data: string,
  ui: Pick<TUIState["ui"], "filterInput">,
): string | null {
  const first = ui.filterInput(data);
  if ("consume" in first && first.consume) return null;

  let remaining = first.data;
  // Ink strips one leading ESC from unrecognized sequences. Re-prefix and
  // re-run listeners so ESC-keyed matchers (focus, theme CSI) still fire.
  if (
    remaining.length > 0 &&
    !remaining.startsWith(ESC) &&
    looksLikeStrippedTerminalReply(remaining)
  ) {
    const restored = ui.filterInput(`${ESC}${remaining}`);
    if ("consume" in restored && restored.consume) return null;
    remaining = restored.data.startsWith(ESC)
      ? restored.data.slice(ESC.length)
      : restored.data;
  }

  return remaining.length === 0 ? null : remaining;
}

function looksLikeStrippedTerminalReply(data: string): boolean {
  return (
    data.startsWith("[I") ||
    data.startsWith("[O") ||
    data.startsWith("]11;") ||
    data.startsWith("[?997;") ||
    data.startsWith("[?996") ||
    data.startsWith("[6;") || // cell-size CSI 16 t reply: CSI 6 ; h ; w t
    data.startsWith("[?") // DA / other private CSI replies
  );
}

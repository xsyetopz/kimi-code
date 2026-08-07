import {
  LOCK_MASK,
  MODIFIERS,
  normalizeKittyFunctionalCodepoint,
} from "./key-id.ts";
import { parseModifyOtherKeysSequence } from "./kitty-parse.ts";

const KITTY_CSI_U_REGEX =
  /^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/u;
const KITTY_PRINTABLE_ALLOWED_MODIFIERS = MODIFIERS.shift | LOCK_MASK;

/**
 * Decode a Kitty CSI-u sequence into a printable character, if applicable.
 *
 * When Kitty keyboard protocol flag 1 (disambiguate) is active, terminals send
 * CSI-u sequences for all keys, including plain printable characters. This
 * function extracts the printable character from such sequences.
 *
 * Only accepts plain or Shift-modified keys. Rejects Ctrl, Alt, and unsupported
 * modifier combinations (those are handled by keybinding matching instead).
 * Prefers the shifted keycode when Shift is held and a shifted key is reported.
 *
 * @param data - Raw input data from terminal
 * @returns The printable character, or undefined if not a printable CSI-u sequence
 */
export function decodeKittyPrintable(data: string): string | undefined {
  const match = data.match(KITTY_CSI_U_REGEX);
  if (!match) return;

  // CSI-u groups: <codepoint>[:<shifted>[:<base>]];<mod>[:<event>]u
  const codepoint = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(codepoint)) return;

  const shiftedKey =
    match[2] && match[2].length > 0 ? Number.parseInt(match[2], 10) : undefined;
  const modValue = match[4] ? Number.parseInt(match[4], 10) : 1;
  // Modifiers are 1-indexed in CSI-u; normalize to our bitmask.
  const modifier = Number.isFinite(modValue) ? modValue - 1 : 0;

  // Only accept printable CSI-u input for plain or Shift-modified text keys.
  // Reject unsupported modifier bits (e.g. Super/Meta) to avoid inserting
  // characters from modifier-only terminal events.
  if ((modifier & ~KITTY_PRINTABLE_ALLOWED_MODIFIERS) !== 0) return;
  if (modifier & (MODIFIERS.alt | MODIFIERS.ctrl)) return;

  // Prefer the shifted keycode when Shift is held.
  let effectiveCodepoint = codepoint;
  if (modifier & MODIFIERS.shift && typeof shiftedKey === "number") {
    effectiveCodepoint = shiftedKey;
  }
  effectiveCodepoint = normalizeKittyFunctionalCodepoint(effectiveCodepoint);
  // Drop control characters or invalid codepoints.
  if (!Number.isFinite(effectiveCodepoint) || effectiveCodepoint < 32) return;

  try {
    return String.fromCodePoint(effectiveCodepoint);
  } catch {}
}

function decodeModifyOtherKeysPrintable(data: string): string | undefined {
  const parsed = parseModifyOtherKeysSequence(data);
  if (!parsed) return;
  const modifier = parsed.modifier & ~LOCK_MASK;
  if ((modifier & ~MODIFIERS.shift) !== 0) return;
  if (!Number.isFinite(parsed.codepoint) || parsed.codepoint < 32) return;

  try {
    return String.fromCodePoint(parsed.codepoint);
  } catch {}
}

export function decodePrintableKey(data: string): string | undefined {
  return decodeKittyPrintable(data) ?? decodeModifyOtherKeysPrintable(data);
}

import {
  ARROW_CODEPOINTS,
  CODEPOINTS,
  FUNCTIONAL_CODEPOINTS,
  LEGACY_SEQUENCE_KEY_IDS,
  normalizeKittyFunctionalCodepoint,
  normalizeShiftedLetterIdentityCodepoint,
  SYMBOL_KEYS,
} from "./key-id.ts";
import {
  formatKeyNameWithModifiers,
  isWindowsTerminalSession,
  parseKittySequence,
  parseModifyOtherKeysSequence,
} from "./kitty-parse.ts";
import { _kittyProtocolActive } from "./protocol-state.ts";

function formatParsedKey(
  codepoint: number,
  modifier: number,
  baseLayoutKey?: number,
): string | undefined {
  const normalizedCodepoint = normalizeKittyFunctionalCodepoint(codepoint);
  const identityCodepoint = normalizeShiftedLetterIdentityCodepoint(
    normalizedCodepoint,
    modifier,
  );

  // Use base layout key only when codepoint is not a recognized Latin
  // letter (a-z), digit (0-9), or symbol (/, -, [, ;, etc.). For those,
  // the codepoint is authoritative regardless of physical key position.
  // This prevents remapped layouts (Dvorak, Colemak, xremap, etc.) from
  // reporting the wrong key name based on the QWERTY physical position.
  const isLatinLetter = identityCodepoint >= 97 && identityCodepoint <= 122; // a-z
  const isDigit = identityCodepoint >= 48 && identityCodepoint <= 57; // 0-9
  const isKnownSymbol = SYMBOL_KEYS.has(String.fromCharCode(identityCodepoint));
  const effectiveCodepoint =
    isLatinLetter || isDigit || isKnownSymbol
      ? identityCodepoint
      : (baseLayoutKey ?? identityCodepoint);

  let keyName: string | undefined;
  if (effectiveCodepoint === CODEPOINTS.escape) keyName = "escape";
  else if (effectiveCodepoint === CODEPOINTS.tab) keyName = "tab";
  else if (
    effectiveCodepoint === CODEPOINTS.enter ||
    effectiveCodepoint === CODEPOINTS.kpEnter
  )
    keyName = "enter";
  else if (effectiveCodepoint === CODEPOINTS.space) keyName = "space";
  else if (effectiveCodepoint === CODEPOINTS.backspace) keyName = "backspace";
  else if (effectiveCodepoint === FUNCTIONAL_CODEPOINTS.delete)
    keyName = "delete";
  else if (effectiveCodepoint === FUNCTIONAL_CODEPOINTS.insert)
    keyName = "insert";
  else if (effectiveCodepoint === FUNCTIONAL_CODEPOINTS.home) keyName = "home";
  else if (effectiveCodepoint === FUNCTIONAL_CODEPOINTS.end) keyName = "end";
  else if (effectiveCodepoint === FUNCTIONAL_CODEPOINTS.pageUp)
    keyName = "pageUp";
  else if (effectiveCodepoint === FUNCTIONAL_CODEPOINTS.pageDown)
    keyName = "pageDown";
  else if (effectiveCodepoint === ARROW_CODEPOINTS.up) keyName = "up";
  else if (effectiveCodepoint === ARROW_CODEPOINTS.down) keyName = "down";
  else if (effectiveCodepoint === ARROW_CODEPOINTS.left) keyName = "left";
  else if (effectiveCodepoint === ARROW_CODEPOINTS.right) keyName = "right";
  else if (effectiveCodepoint >= 48 && effectiveCodepoint <= 57)
    keyName = String.fromCharCode(effectiveCodepoint);
  else if (effectiveCodepoint >= 97 && effectiveCodepoint <= 122)
    keyName = String.fromCharCode(effectiveCodepoint);
  else if (SYMBOL_KEYS.has(String.fromCharCode(effectiveCodepoint)))
    keyName = String.fromCharCode(effectiveCodepoint);

  if (!keyName) return;
  return formatKeyNameWithModifiers(keyName, modifier);
}

export function parseKey(data: string): string | undefined {
  const kitty = parseKittySequence(data);
  if (kitty) {
    return formatParsedKey(
      kitty.codepoint,
      kitty.modifier,
      kitty.baseLayoutKey,
    );
  }

  const modifyOtherKeys = parseModifyOtherKeysSequence(data);
  if (modifyOtherKeys) {
    return formatParsedKey(modifyOtherKeys.codepoint, modifyOtherKeys.modifier);
  }

  // Mode-aware legacy sequences
  // When Kitty protocol is active, ambiguous sequences are interpreted as custom terminal mappings:
  // - \x1b\r = shift+enter (Kitty mapping), not alt+enter
  // - \n = shift+enter (Ghostty mapping)
  if (_kittyProtocolActive) {
    if (data === "\x1b\r" || data === "\n") return "shift+enter";
  }

  const legacySequenceKeyId = LEGACY_SEQUENCE_KEY_IDS[data];
  if (legacySequenceKeyId) return legacySequenceKeyId;

  // Legacy sequences (used when Kitty protocol is not active, or for unambiguous sequences)
  if (data === "\x1b") return "escape";
  if (data === "\x1c") return "ctrl+\\";
  if (data === "\x1d") return "ctrl+]";
  if (data === "\x1f") return "ctrl+-";
  if (data === "\x1b\x1b") return "ctrl+alt+[";
  if (data === "\x1b\x1c") return "ctrl+alt+\\";
  if (data === "\x1b\x1d") return "ctrl+alt+]";
  if (data === "\x1b\x1f") return "ctrl+alt+-";
  if (data === "\t") return "tab";
  if (
    data === "\r" ||
    (!_kittyProtocolActive && data === "\n") ||
    data === "\x1bOM"
  )
    return "enter";
  if (data === "\x00") return "ctrl+space";
  if (data === " ") return "space";
  if (data === "\x7f") return "backspace";
  if (data === "\x08")
    return isWindowsTerminalSession() ? "ctrl+backspace" : "backspace";
  if (data === "\x1b[Z") return "shift+tab";
  if (!_kittyProtocolActive && data === "\x1b\r") return "alt+enter";
  if (!_kittyProtocolActive && data === "\x1b ") return "alt+space";
  if (data === "\x1b\x7f" || data === "\x1b\b") return "alt+backspace";
  if (!_kittyProtocolActive && data === "\x1bB") return "alt+left";
  if (!_kittyProtocolActive && data === "\x1bF") return "alt+right";
  if (!_kittyProtocolActive && data.length === 2 && data[0] === "\x1b") {
    const code = data.charCodeAt(1);
    if (code >= 1 && code <= 26) {
      return `ctrl+alt+${String.fromCharCode(code + 96)}`;
    }
    // Legacy alt+letter/digit (ESC followed by the key)
    if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) {
      return `alt+${String.fromCharCode(code)}`;
    }
  }
  if (data === "\x1b[A") return "up";
  if (data === "\x1b[B") return "down";
  if (data === "\x1b[C") return "right";
  if (data === "\x1b[D") return "left";
  if (data === "\x1b[H" || data === "\x1bOH") return "home";
  if (data === "\x1b[F" || data === "\x1bOF") return "end";
  if (data === "\x1b[3~") return "delete";
  if (data === "\x1b[5~") return "pageUp";
  if (data === "\x1b[6~") return "pageDown";

  // Raw Ctrl+letter
  if (data.length === 1) {
    const code = data.charCodeAt(0);
    if (code >= 1 && code <= 26) {
      return `ctrl+${String.fromCharCode(code + 96)}`;
    }
    if (code >= 32 && code <= 126) {
      return data;
    }
  }
}

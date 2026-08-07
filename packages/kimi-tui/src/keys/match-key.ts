import {
  ARROW_CODEPOINTS,
  CODEPOINTS,
  FUNCTIONAL_CODEPOINTS,
  type KeyId,
  LEGACY_KEY_SEQUENCES,
  MODIFIERS,
  matchesLegacyModifierSequence,
  matchesLegacySequence,
  SYMBOL_KEYS,
} from "./key-id.ts";
import {
  isDigitKey,
  matchesKittySequence,
  matchesModifyOtherKeys,
  matchesPrintableModifyOtherKeys,
  matchesRawBackspace,
  parseKeyId,
  rawCtrlChar,
} from "./kitty-parse.ts";
import { _kittyProtocolActive } from "./protocol-state.ts";

export function matchesKey(data: string, keyId: KeyId): boolean {
  const parsed = parseKeyId(keyId);
  if (!parsed) return false;

  const { key, ctrl, shift, alt, super: superModifier } = parsed;
  let modifier = 0;
  if (shift) modifier |= MODIFIERS.shift;
  if (alt) modifier |= MODIFIERS.alt;
  if (ctrl) modifier |= MODIFIERS.ctrl;
  if (superModifier) modifier |= MODIFIERS.super;

  switch (key) {
    case "escape":
    case "esc":
      if (modifier !== 0) return false;
      return (
        data === "\x1b" ||
        matchesKittySequence(data, CODEPOINTS.escape, 0) ||
        matchesModifyOtherKeys(data, CODEPOINTS.escape, 0)
      );

    case "space":
      if (!_kittyProtocolActive) {
        if (modifier === MODIFIERS.ctrl && data === "\x00") {
          return true;
        }
        if (modifier === MODIFIERS.alt && data === "\x1b ") {
          return true;
        }
      }
      if (modifier === 0) {
        return (
          data === " " ||
          matchesKittySequence(data, CODEPOINTS.space, 0) ||
          matchesModifyOtherKeys(data, CODEPOINTS.space, 0)
        );
      }
      return (
        matchesKittySequence(data, CODEPOINTS.space, modifier) ||
        matchesModifyOtherKeys(data, CODEPOINTS.space, modifier)
      );

    case "tab":
      if (modifier === MODIFIERS.shift) {
        return (
          data === "\x1b[Z" ||
          matchesKittySequence(data, CODEPOINTS.tab, MODIFIERS.shift) ||
          matchesModifyOtherKeys(data, CODEPOINTS.tab, MODIFIERS.shift)
        );
      }
      if (modifier === 0) {
        return data === "\t" || matchesKittySequence(data, CODEPOINTS.tab, 0);
      }
      return (
        matchesKittySequence(data, CODEPOINTS.tab, modifier) ||
        matchesModifyOtherKeys(data, CODEPOINTS.tab, modifier)
      );

    case "enter":
    case "return":
      if (modifier === MODIFIERS.shift) {
        // CSI u sequences (standard Kitty protocol)
        if (
          matchesKittySequence(data, CODEPOINTS.enter, MODIFIERS.shift) ||
          matchesKittySequence(data, CODEPOINTS.kpEnter, MODIFIERS.shift)
        ) {
          return true;
        }
        // xterm modifyOtherKeys format (fallback when Kitty protocol not enabled)
        if (matchesModifyOtherKeys(data, CODEPOINTS.enter, MODIFIERS.shift)) {
          return true;
        }
        // When Kitty protocol is active, legacy sequences are custom terminal mappings
        // \x1b\r = Kitty's "map shift+enter send_text all \e\r"
        // \n = Ghostty's "keybind = shift+enter=text:\n"
        if (_kittyProtocolActive) {
          return data === "\x1b\r" || data === "\n";
        }
        return false;
      }
      if (modifier === MODIFIERS.alt) {
        // CSI u sequences (standard Kitty protocol)
        if (
          matchesKittySequence(data, CODEPOINTS.enter, MODIFIERS.alt) ||
          matchesKittySequence(data, CODEPOINTS.kpEnter, MODIFIERS.alt)
        ) {
          return true;
        }
        // xterm modifyOtherKeys format (fallback when Kitty protocol not enabled)
        if (matchesModifyOtherKeys(data, CODEPOINTS.enter, MODIFIERS.alt)) {
          return true;
        }
        // \x1b\r is alt+enter only in legacy mode (no Kitty protocol)
        // When Kitty protocol is active, alt+enter comes as CSI u sequence
        if (!_kittyProtocolActive) {
          return data === "\x1b\r";
        }
        return false;
      }
      if (modifier === 0) {
        return (
          data === "\r" ||
          (!_kittyProtocolActive && data === "\n") ||
          data === "\x1bOM" || // SS3 M (numpad enter in some terminals)
          matchesKittySequence(data, CODEPOINTS.enter, 0) ||
          matchesKittySequence(data, CODEPOINTS.kpEnter, 0)
        );
      }
      return (
        matchesKittySequence(data, CODEPOINTS.enter, modifier) ||
        matchesKittySequence(data, CODEPOINTS.kpEnter, modifier) ||
        matchesModifyOtherKeys(data, CODEPOINTS.enter, modifier)
      );

    case "backspace":
      if (modifier === MODIFIERS.alt) {
        if (data === "\x1b\x7f" || data === "\x1b\b") {
          return true;
        }
        return (
          matchesKittySequence(data, CODEPOINTS.backspace, MODIFIERS.alt) ||
          matchesModifyOtherKeys(data, CODEPOINTS.backspace, MODIFIERS.alt)
        );
      }
      if (modifier === MODIFIERS.ctrl) {
        // Legacy raw 0x08 is ambiguous: it can be Ctrl+Backspace on Windows
        // Terminal or plain Backspace on other terminals, while also
        // overlapping with Ctrl+H.
        if (matchesRawBackspace(data, MODIFIERS.ctrl)) return true;
        return (
          matchesKittySequence(data, CODEPOINTS.backspace, MODIFIERS.ctrl) ||
          matchesModifyOtherKeys(data, CODEPOINTS.backspace, MODIFIERS.ctrl)
        );
      }
      if (modifier === 0) {
        return (
          matchesRawBackspace(data, 0) ||
          matchesKittySequence(data, CODEPOINTS.backspace, 0) ||
          matchesModifyOtherKeys(data, CODEPOINTS.backspace, 0)
        );
      }
      return (
        matchesKittySequence(data, CODEPOINTS.backspace, modifier) ||
        matchesModifyOtherKeys(data, CODEPOINTS.backspace, modifier)
      );

    case "insert":
      if (modifier === 0) {
        return (
          matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.insert) ||
          matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.insert, 0)
        );
      }
      if (matchesLegacyModifierSequence(data, "insert", modifier)) {
        return true;
      }
      return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.insert, modifier);

    case "delete":
      if (modifier === 0) {
        return (
          matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.delete) ||
          matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.delete, 0)
        );
      }
      if (matchesLegacyModifierSequence(data, "delete", modifier)) {
        return true;
      }
      return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.delete, modifier);

    case "clear":
      if (modifier === 0) {
        return matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.clear);
      }
      return matchesLegacyModifierSequence(data, "clear", modifier);

    case "home":
      if (modifier === 0) {
        return (
          matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.home) ||
          matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.home, 0)
        );
      }
      if (matchesLegacyModifierSequence(data, "home", modifier)) {
        return true;
      }
      return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.home, modifier);

    case "end":
      if (modifier === 0) {
        return (
          matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.end) ||
          matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.end, 0)
        );
      }
      if (matchesLegacyModifierSequence(data, "end", modifier)) {
        return true;
      }
      return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.end, modifier);

    case "pageup":
      if (modifier === 0) {
        return (
          matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.pageUp) ||
          matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.pageUp, 0)
        );
      }
      if (matchesLegacyModifierSequence(data, "pageUp", modifier)) {
        return true;
      }
      return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.pageUp, modifier);

    case "pagedown":
      if (modifier === 0) {
        return (
          matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.pageDown) ||
          matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.pageDown, 0)
        );
      }
      if (matchesLegacyModifierSequence(data, "pageDown", modifier)) {
        return true;
      }
      return matchesKittySequence(
        data,
        FUNCTIONAL_CODEPOINTS.pageDown,
        modifier,
      );

    case "up":
      if (modifier === MODIFIERS.alt) {
        return (
          data === "\x1bp" ||
          matchesKittySequence(data, ARROW_CODEPOINTS.up, MODIFIERS.alt)
        );
      }
      if (modifier === 0) {
        return (
          matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.up) ||
          matchesKittySequence(data, ARROW_CODEPOINTS.up, 0)
        );
      }
      if (matchesLegacyModifierSequence(data, "up", modifier)) {
        return true;
      }
      return matchesKittySequence(data, ARROW_CODEPOINTS.up, modifier);

    case "down":
      if (modifier === MODIFIERS.alt) {
        return (
          data === "\x1bn" ||
          matchesKittySequence(data, ARROW_CODEPOINTS.down, MODIFIERS.alt)
        );
      }
      if (modifier === 0) {
        return (
          matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.down) ||
          matchesKittySequence(data, ARROW_CODEPOINTS.down, 0)
        );
      }
      if (matchesLegacyModifierSequence(data, "down", modifier)) {
        return true;
      }
      return matchesKittySequence(data, ARROW_CODEPOINTS.down, modifier);

    case "left":
      if (modifier === MODIFIERS.alt) {
        return (
          data === "\x1b[1;3D" ||
          (!_kittyProtocolActive && data === "\x1bB") ||
          data === "\x1bb" ||
          matchesKittySequence(data, ARROW_CODEPOINTS.left, MODIFIERS.alt)
        );
      }
      if (modifier === MODIFIERS.ctrl) {
        return (
          data === "\x1b[1;5D" ||
          matchesLegacyModifierSequence(data, "left", MODIFIERS.ctrl) ||
          matchesKittySequence(data, ARROW_CODEPOINTS.left, MODIFIERS.ctrl)
        );
      }
      if (modifier === 0) {
        return (
          matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.left) ||
          matchesKittySequence(data, ARROW_CODEPOINTS.left, 0)
        );
      }
      if (matchesLegacyModifierSequence(data, "left", modifier)) {
        return true;
      }
      return matchesKittySequence(data, ARROW_CODEPOINTS.left, modifier);

    case "right":
      if (modifier === MODIFIERS.alt) {
        return (
          data === "\x1b[1;3C" ||
          (!_kittyProtocolActive && data === "\x1bF") ||
          data === "\x1bf" ||
          matchesKittySequence(data, ARROW_CODEPOINTS.right, MODIFIERS.alt)
        );
      }
      if (modifier === MODIFIERS.ctrl) {
        return (
          data === "\x1b[1;5C" ||
          matchesLegacyModifierSequence(data, "right", MODIFIERS.ctrl) ||
          matchesKittySequence(data, ARROW_CODEPOINTS.right, MODIFIERS.ctrl)
        );
      }
      if (modifier === 0) {
        return (
          matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.right) ||
          matchesKittySequence(data, ARROW_CODEPOINTS.right, 0)
        );
      }
      if (matchesLegacyModifierSequence(data, "right", modifier)) {
        return true;
      }
      return matchesKittySequence(data, ARROW_CODEPOINTS.right, modifier);

    case "f1":
    case "f2":
    case "f3":
    case "f4":
    case "f5":
    case "f6":
    case "f7":
    case "f8":
    case "f9":
    case "f10":
    case "f11":
    case "f12": {
      if (modifier !== 0) {
        return false;
      }
      const functionKey = key as keyof typeof LEGACY_KEY_SEQUENCES;
      return matchesLegacySequence(data, LEGACY_KEY_SEQUENCES[functionKey]);
    }
  }

  // Handle single letter/digit keys and symbols
  if (
    key.length === 1 &&
    ((key >= "a" && key <= "z") || isDigitKey(key) || SYMBOL_KEYS.has(key))
  ) {
    const codepoint = key.charCodeAt(0);
    const rawCtrl = rawCtrlChar(key);
    const isLetter = key >= "a" && key <= "z";
    const isDigit = isDigitKey(key);

    if (
      modifier === MODIFIERS.ctrl + MODIFIERS.alt &&
      !_kittyProtocolActive &&
      rawCtrl
    ) {
      // Legacy: ctrl+alt+key is ESC followed by the control character.
      // If that legacy form does not match, continue so CSI-u and
      // modifyOtherKeys sequences from tmux can still be recognized.
      if (data === `\x1b${rawCtrl}`) return true;
    }

    if (
      modifier === MODIFIERS.alt &&
      !_kittyProtocolActive &&
      (isLetter || isDigit)
    ) {
      // Legacy: alt+letter/digit is ESC followed by the key
      if (data === `\x1b${key}`) return true;
    }

    if (modifier === MODIFIERS.ctrl) {
      // Legacy: ctrl+key sends the control character
      if (rawCtrl && data === rawCtrl) return true;
      return (
        matchesKittySequence(data, codepoint, MODIFIERS.ctrl) ||
        matchesPrintableModifyOtherKeys(data, codepoint, MODIFIERS.ctrl)
      );
    }

    if (modifier === MODIFIERS.shift + MODIFIERS.ctrl) {
      return (
        matchesKittySequence(
          data,
          codepoint,
          MODIFIERS.shift + MODIFIERS.ctrl,
        ) ||
        matchesPrintableModifyOtherKeys(
          data,
          codepoint,
          MODIFIERS.shift + MODIFIERS.ctrl,
        )
      );
    }

    if (modifier === MODIFIERS.shift) {
      // Legacy: shift+letter produces uppercase
      if (isLetter && data === key.toUpperCase()) return true;
      return (
        matchesKittySequence(data, codepoint, MODIFIERS.shift) ||
        matchesPrintableModifyOtherKeys(data, codepoint, MODIFIERS.shift)
      );
    }

    if (modifier !== 0) {
      return (
        matchesKittySequence(data, codepoint, modifier) ||
        matchesPrintableModifyOtherKeys(data, codepoint, modifier)
      );
    }

    // Check both raw char and Kitty sequence (needed for release events)
    return data === key || matchesKittySequence(data, codepoint, 0);
  }

  return false;
}

type Letter =
  | "a"
  | "b"
  | "c"
  | "d"
  | "e"
  | "f"
  | "g"
  | "h"
  | "i"
  | "j"
  | "k"
  | "l"
  | "m"
  | "n"
  | "o"
  | "p"
  | "q"
  | "r"
  | "s"
  | "t"
  | "u"
  | "v"
  | "w"
  | "x"
  | "y"
  | "z";

type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";

type SymbolKey =
  | "`"
  | "-"
  | "="
  | "["
  | "]"
  | "\\"
  | ";"
  | "'"
  | ","
  | "."
  | "/"
  | "!"
  | "@"
  | "#"
  | "$"
  | "%"
  | "^"
  | "&"
  | "*"
  | "("
  | ")"
  | "_"
  | "+"
  | "|"
  | "~"
  | "{"
  | "}"
  | ":"
  | "<"
  | ">"
  | "?";

type SpecialKey =
  | "escape"
  | "esc"
  | "enter"
  | "return"
  | "tab"
  | "space"
  | "backspace"
  | "delete"
  | "insert"
  | "clear"
  | "home"
  | "end"
  | "pageUp"
  | "pageDown"
  | "up"
  | "down"
  | "left"
  | "right"
  | "f1"
  | "f2"
  | "f3"
  | "f4"
  | "f5"
  | "f6"
  | "f7"
  | "f8"
  | "f9"
  | "f10"
  | "f11"
  | "f12";

type BaseKey = Letter | Digit | SymbolKey | SpecialKey;
type ModifierName = "ctrl" | "shift" | "alt" | "super";

type ModifiedKeyId<
  Key extends string,
  RemainingModifiers extends ModifierName = ModifierName,
> = {
  [M in RemainingModifiers]:
    | `${M}+${Key}`
    | `${M}+${ModifiedKeyId<Key, Exclude<RemainingModifiers, M>>}`;
}[RemainingModifiers];

/**
 * Union type of all valid key identifiers.
 * Provides autocomplete and catches typos at compile time.
 */
export type KeyId = BaseKey | ModifiedKeyId<BaseKey>;

/**
 * Helper object for creating typed key identifiers with autocomplete.
 *
 * Usage:
 * - Key.escape, Key.enter, Key.tab, etc. for special keys
 * - Key.backtick, Key.comma, Key.period, etc. for symbol keys
 * - Key.ctrl("c"), Key.alt("x"), Key.super("k") for single modifiers
 * - Key.ctrlShift("p"), Key.ctrlAlt("x"), Key.ctrlSuper("k") for combined modifiers
 */
export const Key = {
  // Special keys
  escape: "escape" as const,
  esc: "esc" as const,
  enter: "enter" as const,
  return: "return" as const,
  tab: "tab" as const,
  space: "space" as const,
  backspace: "backspace" as const,
  delete: "delete" as const,
  insert: "insert" as const,
  clear: "clear" as const,
  home: "home" as const,
  end: "end" as const,
  pageUp: "pageUp" as const,
  pageDown: "pageDown" as const,
  up: "up" as const,
  down: "down" as const,
  left: "left" as const,
  right: "right" as const,
  f1: "f1" as const,
  f2: "f2" as const,
  f3: "f3" as const,
  f4: "f4" as const,
  f5: "f5" as const,
  f6: "f6" as const,
  f7: "f7" as const,
  f8: "f8" as const,
  f9: "f9" as const,
  f10: "f10" as const,
  f11: "f11" as const,
  f12: "f12" as const,

  // Symbol keys
  backtick: "`" as const,
  hyphen: "-" as const,
  equals: "=" as const,
  leftbracket: "[" as const,
  rightbracket: "]" as const,
  backslash: "\\" as const,
  semicolon: ";" as const,
  quote: "'" as const,
  comma: "," as const,
  period: "." as const,
  slash: "/" as const,
  exclamation: "!" as const,
  at: "@" as const,
  hash: "#" as const,
  dollar: "$" as const,
  percent: "%" as const,
  caret: "^" as const,
  ampersand: "&" as const,
  asterisk: "*" as const,
  leftparen: "(" as const,
  rightparen: ")" as const,
  underscore: "_" as const,
  plus: "+" as const,
  pipe: "|" as const,
  tilde: "~" as const,
  leftbrace: "{" as const,
  rightbrace: "}" as const,
  colon: ":" as const,
  lessthan: "<" as const,
  greaterthan: ">" as const,
  question: "?" as const,

  // Single modifiers
  ctrl: <K extends BaseKey>(key: K): `ctrl+${K}` => `ctrl+${key}`,
  shift: <K extends BaseKey>(key: K): `shift+${K}` => `shift+${key}`,
  alt: <K extends BaseKey>(key: K): `alt+${K}` => `alt+${key}`,
  super: <K extends BaseKey>(key: K): `super+${K}` => `super+${key}`,

  // Combined modifiers
  ctrlShift: <K extends BaseKey>(key: K): `ctrl+shift+${K}` =>
    `ctrl+shift+${key}`,
  shiftCtrl: <K extends BaseKey>(key: K): `shift+ctrl+${K}` =>
    `shift+ctrl+${key}`,
  ctrlAlt: <K extends BaseKey>(key: K): `ctrl+alt+${K}` => `ctrl+alt+${key}`,
  altCtrl: <K extends BaseKey>(key: K): `alt+ctrl+${K}` => `alt+ctrl+${key}`,
  shiftAlt: <K extends BaseKey>(key: K): `shift+alt+${K}` => `shift+alt+${key}`,
  altShift: <K extends BaseKey>(key: K): `alt+shift+${K}` => `alt+shift+${key}`,
  ctrlSuper: <K extends BaseKey>(key: K): `ctrl+super+${K}` =>
    `ctrl+super+${key}`,
  superCtrl: <K extends BaseKey>(key: K): `super+ctrl+${K}` =>
    `super+ctrl+${key}`,
  shiftSuper: <K extends BaseKey>(key: K): `shift+super+${K}` =>
    `shift+super+${key}`,
  superShift: <K extends BaseKey>(key: K): `super+shift+${K}` =>
    `super+shift+${key}`,
  altSuper: <K extends BaseKey>(key: K): `alt+super+${K}` => `alt+super+${key}`,
  superAlt: <K extends BaseKey>(key: K): `super+alt+${K}` => `super+alt+${key}`,

  // Triple modifiers
  ctrlShiftAlt: <K extends BaseKey>(key: K): `ctrl+shift+alt+${K}` =>
    `ctrl+shift+alt+${key}`,
  ctrlShiftSuper: <K extends BaseKey>(key: K): `ctrl+shift+super+${K}` =>
    `ctrl+shift+super+${key}`,
} as const;

// =============================================================================
// Constants
// =============================================================================

export const SYMBOL_KEYS = new Set([
  "`",
  "-",
  "=",
  "[",
  "]",
  "\\",
  ";",
  "'",
  ",",
  ".",
  "/",
  "!",
  "@",
  "#",
  "$",
  "%",
  "^",
  "&",
  "*",
  "(",
  ")",
  "_",
  "+",
  "|",
  "~",
  "{",
  "}",
  ":",
  "<",
  ">",
  "?",
]);

export const MODIFIERS = {
  shift: 1,
  alt: 2,
  ctrl: 4,
  super: 8,
} as const;

export const LOCK_MASK = 64 + 128; // Caps Lock + Num Lock

export const CODEPOINTS = {
  escape: 27,
  tab: 9,
  enter: 13,
  space: 32,
  backspace: 127,
  kpEnter: 57414, // Numpad Enter (Kitty protocol)
} as const;

export const ARROW_CODEPOINTS = {
  up: -1,
  down: -2,
  right: -3,
  left: -4,
} as const;

export const FUNCTIONAL_CODEPOINTS = {
  delete: -10,
  insert: -11,
  pageUp: -12,
  pageDown: -13,
  home: -14,
  end: -15,
} as const;

export const KITTY_FUNCTIONAL_KEY_EQUIVALENTS = new Map<number, number>([
  [57399, 48], // KP_0 -> 0
  [57400, 49], // KP_1 -> 1
  [57401, 50], // KP_2 -> 2
  [57402, 51], // KP_3 -> 3
  [57403, 52], // KP_4 -> 4
  [57404, 53], // KP_5 -> 5
  [57405, 54], // KP_6 -> 6
  [57406, 55], // KP_7 -> 7
  [57407, 56], // KP_8 -> 8
  [57408, 57], // KP_9 -> 9
  [57409, 46], // KP_DECIMAL -> .
  [57410, 47], // KP_DIVIDE -> /
  [57411, 42], // KP_MULTIPLY -> *
  [57412, 45], // KP_SUBTRACT -> -
  [57413, 43], // KP_ADD -> +
  [57415, 61], // KP_EQUAL -> =
  [57416, 44], // KP_SEPARATOR -> ,
  [57417, ARROW_CODEPOINTS.left],
  [57418, ARROW_CODEPOINTS.right],
  [57419, ARROW_CODEPOINTS.up],
  [57420, ARROW_CODEPOINTS.down],
  [57421, FUNCTIONAL_CODEPOINTS.pageUp],
  [57422, FUNCTIONAL_CODEPOINTS.pageDown],
  [57423, FUNCTIONAL_CODEPOINTS.home],
  [57424, FUNCTIONAL_CODEPOINTS.end],
  [57425, FUNCTIONAL_CODEPOINTS.insert],
  [57426, FUNCTIONAL_CODEPOINTS.delete],
]);

export function normalizeKittyFunctionalCodepoint(codepoint: number): number {
  return KITTY_FUNCTIONAL_KEY_EQUIVALENTS.get(codepoint) ?? codepoint;
}

export function normalizeShiftedLetterIdentityCodepoint(
  codepoint: number,
  modifier: number,
): number {
  const effectiveModifier = modifier & ~LOCK_MASK;
  if (
    (effectiveModifier & MODIFIERS.shift) !== 0 &&
    codepoint >= 65 &&
    codepoint <= 90
  ) {
    return codepoint + 32;
  }
  return codepoint;
}

export const LEGACY_KEY_SEQUENCES = {
  up: ["\x1b[A", "\x1bOA"],
  down: ["\x1b[B", "\x1bOB"],
  right: ["\x1b[C", "\x1bOC"],
  left: ["\x1b[D", "\x1bOD"],
  home: ["\x1b[H", "\x1bOH", "\x1b[1~", "\x1b[7~"],
  end: ["\x1b[F", "\x1bOF", "\x1b[4~", "\x1b[8~"],
  insert: ["\x1b[2~"],
  delete: ["\x1b[3~"],
  pageUp: ["\x1b[5~", "\x1b[[5~"],
  pageDown: ["\x1b[6~", "\x1b[[6~"],
  clear: ["\x1b[E", "\x1bOE"],
  f1: ["\x1bOP", "\x1b[11~", "\x1b[[A"],
  f2: ["\x1bOQ", "\x1b[12~", "\x1b[[B"],
  f3: ["\x1bOR", "\x1b[13~", "\x1b[[C"],
  f4: ["\x1bOS", "\x1b[14~", "\x1b[[D"],
  f5: ["\x1b[15~", "\x1b[[E"],
  f6: ["\x1b[17~"],
  f7: ["\x1b[18~"],
  f8: ["\x1b[19~"],
  f9: ["\x1b[20~"],
  f10: ["\x1b[21~"],
  f11: ["\x1b[23~"],
  f12: ["\x1b[24~"],
} as const;

const LEGACY_SHIFT_SEQUENCES = {
  up: ["\x1b[a"],
  down: ["\x1b[b"],
  right: ["\x1b[c"],
  left: ["\x1b[d"],
  clear: ["\x1b[e"],
  insert: ["\x1b[2$"],
  delete: ["\x1b[3$"],
  pageUp: ["\x1b[5$"],
  pageDown: ["\x1b[6$"],
  home: ["\x1b[7$"],
  end: ["\x1b[8$"],
} as const;

const LEGACY_CTRL_SEQUENCES = {
  up: ["\x1bOa"],
  down: ["\x1bOb"],
  right: ["\x1bOc"],
  left: ["\x1bOd"],
  clear: ["\x1bOe"],
  insert: ["\x1b[2^"],
  delete: ["\x1b[3^"],
  pageUp: ["\x1b[5^"],
  pageDown: ["\x1b[6^"],
  home: ["\x1b[7^"],
  end: ["\x1b[8^"],
} as const;

export const LEGACY_SEQUENCE_KEY_IDS: Record<string, KeyId> = {
  "\x1bOA": "up",
  "\x1bOB": "down",
  "\x1bOC": "right",
  "\x1bOD": "left",
  "\x1bOH": "home",
  "\x1bOF": "end",
  "\x1b[E": "clear",
  "\x1bOE": "clear",
  "\x1bOe": "ctrl+clear",
  "\x1b[e": "shift+clear",
  "\x1b[2~": "insert",
  "\x1b[2$": "shift+insert",
  "\x1b[2^": "ctrl+insert",
  "\x1b[3$": "shift+delete",
  "\x1b[3^": "ctrl+delete",
  "\x1b[[5~": "pageUp",
  "\x1b[[6~": "pageDown",
  "\x1b[a": "shift+up",
  "\x1b[b": "shift+down",
  "\x1b[c": "shift+right",
  "\x1b[d": "shift+left",
  "\x1bOa": "ctrl+up",
  "\x1bOb": "ctrl+down",
  "\x1bOc": "ctrl+right",
  "\x1bOd": "ctrl+left",
  "\x1b[5$": "shift+pageUp",
  "\x1b[6$": "shift+pageDown",
  "\x1b[7$": "shift+home",
  "\x1b[8$": "shift+end",
  "\x1b[5^": "ctrl+pageUp",
  "\x1b[6^": "ctrl+pageDown",
  "\x1b[7^": "ctrl+home",
  "\x1b[8^": "ctrl+end",
  "\x1bOP": "f1",
  "\x1bOQ": "f2",
  "\x1bOR": "f3",
  "\x1bOS": "f4",
  "\x1b[11~": "f1",
  "\x1b[12~": "f2",
  "\x1b[13~": "f3",
  "\x1b[14~": "f4",
  "\x1b[[A": "f1",
  "\x1b[[B": "f2",
  "\x1b[[C": "f3",
  "\x1b[[D": "f4",
  "\x1b[[E": "f5",
  "\x1b[15~": "f5",
  "\x1b[17~": "f6",
  "\x1b[18~": "f7",
  "\x1b[19~": "f8",
  "\x1b[20~": "f9",
  "\x1b[21~": "f10",
  "\x1b[23~": "f11",
  "\x1b[24~": "f12",
  "\x1bb": "alt+left",
  "\x1bf": "alt+right",
  "\x1bp": "alt+up",
  "\x1bn": "alt+down",
} as const;

type LegacyModifierKey = keyof typeof LEGACY_SHIFT_SEQUENCES;

export const matchesLegacySequence = (
  data: string,
  sequences: readonly string[],
): boolean => sequences.includes(data);

export const matchesLegacyModifierSequence = (
  data: string,
  key: LegacyModifierKey,
  modifier: number,
): boolean => {
  if (modifier === MODIFIERS.shift) {
    return matchesLegacySequence(data, LEGACY_SHIFT_SEQUENCES[key]);
  }
  if (modifier === MODIFIERS.ctrl) {
    return matchesLegacySequence(data, LEGACY_CTRL_SEQUENCES[key]);
  }
  return false;
};

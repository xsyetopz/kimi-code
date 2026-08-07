const THAI_LAO_AM_REGEX = /[\u0e33\u0eb3]/u;
const THAI_LAO_AM_GLOBAL_REGEX = /[\u0e33\u0eb3]/gu;

export function normalizeTerminalOutput(str: string): string {
  if (!THAI_LAO_AM_REGEX.test(str)) return str;
  return str.replace(THAI_LAO_AM_GLOBAL_REGEX, (char) =>
    char === "\u0e33" ? "\u0e4d\u0e32" : "\u0ecd\u0eb2",
  );
}

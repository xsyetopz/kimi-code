export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

export type TerminalColorScheme = "dark" | "light";

function hexToRgb(hex: string): RgbColor {
  const normalized = hex.startsWith("#") ? hex.slice(1) : hex;
  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  return { r, g, b };
}

function parseOscHexChannel(channel: string): number | undefined {
  if (!/^[0-9a-f]+$/iu.test(channel)) {
    return;
  }
  const max = 16 ** channel.length - 1;
  if (max <= 0) {
    return;
  }
  return Math.round((Number.parseInt(channel, 16) / max) * 255);
}

const OSC11_BACKGROUND_COLOR_RESPONSE_PATTERN =
  /^\x1b\]11;([^\x07\x1b]*)(?:\x07|\x1b\\)$/iu;
const COLOR_SCHEME_REPORT_PATTERN = /^\x1b\[\?997;(1|2)n$/u;

export function isOsc11BackgroundColorResponse(data: string): boolean {
  return OSC11_BACKGROUND_COLOR_RESPONSE_PATTERN.test(data);
}

export function parseOsc11BackgroundColor(data: string): RgbColor | undefined {
  const match = data.match(OSC11_BACKGROUND_COLOR_RESPONSE_PATTERN);
  if (!match) {
    return;
  }

  const value = match[1]?.trim();
  if (value.startsWith("#")) {
    const hex = value.slice(1);
    if (/^[0-9a-f]{6}$/iu.test(hex)) {
      return hexToRgb(value);
    }
    if (/^[0-9a-f]{12}$/iu.test(hex)) {
      const r = parseOscHexChannel(hex.slice(0, 4));
      const g = parseOscHexChannel(hex.slice(4, 8));
      const b = parseOscHexChannel(hex.slice(8, 12));
      return r !== undefined && g !== undefined && b !== undefined
        ? { r, g, b }
        : undefined;
    }
    return;
  }

  const rgbValue = value.replace(/^rgba?:/iu, "");
  const [red, green, blue] = rgbValue.split("/");
  if (red === undefined || green === undefined || blue === undefined) {
    return;
  }
  const r = parseOscHexChannel(red);
  const g = parseOscHexChannel(green);
  const b = parseOscHexChannel(blue);
  return r !== undefined && g !== undefined && b !== undefined
    ? { r, g, b }
    : undefined;
}

export function parseTerminalColorSchemeReport(
  data: string,
): TerminalColorScheme | undefined {
  const match = data.match(COLOR_SCHEME_REPORT_PATTERN);
  if (!match) {
    return;
  }
  return match[1] === "2" ? "light" : "dark";
}

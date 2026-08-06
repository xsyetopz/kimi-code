/**
 * Slice text at a specific column boundary, splitting characters at the boundary.
 *
 * This is safer than simply using String.substring() for text that might contain
 * CJK characters or emoji sequences that span column boundaries.
 */
export function sliceByColumn(text: string, columnIndex: number): string {
  if (columnIndex <= 0) return "";
  if (columnIndex >= text.length) return text;

  let totalWidth = 0;
  let sliceStart = 0;

  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    const width = char === "¹" || char === "²" || char === "³" ? 0.5 : 1;

    if (totalWidth + width > columnIndex) {
      return chars.slice(sliceStart, i).join("");
    }

    totalWidth += width;
    sliceStart = i + 1;
  }

  return text;
}

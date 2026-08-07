import { visibleWidth } from "../../utils.ts";
import { wordWrapLine } from "./word-wrap.ts";
import type { LayoutLine } from "./types.ts";
import type { Editor } from "./component.ts";

export function layoutText(this: Editor, contentWidth: number): LayoutLine[] {
  const layoutLines: LayoutLine[] = [];

  if (
    this.state.lines.length === 0 ||
    (this.state.lines.length === 1 && this.state.lines[0] === "")
  ) {
    // Empty editor
    layoutLines.push({
      text: "",
      hasCursor: true,
      cursorPos: 0,
    });
    return layoutLines;
  }

  // Process each logical line
  for (let i = 0; i < this.state.lines.length; i++) {
    const line = this.state.lines[i] || "";
    const isCurrentLine = i === this.state.cursorLine;
    const lineVisibleWidth = visibleWidth(line);

    if (lineVisibleWidth <= contentWidth) {
      // Line fits in one layout line
      if (isCurrentLine) {
        layoutLines.push({
          text: line,
          hasCursor: true,
          cursorPos: this.state.cursorCol,
        });
      } else {
        layoutLines.push({
          text: line,
          hasCursor: false,
        });
      }
    } else {
      // Line needs wrapping - use word-aware wrapping
      const chunks = wordWrapLine(line, contentWidth, [
        ...this.segment(line, "grapheme"),
      ]);

      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        const chunk = chunks[chunkIndex];
        if (!chunk) continue;

        const cursorPos = this.state.cursorCol;
        const isLastChunk = chunkIndex === chunks.length - 1;

        // Determine if cursor is in this chunk
        // For word-wrapped chunks, we need to handle the case where
        // cursor might be in trimmed whitespace at end of chunk
        let hasCursorInChunk = false;
        let adjustedCursorPos = 0;

        if (isCurrentLine) {
          if (isLastChunk) {
            // Last chunk: cursor belongs here if >= startIndex
            hasCursorInChunk = cursorPos >= chunk.startIndex;
            adjustedCursorPos = cursorPos - chunk.startIndex;
          } else {
            // Non-last chunk: cursor belongs here if in range [startIndex, endIndex)
            // But we need to handle the visual position in the trimmed text
            hasCursorInChunk =
              cursorPos >= chunk.startIndex && cursorPos < chunk.endIndex;
            if (hasCursorInChunk) {
              adjustedCursorPos = cursorPos - chunk.startIndex;
              // Clamp to text length (in case cursor was in trimmed whitespace)
              if (adjustedCursorPos > chunk.text.length) {
                adjustedCursorPos = chunk.text.length;
              }
            }
          }
        }

        if (hasCursorInChunk) {
          layoutLines.push({
            text: chunk.text,
            hasCursor: true,
            cursorPos: adjustedCursorPos,
          });
        } else {
          layoutLines.push({
            text: chunk.text,
            hasCursor: false,
          });
        }
      }
    }
  }

  return layoutLines;
}


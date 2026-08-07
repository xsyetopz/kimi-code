import { findWordForward, findWordBackward } from "../../word-navigation.ts";
import { isPasteMarker, wordWrapLine } from "./word-wrap.ts";
import { visibleWidth } from "../../utils.ts";
import type { Editor } from "./component.ts";

export function buildVisualLineMap(this: Editor, 
  width: number,
): Array<{ logicalLine: number; startCol: number; length: number }> {
  const visualLines: Array<{
    logicalLine: number;
    startCol: number;
    length: number;
  }> = [];

  for (let i = 0; i < this.state.lines.length; i++) {
    const line = this.state.lines[i] || "";
    const lineVisWidth = visibleWidth(line);
    if (line.length === 0) {
      // Empty line still takes one visual line
      visualLines.push({ logicalLine: i, startCol: 0, length: 0 });
    } else if (lineVisWidth <= width) {
      visualLines.push({ logicalLine: i, startCol: 0, length: line.length });
    } else {
      // Line needs wrapping - use word-aware wrapping
      const chunks = wordWrapLine(line, width, [
        ...this.segment(line, "grapheme"),
      ]);
      for (const chunk of chunks) {
        visualLines.push({
          logicalLine: i,
          startCol: chunk.startIndex,
          length: chunk.endIndex - chunk.startIndex,
        });
      }
    }
  }

  return visualLines;
}

export function findVisualLineAt(this: Editor, 
  visualLines: Array<{
    logicalLine: number;
    startCol: number;
    length: number;
  }>,
  line: number,
  col: number,
): number {
  for (let i = 0; i < visualLines.length; i++) {
    const vl = visualLines[i];
    if (!vl || vl.logicalLine !== line) continue;
    const offset = col - vl.startCol;
    // Cursor is in this segment if it's within range. For the last
    // segment of a logical line, cursor can be at length (end position)
    const isLastSegmentOfLine =
      i === visualLines.length - 1 ||
      visualLines[i + 1]?.logicalLine !== vl.logicalLine;
    if (
      offset >= 0 &&
      (offset < vl.length || (isLastSegmentOfLine && offset === vl.length))
    ) {
      return i;
    }
  }
  return visualLines.length - 1;
}

export function findCurrentVisualLine(this: Editor, 
  visualLines: Array<{
    logicalLine: number;
    startCol: number;
    length: number;
  }>,
): number {
  return this.findVisualLineAt(
    visualLines,
    this.state.cursorLine,
    this.state.cursorCol,
  );
}

export function moveCursor(this: Editor, deltaLine: number, deltaCol: number): void {
  this.lastAction = null;
  const visualLines = this.buildVisualLineMap(this.lastWidth);
  const currentVisualLine = this.findCurrentVisualLine(visualLines);

  if (deltaLine !== 0) {
    const targetVisualLine = currentVisualLine + deltaLine;

    if (targetVisualLine >= 0 && targetVisualLine < visualLines.length) {
      this.moveToVisualLine(visualLines, currentVisualLine, targetVisualLine);
    }
  }

  if (deltaCol !== 0) {
    const currentLine = this.state.lines[this.state.cursorLine] || "";

    if (deltaCol > 0) {
      // Moving right - move by one grapheme (handles emojis, combining characters, etc.)
      if (this.state.cursorCol < currentLine.length) {
        const afterCursor = currentLine.slice(this.state.cursorCol);
        const graphemes = [...this.segment(afterCursor, "grapheme")];
        const firstGrapheme = graphemes[0];
        this.setCursorCol(
          this.state.cursorCol +
            (firstGrapheme ? firstGrapheme.segment.length : 1),
        );
      } else if (this.state.cursorLine < this.state.lines.length - 1) {
        // Wrap to start of next logical line
        this.state.cursorLine++;
        this.setCursorCol(0);
      } else {
        // At end of last line - can't move, but set preferredVisualCol for up/down navigation
        const currentVL = visualLines[currentVisualLine];
        if (currentVL) {
          this.preferredVisualCol = this.state.cursorCol - currentVL.startCol;
        }
      }
    } else {
      // Moving left - move by one grapheme (handles emojis, combining characters, etc.)
      if (this.state.cursorCol > 0) {
        const beforeCursor = currentLine.slice(0, this.state.cursorCol);
        const graphemes = [...this.segment(beforeCursor, "grapheme")];
        const lastGrapheme = graphemes[graphemes.length - 1];
        this.setCursorCol(
          this.state.cursorCol -
            (lastGrapheme ? lastGrapheme.segment.length : 1),
        );
      } else if (this.state.cursorLine > 0) {
        // Wrap to end of previous logical line
        this.state.cursorLine--;
        const prevLine = this.state.lines[this.state.cursorLine] || "";
        this.setCursorCol(prevLine.length);
      }
    }
  }

  // Keep an open autocomplete picker in sync with the new cursor
  // position: cursor movement changes the text before the cursor, so a
  // picker computed for the old position is stale. Re-query so it
  // refreshes — or closes when the new position yields no suggestions —
  // mirroring insertCharacter()/handleBackspace(). Without this, arrowing
  // left from `/cmd ` back into the command name leaves the argument
  // picker showing against a `/cmd` prefix (and a Tab there would
  // concatenate the stale suggestion onto the partial command name).
  if (this.autocompleteState) {
    this.updateAutocomplete();
  }
}

export function pageScroll(this: Editor, direction: -1 | 1): void {
  this.lastAction = null;
  const terminalRows = this.tui.terminal.rows;
  const pageSize = Math.max(5, Math.floor(terminalRows * 0.3));

  const visualLines = this.buildVisualLineMap(this.lastWidth);
  const currentVisualLine = this.findCurrentVisualLine(visualLines);
  const targetVisualLine = Math.max(
    0,
    Math.min(
      visualLines.length - 1,
      currentVisualLine + direction * pageSize,
    ),
  );

  this.moveToVisualLine(visualLines, currentVisualLine, targetVisualLine);
}

export function moveWordBackwards(this: Editor, ): void {
  this.lastAction = null;
  const currentLine = this.state.lines[this.state.cursorLine] || "";

  // If at start of line, move to end of previous line
  if (this.state.cursorCol === 0) {
    if (this.state.cursorLine > 0) {
      this.state.cursorLine--;
      const prevLine = this.state.lines[this.state.cursorLine] || "";
      this.setCursorCol(prevLine.length);
    }
    return;
  }

  this.setCursorCol(
    findWordBackward(currentLine, this.state.cursorCol, {
      segment: (text) => this.segment(text, "word"),
      isAtomicSegment: isPasteMarker,
    }),
  );
}

export function yank(this: Editor, ): void {
  if (this.killRing.length === 0) return;

  this.pushUndoSnapshot();

  const text = this.killRing.peek()!;
  this.insertYankedText(text);

  this.lastAction = "yank";
}

export function yankPop(this: Editor, ): void {
  // Only works if we just yanked and have more than one entry
  if (this.lastAction !== "yank" || this.killRing.length <= 1) return;

  this.pushUndoSnapshot();

  // Delete the previously yanked text (still at end of ring before rotation)
  this.deleteYankedText();

  // Rotate the ring: move end to front
  this.killRing.rotate();

  // Insert the new most recent entry (now at end after rotation)
  const text = this.killRing.peek()!;
  this.insertYankedText(text);

  this.lastAction = "yank";
}

export function insertYankedText(this: Editor, text: string): void {
  this.exitHistoryBrowsing();
  const lines = text.split("\n");

  if (lines.length === 1) {
    // Single line - insert at cursor
    const currentLine = this.state.lines[this.state.cursorLine] || "";
    const before = currentLine.slice(0, this.state.cursorCol);
    const after = currentLine.slice(this.state.cursorCol);
    this.state.lines[this.state.cursorLine] = before + text + after;
    this.setCursorCol(this.state.cursorCol + text.length);
  } else {
    // Multi-line insert
    const currentLine = this.state.lines[this.state.cursorLine] || "";
    const before = currentLine.slice(0, this.state.cursorCol);
    const after = currentLine.slice(this.state.cursorCol);

    // First line merges with text before cursor
    this.state.lines[this.state.cursorLine] = before + (lines[0] || "");

    // Insert middle lines
    for (let i = 1; i < lines.length - 1; i++) {
      this.state.lines.splice(this.state.cursorLine + i, 0, lines[i] || "");
    }

    // Last line merges with text after cursor
    const lastLineIndex = this.state.cursorLine + lines.length - 1;
    this.state.lines.splice(
      lastLineIndex,
      0,
      (lines[lines.length - 1] || "") + after,
    );

    // Update cursor position
    this.state.cursorLine = lastLineIndex;
    this.setCursorCol((lines[lines.length - 1] || "").length);
  }

  if (this.onChange) {
    this.onChange(this.getText());
  }
}

export function deleteYankedText(this: Editor, ): void {
  const yankedText = this.killRing.peek();
  if (!yankedText) return;

  const yankLines = yankedText.split("\n");

  if (yankLines.length === 1) {
    // Single line - delete backward from cursor
    const currentLine = this.state.lines[this.state.cursorLine] || "";
    const deleteLen = yankedText.length;
    const before = currentLine.slice(0, this.state.cursorCol - deleteLen);
    const after = currentLine.slice(this.state.cursorCol);
    this.state.lines[this.state.cursorLine] = before + after;
    this.setCursorCol(this.state.cursorCol - deleteLen);
  } else {
    // Multi-line delete - cursor is at end of last yanked line
    const startLine = this.state.cursorLine - (yankLines.length - 1);
    const startCol =
      (this.state.lines[startLine] || "").length -
      (yankLines[0] || "").length;

    // Get text after cursor on current line
    const afterCursor = (this.state.lines[this.state.cursorLine] || "").slice(
      this.state.cursorCol,
    );

    // Get text before yank start position
    const beforeYank = (this.state.lines[startLine] || "").slice(0, startCol);

    // Remove all lines from startLine to cursorLine and replace with merged line
    this.state.lines.splice(
      startLine,
      yankLines.length,
      beforeYank + afterCursor,
    );

    // Update cursor
    this.state.cursorLine = startLine;
    this.setCursorCol(startCol);
  }

  if (this.onChange) {
    this.onChange(this.getText());
  }
}

export function jumpToChar(this: Editor, char: string, direction: "forward" | "backward"): void {
  this.lastAction = null;
  const isForward = direction === "forward";
  const lines = this.state.lines;

  const end = isForward ? lines.length : -1;
  const step = isForward ? 1 : -1;

  for (
    let lineIdx = this.state.cursorLine;
    lineIdx !== end;
    lineIdx += step
  ) {
    const line = lines[lineIdx] || "";
    const isCurrentLine = lineIdx === this.state.cursorLine;

    // Current line: start after/before cursor; other lines: search full line
    const searchFrom = isCurrentLine
      ? isForward
        ? this.state.cursorCol + 1
        : this.state.cursorCol - 1
      : undefined;

    const idx = isForward
      ? line.indexOf(char, searchFrom)
      : line.lastIndexOf(char, searchFrom);

    if (idx !== -1) {
      this.state.cursorLine = lineIdx;
      this.setCursorCol(idx);
      return;
    }
  }
  // No match found - cursor stays in place
}

export function moveWordForwards(this: Editor, ): void {
  this.lastAction = null;
  const currentLine = this.state.lines[this.state.cursorLine] || "";

  // If at end of line, move to start of next line
  if (this.state.cursorCol >= currentLine.length) {
    if (this.state.cursorLine < this.state.lines.length - 1) {
      this.state.cursorLine++;
      this.setCursorCol(0);
    }
    return;
  }

  this.setCursorCol(
    findWordForward(currentLine, this.state.cursorCol, {
      segment: (text) => this.segment(text, "word"),
      isAtomicSegment: isPasteMarker,
    }),
  );
}


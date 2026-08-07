import { findWordBackward, findWordForward } from "../../word-navigation.ts";
import { isPasteMarker } from "./word-wrap.ts";
import type { Editor } from "./component.ts";

export function handleBackspace(this: Editor, ): void {
  this.exitHistoryBrowsing();
  this.lastAction = null;

  if (this.state.cursorCol > 0) {
    this.pushUndoSnapshot();

    // Delete grapheme before cursor (handles emojis, combining characters, etc.)
    const line = this.state.lines[this.state.cursorLine] || "";
    const beforeCursor = line.slice(0, this.state.cursorCol);

    // Find the last grapheme in the text before cursor
    const graphemes = [...this.segment(beforeCursor, "grapheme")];
    const lastGrapheme = graphemes[graphemes.length - 1];
    const graphemeLength = lastGrapheme ? lastGrapheme.segment.length : 1;

    const before = line.slice(0, this.state.cursorCol - graphemeLength);
    const after = line.slice(this.state.cursorCol);

    this.state.lines[this.state.cursorLine] = before + after;
    this.setCursorCol(this.state.cursorCol - graphemeLength);
  } else if (this.state.cursorLine > 0) {
    this.pushUndoSnapshot();

    // Merge with previous line
    const currentLine = this.state.lines[this.state.cursorLine] || "";
    const previousLine = this.state.lines[this.state.cursorLine - 1] || "";

    this.state.lines[this.state.cursorLine - 1] = previousLine + currentLine;
    this.state.lines.splice(this.state.cursorLine, 1);

    this.state.cursorLine--;
    this.setCursorCol(previousLine.length);
  }

  if (this.onChange) {
    this.onChange(this.getText());
  }

  // Update or re-trigger autocomplete after backspace
  if (this.autocompleteState) {
    this.updateAutocomplete();
  } else {
    // If autocomplete was cancelled (no matches), re-trigger if we're in a completable context
    const currentLine = this.state.lines[this.state.cursorLine] || "";
    const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
    // Slash command context
    if (this.isInSlashCommandContext(textBeforeCursor)) {
      this.tryTriggerAutocomplete();
    }
    // Symbol-based completion context like @, #, or provider triggers
    else if (this.autocompleteTriggerPattern.test(textBeforeCursor)) {
      this.tryTriggerAutocomplete();
    }
  }
}

export function setCursorCol(this: Editor, col: number): void {
  this.state.cursorCol = col;
  this.preferredVisualCol = null;
  this.snappedFromCursorCol = null;
}

export function moveToVisualLine(this: Editor, 
  visualLines: Array<{
    logicalLine: number;
    startCol: number;
    length: number;
  }>,
  currentVisualLine: number,
  targetVisualLine: number,
): void {
  const currentVL = visualLines[currentVisualLine];
  const targetVL = visualLines[targetVisualLine];
  if (!(currentVL && targetVL)) return;

  // When the cursor was snapped to a segment start, resolve the pre-snap
  // position against the VL it belongs to. This gives the correct visual
  // column even after a resize reshuffles VLs.
  let currentVisualCol: number;
  if (this.snappedFromCursorCol !== null) {
    const vlIndex = this.findVisualLineAt(
      visualLines,
      currentVL.logicalLine,
      this.snappedFromCursorCol,
    );
    currentVisualCol =
      this.snappedFromCursorCol - visualLines[vlIndex]!.startCol;
  } else {
    currentVisualCol = this.state.cursorCol - currentVL.startCol;
  }

  // For non-last segments, clamp to length-1 to stay within the segment
  const isLastSourceSegment =
    currentVisualLine === visualLines.length - 1 ||
    visualLines[currentVisualLine + 1]?.logicalLine !== currentVL.logicalLine;
  const sourceMaxVisualCol = isLastSourceSegment
    ? currentVL.length
    : Math.max(0, currentVL.length - 1);

  const isLastTargetSegment =
    targetVisualLine === visualLines.length - 1 ||
    visualLines[targetVisualLine + 1]?.logicalLine !== targetVL.logicalLine;
  const targetMaxVisualCol = isLastTargetSegment
    ? targetVL.length
    : Math.max(0, targetVL.length - 1);

  const moveToVisualCol = this.computeVerticalMoveColumn(
    currentVisualCol,
    sourceMaxVisualCol,
    targetMaxVisualCol,
  );

  // Set cursor position
  this.state.cursorLine = targetVL.logicalLine;
  const targetCol = targetVL.startCol + moveToVisualCol;
  const logicalLine = this.state.lines[targetVL.logicalLine] || "";
  this.state.cursorCol = Math.min(targetCol, logicalLine.length);

  // Snap cursor to atomic segment boundary (e.g. paste markers)
  // so the cursor never lands in the middle of a multi-grapheme unit.
  // Single-grapheme segments don't need snapping.
  const segments = [...this.segment(logicalLine, "grapheme")];
  for (const seg of segments) {
    if (seg.index > this.state.cursorCol) break;
    if (seg.segment.length <= 1) continue;
    if (this.state.cursorCol < seg.index + seg.segment.length) {
      const isContinuation = seg.index < targetVL.startCol;
      const isMovingDown = targetVisualLine > currentVisualLine;

      if (isContinuation && isMovingDown) {
        // The segment started on a previous visual line, and we
        // already visited it on the way down. Skip all remaining
        // continuation VLs and land on the first VL past it.
        const segEnd = seg.index + seg.segment.length;
        let next = targetVisualLine + 1;
        while (
          next < visualLines.length &&
          visualLines[next]!.logicalLine === targetVL.logicalLine &&
          visualLines[next]!.startCol < segEnd
        ) {
          next++;
        }
        if (next < visualLines.length) {
          this.moveToVisualLine(visualLines, currentVisualLine, next);
          return;
        }
      }

      // Snap to the start of the segment so it gets highlighted.
      // Store the pre-snap position so the next vertical move can
      // resolve it to the correct visual column.
      this.snappedFromCursorCol = this.state.cursorCol;
      this.state.cursorCol = seg.index;
      return;
    }
  }

  // No snap occurred – we moved out of the atomic segment.
  this.snappedFromCursorCol = null;
}

export function computeVerticalMoveColumn(this: Editor, 
  currentVisualCol: number,
  sourceMaxVisualCol: number,
  targetMaxVisualCol: number,
): number {
  const hasPreferred = this.preferredVisualCol !== null; // P
  const cursorInMiddle = currentVisualCol < sourceMaxVisualCol; // S
  const targetTooShort = targetMaxVisualCol < currentVisualCol; // T

  if (!hasPreferred || cursorInMiddle) {
    if (targetTooShort) {
      // Cases 2 and 7
      this.preferredVisualCol = currentVisualCol;
      return targetMaxVisualCol;
    }

    // Cases 1 and 6
    this.preferredVisualCol = null;
    return currentVisualCol;
  }

  const targetCantFitPreferred =
    targetMaxVisualCol < this.preferredVisualCol!; // U
  if (targetTooShort || targetCantFitPreferred) {
    // Cases 4 and 5
    return targetMaxVisualCol;
  }

  // Case 3
  const result = this.preferredVisualCol!;
  this.preferredVisualCol = null;
  return result;
}

export function moveToLineStart(this: Editor, ): void {
  this.lastAction = null;
  this.setCursorCol(0);
}

export function moveToLineEnd(this: Editor, ): void {
  this.lastAction = null;
  const currentLine = this.state.lines[this.state.cursorLine] || "";
  this.setCursorCol(currentLine.length);
}

export function deleteToStartOfLine(this: Editor, ): void {
  this.exitHistoryBrowsing();

  const currentLine = this.state.lines[this.state.cursorLine] || "";

  if (this.state.cursorCol > 0) {
    this.pushUndoSnapshot();

    // Calculate text to be deleted and save to kill ring (backward deletion = prepend)
    const deletedText = currentLine.slice(0, this.state.cursorCol);
    this.killRing.push(deletedText, {
      prepend: true,
      accumulate: this.lastAction === "kill",
    });
    this.lastAction = "kill";

    // Delete from start of line up to cursor
    this.state.lines[this.state.cursorLine] = currentLine.slice(
      this.state.cursorCol,
    );
    this.setCursorCol(0);
  } else if (this.state.cursorLine > 0) {
    this.pushUndoSnapshot();

    // At start of line - merge with previous line, treating newline as deleted text
    this.killRing.push("\n", {
      prepend: true,
      accumulate: this.lastAction === "kill",
    });
    this.lastAction = "kill";

    const previousLine = this.state.lines[this.state.cursorLine - 1] || "";
    this.state.lines[this.state.cursorLine - 1] = previousLine + currentLine;
    this.state.lines.splice(this.state.cursorLine, 1);
    this.state.cursorLine--;
    this.setCursorCol(previousLine.length);
  }

  if (this.onChange) {
    this.onChange(this.getText());
  }
}

export function deleteToEndOfLine(this: Editor, ): void {
  this.exitHistoryBrowsing();

  const currentLine = this.state.lines[this.state.cursorLine] || "";

  if (this.state.cursorCol < currentLine.length) {
    this.pushUndoSnapshot();

    // Calculate text to be deleted and save to kill ring (forward deletion = append)
    const deletedText = currentLine.slice(this.state.cursorCol);
    this.killRing.push(deletedText, {
      prepend: false,
      accumulate: this.lastAction === "kill",
    });
    this.lastAction = "kill";

    // Delete from cursor to end of line
    this.state.lines[this.state.cursorLine] = currentLine.slice(
      0,
      this.state.cursorCol,
    );
  } else if (this.state.cursorLine < this.state.lines.length - 1) {
    this.pushUndoSnapshot();

    // At end of line - merge with next line, treating newline as deleted text
    this.killRing.push("\n", {
      prepend: false,
      accumulate: this.lastAction === "kill",
    });
    this.lastAction = "kill";

    const nextLine = this.state.lines[this.state.cursorLine + 1] || "";
    this.state.lines[this.state.cursorLine] = currentLine + nextLine;
    this.state.lines.splice(this.state.cursorLine + 1, 1);
  }

  if (this.onChange) {
    this.onChange(this.getText());
  }
}

export function deleteWordBackwards(this: Editor, ): void {
  this.exitHistoryBrowsing();

  const currentLine = this.state.lines[this.state.cursorLine] || "";

  // If at start of line, behave like backspace at column 0 (merge with previous line)
  if (this.state.cursorCol === 0) {
    if (this.state.cursorLine > 0) {
      this.pushUndoSnapshot();

      // Treat newline as deleted text (backward deletion = prepend)
      this.killRing.push("\n", {
        prepend: true,
        accumulate: this.lastAction === "kill",
      });
      this.lastAction = "kill";

      const previousLine = this.state.lines[this.state.cursorLine - 1] || "";
      this.state.lines[this.state.cursorLine - 1] =
        previousLine + currentLine;
      this.state.lines.splice(this.state.cursorLine, 1);
      this.state.cursorLine--;
      this.setCursorCol(previousLine.length);
    }
  } else {
    this.pushUndoSnapshot();

    // Save lastAction before cursor movement (moveWordBackwards resets it)
    const wasKill = this.lastAction === "kill";

    const oldCursorCol = this.state.cursorCol;
    this.moveWordBackwards();
    const deleteFrom = this.state.cursorCol;
    this.setCursorCol(oldCursorCol);

    const deletedText = currentLine.slice(deleteFrom, this.state.cursorCol);
    this.killRing.push(deletedText, { prepend: true, accumulate: wasKill });
    this.lastAction = "kill";

    this.state.lines[this.state.cursorLine] =
      currentLine.slice(0, deleteFrom) +
      currentLine.slice(this.state.cursorCol);
    this.setCursorCol(deleteFrom);
  }

  if (this.onChange) {
    this.onChange(this.getText());
  }
}

export function deleteWordForward(this: Editor, ): void {
  this.exitHistoryBrowsing();

  const currentLine = this.state.lines[this.state.cursorLine] || "";

  // If at end of line, merge with next line (delete the newline)
  if (this.state.cursorCol >= currentLine.length) {
    if (this.state.cursorLine < this.state.lines.length - 1) {
      this.pushUndoSnapshot();

      // Treat newline as deleted text (forward deletion = append)
      this.killRing.push("\n", {
        prepend: false,
        accumulate: this.lastAction === "kill",
      });
      this.lastAction = "kill";

      const nextLine = this.state.lines[this.state.cursorLine + 1] || "";
      this.state.lines[this.state.cursorLine] = currentLine + nextLine;
      this.state.lines.splice(this.state.cursorLine + 1, 1);
    }
  } else {
    this.pushUndoSnapshot();

    // Save lastAction before cursor movement (moveWordForwards resets it)
    const wasKill = this.lastAction === "kill";

    const oldCursorCol = this.state.cursorCol;
    this.moveWordForwards();
    const deleteTo = this.state.cursorCol;
    this.setCursorCol(oldCursorCol);

    const deletedText = currentLine.slice(this.state.cursorCol, deleteTo);
    this.killRing.push(deletedText, { prepend: false, accumulate: wasKill });
    this.lastAction = "kill";

    this.state.lines[this.state.cursorLine] =
      currentLine.slice(0, this.state.cursorCol) +
      currentLine.slice(deleteTo);
  }

  if (this.onChange) {
    this.onChange(this.getText());
  }
}

export function handleForwardDelete(this: Editor, ): void {
  this.exitHistoryBrowsing();
  this.lastAction = null;

  const currentLine = this.state.lines[this.state.cursorLine] || "";

  if (this.state.cursorCol < currentLine.length) {
    this.pushUndoSnapshot();

    // Delete grapheme at cursor position (handles emojis, combining characters, etc.)
    const afterCursor = currentLine.slice(this.state.cursorCol);

    // Find the first grapheme at cursor
    const graphemes = [...this.segment(afterCursor, "grapheme")];
    const firstGrapheme = graphemes[0];
    const graphemeLength = firstGrapheme ? firstGrapheme.segment.length : 1;

    const before = currentLine.slice(0, this.state.cursorCol);
    const after = currentLine.slice(this.state.cursorCol + graphemeLength);
    this.state.lines[this.state.cursorLine] = before + after;
  } else if (this.state.cursorLine < this.state.lines.length - 1) {
    this.pushUndoSnapshot();

    // At end of line - merge with next line
    const nextLine = this.state.lines[this.state.cursorLine + 1] || "";
    this.state.lines[this.state.cursorLine] = currentLine + nextLine;
    this.state.lines.splice(this.state.cursorLine + 1, 1);
  }

  if (this.onChange) {
    this.onChange(this.getText());
  }

  // Update or re-trigger autocomplete after forward delete
  if (this.autocompleteState) {
    this.updateAutocomplete();
  } else {
    const currentLine = this.state.lines[this.state.cursorLine] || "";
    const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
    // Slash command context
    if (this.isInSlashCommandContext(textBeforeCursor)) {
      this.tryTriggerAutocomplete();
    }
    // Symbol-based completion context like @, #, or provider triggers
    else if (this.autocompleteTriggerPattern.test(textBeforeCursor)) {
      this.tryTriggerAutocomplete();
    }
  }
}


import { getGraphemeSegmenter, getWordSegmenter } from "../../utils.ts";
import type { Editor } from "./component.ts";
import { segmentWithMarkers } from "./word-wrap.ts";

const graphemeSegmenter = getGraphemeSegmenter();
const wordSegmenter = getWordSegmenter();

export function validPasteIds(this: Editor): Set<number> {
  return new Set(this.pastes.keys());
}

export function segment(
  this: Editor,
  text: string,
  mode: "word" | "grapheme",
): Iterable<Intl.SegmentData> {
  return segmentWithMarkers(
    text,
    mode === "word" ? wordSegmenter : graphemeSegmenter,
    this.validPasteIds(),
  );
}

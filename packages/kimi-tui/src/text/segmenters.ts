const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

export function getGraphemeSegmenter(): Intl.Segmenter {
  return graphemeSegmenter;
}

export function getWordSegmenter(): Intl.Segmenter {
  return wordSegmenter;
}

export { graphemeSegmenter };

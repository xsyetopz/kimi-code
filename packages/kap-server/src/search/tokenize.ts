/**
 * `search` module — tokenizers shared by the index route and the live route.
 *
 * `tokenize` is the terms-mode tokenizer (lowercased ASCII/number words + CJK
 * unigrams & bigrams, no dictionary): the SQLite FTS5 'terms' index stores
 * pre-tokenized text with this exact function, the query side tokenizes with
 * it too, and the live route's in-memory AND match uses it — so all three
 * agree by construction.
 *
 * `normalizeLiteral` is the literal-mode normalization (NFKC + lowercase):
 * the trigram FTS index stores pre-normalized text and the confirmation pass
 * in `matchDocs` compares with this exact function, so index and comparison
 * agree by construction.
 */

const LATIN = /[a-z0-9]+/g;
// Same ranges as the retired minidb default tokenizer: CJK ideographs
// (㐀-鿿), hiragana/katakana (぀-ヿ),
// fullwidth forms (＀-￯).
const CJK = /[㐀-鿿぀-ヿ＀-￯]+/g;

/** Tokenize text into terms (lowercased latin words + CJK uni/bigrams). */
export function tokenize(str: unknown): string[] {
  const s = String(str).toLowerCase();
  const terms: string[] = [];
  const latin = s.match(LATIN);
  if (latin) for (const t of latin) terms.push(t);
  const runs = s.match(CJK) ?? [];
  for (const r of runs) {
    for (let i = 0; i < r.length; i++) {
      terms.push(r[i]!);
      if (i + 1 < r.length) terms.push(r[i]! + r[i + 1]!);
    }
  }
  return terms;
}

/** Normalize text for literal matching: Unicode NFKC + lowercase. */
export function normalizeLiteral(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

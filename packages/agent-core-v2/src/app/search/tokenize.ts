/**
 * `search` domain — tokenizers shared by the SQLite index and query path.
 */

const LATIN = /[a-z0-9]+/g;
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
  return text.normalize("NFKC").toLowerCase();
}

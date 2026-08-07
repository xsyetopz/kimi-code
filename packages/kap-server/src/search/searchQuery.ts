import { createHash } from 'node:crypto';

import { createDecorator } from '@moonshot-ai/agent-core-v2';
import type { SessionSummary } from '@moonshot-ai/agent-core-v2';
import { normalizeLiteral, tokenize } from '@moonshot-ai/minidb';
import type { TranscriptStore } from '@moonshot-ai/transcript';

import type {
  GlobalSearchHit,
  GlobalSearchIndexState,
  GlobalSearchIncomplete,
  GlobalSearchPage,
  GlobalSearchQuery,
  GlobalSearchSource,
} from './contract';
import { makeSnippet } from './snippet';
import { DEADLINE_CHECK_STRIDE } from './searchDocs';
import type { MessageDoc, SearchDoc, TitleDoc } from './searchDocs';

export type GlobalSearchErrorReason =
  | 'invalid_query'
  | 'invalid_page_token'
  | 'readonly_index'
  | 'index_unavailable';

export class GlobalSearchError extends Error {
  constructor(
    readonly reason: GlobalSearchErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'GlobalSearchError';
  }
}

export interface IGlobalSearchService {
  readonly _serviceBrand: undefined;
  search(query: GlobalSearchQuery): Promise<GlobalSearchPage>;
  /** Full rebuild: wipe the index and rescan every wire file. */
  reindex(): Promise<{ sessions: number; documents: number }>;
  status(): Promise<{
    sessions: number;
    documents: number;
    lastIndexedAt: number | null;
    /** Identity of the published base; bumps invalidate v2 page tokens. */
    generation: number;
    /** Last background refresh/sync/reindex failure, if serving stale. */
    degraded?: string;
  }>;
  /**
   * Wire the live-transcript source for the in-memory search route. Called
   * once from the composition root (start.ts) after `TranscriptService` is
   * constructed; until then every search takes the index route.
   */
  setLiveTranscriptSource(source: LiveTranscriptSource): void;
}

export const IGlobalSearchService = createDecorator<IGlobalSearchService>('globalSearch');

/**
 * Live-transcript access behind the in-memory (live) search route.
 * Implemented by `TranscriptService` (`src/services/transcript/`); declared
 * here with only the three methods the route needs, so the search module
 * does not import the transcript service's dependency stack.
 */
export interface LiveTranscriptSource {
  /** Transcript store of a session live in this process; undefined when not in memory. */
  forSessionLive(sessionId: string): TranscriptStore | undefined;
  /** Resolves when the session's initial history backfill has landed. */
  whenReady(sessionId: string): Promise<void>;
  /** Replay one agent's persisted history into the live store (idempotent per agent). */
  ensureAgentHistory(sessionId: string, agentId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Query normalization & page tokens
// ---------------------------------------------------------------------------

export interface NormalizedQuery {
  readonly query: string;
  readonly mode: 'terms' | 'literal';
  /**
   * Literal mode only: `normalizeLiteral(query)`, computed once here and
   * reused by candidate confirmation and the snippet anchor. The n-gram
   * index's query tokenizer applies the same normalization to the query
   * terms, so index and comparison agree by construction.
   */
  readonly literalQuery?: string;
  /**
   * Terms mode only: the query's deduplicated terms under minidb's default
   * `tokenize` (the same tokenizer the 'body' text index applies to both
   * sides). Computed once here so the live route's in-memory AND match agrees
   * with the index route by construction. Empty when the query tokenizes to
   * nothing (e.g. punctuation only) — both routes then match zero docs,
   * mirroring `TextIndex.search`.
   */
  readonly termsQuery?: readonly string[];
  readonly op: 'AND' | 'OR';
  readonly container?: { readonly sessionId?: string; readonly agentId?: string };
  readonly role?: 'user' | 'assistant' | 'title';
  readonly startTime?: number;
  readonly endTime?: number;
  readonly sort: 'score' | 'time_desc' | 'time_asc';
  readonly pageSize: number;
}

export function normalizeQuery(input: GlobalSearchQuery, maxQueryTerms: number): NormalizedQuery {
  const mode = input.mode ?? 'terms';
  // Literal matching is byte-exact (mod NFKC/case) — whitespace is part of
  // the query, so it is never trimmed.
  const query = mode === 'literal' ? input.query : input.query.trim();
  if (query.length === 0) {
    throw new GlobalSearchError('invalid_query', 'query must be a non-empty string');
  }
  const literalQuery = mode === 'literal' ? normalizeLiteral(query) : undefined;
  // NOTE: the <2-code-point gate for literal queries lives in the INDEX route
  // (`searchIndex`) — it is a constraint of the n-gram candidate index, not of
  // literal matching itself. The live route (pure in-memory scan) accepts any
  // non-empty literal query, down to a single code point.
  const termsQuery = mode === 'terms' ? [...new Set(tokenize(query))] : undefined;
  if (termsQuery !== undefined && termsQuery.length > maxQueryTerms) {
    throw new GlobalSearchError(
      'invalid_query',
      `query has too many terms (${termsQuery.length} > ${maxQueryTerms}); narrow it down`,
    );
  }
  const pageSize = input.pageSize ?? 20;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    throw new GlobalSearchError('invalid_query', 'pageSize must be an integer between 1 and 50');
  }
  return {
    query,
    mode,
    literalQuery,
    termsQuery,
    op: input.op ?? 'AND',
    container: input.container,
    role: input.role,
    startTime: input.startTime,
    endTime: input.endTime,
    sort: input.sort ?? 'score',
    pageSize,
  };
}

/**
 * The page token encodes a fingerprint of the query conditions — changing
 * conditions mid-pagination invalidates the token (same rule as Lark's
 * search API). The serving route (`source`) is part of the fingerprint: a
 * route flip mid-pagination (e.g. the container session closed and the live
 * route fell away) invalidates the token too, so the client restarts the
 * search instead of silently switching result sets.
 */
function tokenFingerprint(q: NormalizedQuery, source: GlobalSearchSource): string {
  const basis = JSON.stringify([
    q.query,
    q.mode,
    q.op,
    q.container?.sessionId,
    q.container?.agentId,
    q.role,
    q.startTime,
    q.endTime,
    q.sort,
    source,
  ]);
  return createHash('sha256').update(basis).digest('base64url').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Page tokens v2 — keyset cursor + generation, legacy v1 offset compat
// ---------------------------------------------------------------------------

const PAGE_TOKEN_VERSION = 2;

/**
 * Sort boundary of the last returned hit — the keyset cursor:
 *   - literal mode / `time_desc` / `time_asc`: `[time, key]`;
 *   - `score` (terms mode): `[score, time, key]`.
 * The key is the doc's stable identity: the minidb key on the index route, a
 * synthetic per-frame key on the live route.
 */
type SortBoundary = readonly (number | string)[];

export type DecodedPage =
  | { readonly kind: 'first' }
  | { readonly kind: 'keyset'; readonly boundary: SortBoundary }
  /** Legacy v1 offset token, accepted during the transition window. */
  | { readonly kind: 'legacy'; readonly skip: number };

/** Boundary tuple width for the query's effective sort order. */
function boundaryWidth(q: NormalizedQuery): 2 | 3 {
  return q.mode !== 'literal' && q.sort === 'score' ? 3 : 2;
}

export function encodePageToken(
  q: NormalizedQuery,
  source: GlobalSearchSource,
  boundary: SortBoundary,
  generation: number | undefined,
): string {
  return Buffer.from(
    JSON.stringify({ v: PAGE_TOKEN_VERSION, f: tokenFingerprint(q, source), g: generation, b: boundary }),
  ).toString('base64url');
}

export function decodePageToken(
  q: NormalizedQuery,
  source: GlobalSearchSource,
  token: string | undefined,
  generation: number | undefined,
): DecodedPage {
  if (token === undefined) return { kind: 'first' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw new GlobalSearchError('invalid_page_token', 'pageToken is malformed');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GlobalSearchError('invalid_page_token', 'pageToken is malformed');
  }
  const p = parsed as { v?: unknown; f?: unknown; s?: unknown; g?: unknown; b?: unknown };
  if (p.f !== tokenFingerprint(q, source)) {
    throw new GlobalSearchError(
      'invalid_page_token',
      'pageToken does not match the query conditions; query conditions must not change mid-pagination',
    );
  }
  if (p.v === undefined) {
    // Legacy v1 offset token (`{f, s}`) — transition window: answer it with
    // offset semantics; the response issues a v2 keyset token back.
    if (typeof p.s !== 'number' || !Number.isInteger(p.s) || p.s < 0) {
      throw new GlobalSearchError('invalid_page_token', 'pageToken is malformed');
    }
    return { kind: 'legacy', skip: p.s };
  }
  if (p.v !== PAGE_TOKEN_VERSION) {
    throw new GlobalSearchError('invalid_page_token', 'pageToken has an unsupported version');
  }
  if (generation !== undefined && p.g !== generation) {
    throw new GlobalSearchError(
      'invalid_page_token',
      'pageToken was issued by an older index generation (the index was rebuilt, reopened or rescanned); restart the search',
    );
  }
  const width = boundaryWidth(q);
  if (
    !Array.isArray(p.b) ||
    p.b.length !== width ||
    typeof p.b[0] !== 'number' ||
    typeof p.b[width - 1] !== 'string' ||
    (width === 3 && typeof p.b[1] !== 'number')
  ) {
    throw new GlobalSearchError('invalid_page_token', 'pageToken is malformed');
  }
  return { kind: 'keyset', boundary: p.b as SortBoundary };
}

// ---------------------------------------------------------------------------
// Sort order, boundary filtering and bounded collection (both routes)
// ---------------------------------------------------------------------------

/** One matched document with its stable key and match context. */
export interface MatchedRow {
  readonly key: string;
  readonly value: MessageDoc | TitleDoc;
  readonly score: number;
  /** Literal mode: offset of the confirmed match, reused as snippet anchor. */
  readonly anchor?: number;
}

/** Per-query work budget for the match/confirm phase (both routes). */
export interface MatchBudget {
  /** Date.now() timestamp after which matching stops with 'deadline'. */
  readonly deadlineAt: number;
  /** Remaining document text (UTF-16 code units) literal confirmation may
   *  process before stopping with 'deadline'. */
  textCharsLeft: number;
}

function cmpKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The query's total order (negative = `a` ranks before `b`):
 *   - literal mode (sort is a terms-mode concept) and `time_desc`:
 *     (time desc, key asc);
 *   - `time_asc`: (time asc, key asc);
 *   - `score`: (score desc, time desc, key asc).
 */
function compareRows(q: NormalizedQuery, a: MatchedRow, b: MatchedRow): number {
  if (q.mode !== 'literal' && q.sort === 'score') {
    return b.score - a.score || b.value.time - a.value.time || cmpKey(a.key, b.key);
  }
  if (q.mode !== 'literal' && q.sort === 'time_asc') {
    return a.value.time - b.value.time || cmpKey(a.key, b.key);
  }
  return b.value.time - a.value.time || cmpKey(a.key, b.key);
}

/** The boundary tuple of a row — the keyset cursor payload. */
function boundaryOf(q: NormalizedQuery, row: MatchedRow): SortBoundary {
  return boundaryWidth(q) === 3 ? [row.score, row.value.time, row.key] : [row.value.time, row.key];
}

/** Whether the row ranks strictly AFTER the boundary in the sort order. */
function rowAfterBoundary(q: NormalizedQuery, row: MatchedRow, boundary: SortBoundary): boolean {
  let cmp: number;
  if (boundary.length === 3) {
    const [bs, bt, bk] = boundary as readonly [number, number, string];
    cmp = bs - row.score || bt - row.value.time || cmpKey(row.key, bk);
  } else {
    const [bt, bk] = boundary as readonly [number, string];
    cmp =
      q.mode !== 'literal' && q.sort === 'time_asc'
        ? row.value.time - bt || cmpKey(row.key, bk)
        : bt - row.value.time || cmpKey(row.key, bk);
  }
  return cmp > 0;
}

/**
 * Bounded collector for the K best rows in the query's sort order — same
 * worst-at-root heap shape as minidb's TopK: O(log K) per row and K rows in
 * memory instead of an O(E log E) sort over every eligible row. Deep pages
 * stay proportional to pageSize.
 */
class RowTopK {
  private readonly a: MatchedRow[] = [];

  constructor(
    private readonly q: NormalizedQuery,
    private readonly k: number,
  ) {}

  private worse(x: MatchedRow, y: MatchedRow): boolean {
    return compareRows(this.q, x, y) > 0; // x ranks after y
  }

  offer(row: MatchedRow): void {
    const a = this.a;
    if (a.length < this.k) {
      a.push(row);
      let i = a.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (!this.worse(a[i]!, a[p]!)) break;
        [a[p], a[i]] = [a[i]!, a[p]!];
        i = p;
      }
      return;
    }
    if (this.k === 0 || !this.worse(a[0]!, row)) return; // must beat the worst kept
    a[0] = row;
    let i = 0;
    for (;;) {
      let w = i;
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      if (l < a.length && this.worse(a[l]!, a[w]!)) w = l;
      if (r < a.length && this.worse(a[r]!, a[w]!)) w = r;
      if (w === i) break;
      [a[w], a[i]] = [a[i]!, a[w]!];
      i = w;
    }
  }

  /** The kept rows in final rank order. */
  sorted(): MatchedRow[] {
    return this.a.sort((x, y) => compareRows(this.q, x, y));
  }
}
// ---------------------------------------------------------------------------
// live-route terms matching
// ---------------------------------------------------------------------------

/**
 * Terms-mode matching for the live route. Both query (already tokenized and
 * deduplicated in `normalizeQuery`) and documents are split with minidb's
 * default `tokenize` — the same tokenizer the index route's 'body' text index
 * uses — so a document matches when EVERY query term appears in its term set
 * (AND). The score is Σ log(1 + tf) per query term: it is only comparable
 * within the live route, since there is no corpus-wide IDF in memory (the
 * `GlobalSearchSource` contract comment says the same). The shared `toPage`
 * applies the final (score, time, key) order over the returned rows.
 */
export function matchLiveTerms(
  terms: readonly string[],
  docs: readonly { key: string; value: MessageDoc | TitleDoc }[],
): { key: string; value: MessageDoc | TitleDoc; score: number }[] {
  // A query that tokenizes to nothing matches zero docs, same as the index.
  if (terms.length === 0) return [];
  const matched: { key: string; value: MessageDoc | TitleDoc; score: number }[] = [];
  for (const { key, value: doc } of docs) {
    const counts = new Map<string, number>();
    for (const token of tokenize(doc.text)) counts.set(token, (counts.get(token) ?? 0) + 1);
    let score = 0;
    let hit = true;
    for (const term of terms) {
      const tf = counts.get(term) ?? 0;
      if (tf === 0) {
        hit = false;
        break;
      }
      score += Math.log(1 + tf);
    }
    if (hit) matched.push({ key, value: doc, score });
  }
  return matched;
}

export function matchDocs(
  q: NormalizedQuery,
  docs: Iterable<{ key: string; value: SearchDoc | undefined; score: number }>,
  boundary: SortBoundary | undefined,
  budget: MatchBudget,
): { rows: MatchedRow[]; incomplete?: GlobalSearchIncomplete } {
  const literalQuery = q.literalQuery;
  const rows: MatchedRow[] = [];
  let i = 0;
  for (const { key, value: doc, score } of docs) {
    if ((i++ & (DEADLINE_CHECK_STRIDE - 1)) === 0 && Date.now() > budget.deadlineAt) {
      return { rows, incomplete: 'deadline' };
    }
    if (doc === undefined || (doc.kind !== 'message' && doc.kind !== 'title')) continue;
    if (q.container?.sessionId !== undefined && doc.sessionId !== q.container.sessionId) continue;
    if (q.container?.agentId !== undefined && doc.agentId !== q.container.agentId) continue;
    if (q.role !== undefined && doc.role !== q.role) continue;
    if (q.startTime !== undefined && doc.time < q.startTime) continue;
    if (q.endTime !== undefined && doc.time > q.endTime) continue;
    if (boundary !== undefined && !rowAfterBoundary(q, { key, value: doc, score }, boundary)) {
      continue;
    }
    if (literalQuery !== undefined) {
      budget.textCharsLeft -= doc.text.length;
      if (budget.textCharsLeft < 0) return { rows, incomplete: 'deadline' };
      const at = normalizeLiteral(doc.text).indexOf(literalQuery);
      if (at === -1) continue;
      rows.push({ key, value: doc, score: 0, anchor: at });
    } else {
      rows.push({ key, value: doc, score });
    }
  }
  return { rows };
}

export function toSearchPage(
  summaries: Map<string, SessionSummary>,
  q: NormalizedQuery,
  source: GlobalSearchSource,
  page: DecodedPage,
  rows: MatchedRow[],
  incomplete: GlobalSearchIncomplete | undefined,
  indexState: GlobalSearchIndexState,
  generation?: number,
): GlobalSearchPage {
  const literalQuery = q.literalQuery;
  let pageRows: MatchedRow[];
  let hasMore: boolean;
  if (page.kind === 'legacy') {
    rows.sort((a, b) => compareRows(q, a, b));
    const slice = rows.slice(page.skip, page.skip + q.pageSize + 1);
    hasMore = slice.length > q.pageSize;
    pageRows = slice.slice(0, q.pageSize);
  } else {
    const top = new RowTopK(q, q.pageSize + 1);
    for (const row of rows) top.offer(row);
    const slice = top.sorted();
    hasMore = slice.length > q.pageSize;
    pageRows = slice.slice(0, q.pageSize);
  }
  const items: GlobalSearchHit[] = pageRows.map((row) => {
    const doc = row.value;
    return {
      sessionId: doc.sessionId,
      workspaceId: doc.workspaceId,
      sessionTitle: summaries.get(doc.sessionId)?.title ?? doc.sessionTitle,
      agentId: doc.agentId,
      role: doc.role,
      snippet:
        doc.kind === 'title'
          ? doc.text
          : row.anchor !== undefined && literalQuery !== undefined
            ? makeSnippet(doc.text, q.query, 80, { at: row.anchor, len: literalQuery.length })
            : makeSnippet(doc.text, q.query),
      time: doc.time,
      turn: doc.kind === 'message' ? doc.turn : undefined,
      stepId: doc.kind === 'message' ? doc.stepId : undefined,
      score: row.score,
    };
  });

  return {
    items,
    hasMore,
    pageToken: hasMore
      ? encodePageToken(q, source, boundaryOf(q, pageRows[pageRows.length - 1]!), generation)
      : undefined,
    incomplete,
    indexState,
    source,
  };
}

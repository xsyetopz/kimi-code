/**
 * `search` module — SQLite (bun:sqlite) storage backend for the global search
 * index, replacing the retired minidb store.
 *
 * One database file at `<homeDir>/search-index/index.sqlite` (WAL mode):
 *   - `kv(key TEXT PRIMARY KEY, value TEXT)` — every stored document exactly
 *     like the minidb KV layer with `valueCodec: 'json'`: message/title docs
 *     under `<sessionId>/...`, file/session metas and stats under
 *     `\0meta\...`. Prefix scans serve the same queries minidb's
 *     `query({key:{prefix}})` did.
 *   - `terms_fts` — FTS5 (unicode61) over the docs' PRE-TOKENIZED text
 *     (`tokenize` from `./tokenize`, space-joined): the same tokenizer runs
 *     on the query side, so terms-mode recall matches the old 'body' index.
 *     Scores are `-bm25(terms_fts)` (higher = better; bm25 returns lower =
 *     better). Ranking differs from minidb's Σ log(1+tf)·idf — accepted drift.
 *   - `tri_fts` — FTS5 trigram over the NFKC+lowercased text
 *     (`normalizeLiteral`), the candidate producer for literal mode at ≥3
 *     normalized code points.
 *   - `docs_norm(key, norm)` — the normalized text of every doc, backing the
 *     2-code-point literal fallback (trigram cannot express 2-char queries)
 *     as a bounded `instr` scan. Confirmation in `matchDocs` still guarantees
 *     zero false positives on every path.
 *
 * Multi-process: plain SQLite WAL semantics replace minidb's exclusive lock +
 * `catchUpFromWal`. The first process opens read-write (the indexer); later
 * processes open with `readonly: true` and see every committed write on their
 * next query — there is no WAL watermark to replay, only a cheap file
 * fingerprint (db + wal ino/mtime/size) telling the service the on-disk state
 * changed so it can flag `index_state.stale` on the served page.
 *
 * Bounded queries: minidb's postings-visit budget has no FTS5 equivalent.
 * `searchTerms`/`searchLiteral` enforce the candidate `LIMIT` (+1 probe from
 * the caller) and report `truncated` when the probe comes back full, which the
 * service maps to `incomplete: 'candidate_cap'`. The wall-clock deadline and
 * the literal-confirmation text budget stay in the service's `matchDocs`; the
 * `incomplete: 'postings_budget'` signal is no longer producible (the
 * contract enum keeps the value).
 *
 * Sync surface: bun:sqlite is synchronous. Methods return plain values; the
 * service keeps its async signatures.
 */

import { Database } from 'bun:sqlite';
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { normalizeLiteral, tokenize } from './tokenize';

export const DB_FILENAME = 'index.sqlite';
const LOCK_FILENAME = `${DB_FILENAME}.lock`;

interface IndexableDoc {
  readonly kind?: string;
  readonly text?: string;
}

export interface SearchHit<T> {
  readonly key: string;
  readonly value: T;
  readonly score: number;
}

function isDocKey(key: string): boolean {
  return !key.startsWith('\0');
}

function escapeMatch(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

/**
 * Dispose-drain gate for lifecycle-managed background ops (the enter/leave/
 * close slice of the retired minidb `OpTracker`): every background op enters
 * the gate; dispose closes it (new ops skip) and drains the in-flight ones
 * before the db handle is closed, so no task ever touches a closed handle.
 */
export class OpTracker {
  private count = 0;
  private open = true;
  private idleWaiters: (() => void)[] = [];
  private closePromise: Promise<void> | null = null;

  enter(): boolean {
    if (!this.open) return false;
    this.count++;
    return true;
  }

  leave(): void {
    this.count--;
    if (this.count === 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  private whenIdle(): Promise<void> {
    if (this.count === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.open = false;
      this.closePromise = this.whenIdle();
    }
    return this.closePromise;
  }
}

export class SearchIndexDb<T> {
  private constructor(
    private readonly db: Database,
    readonly readOnly: boolean,
    private readonly lockPath: string | null,
  ) {}

  /**
   * Open the index database under `dir`. With `readonly: false` the caller
   * competes for the writer role via an advisory lock file (O_EXCL create +
   * PID, reclaimed when the holder is dead) — the winner opens read-write
   * (and creates the schema), losers fall back to read-only, the same
   * election minidb's exclusive lock provided. A read-only open of a
   * not-yet-created database throws — the caller treats it as "no generation
   * published yet".
   */
  static open<T>(dir: string, opts: { readonly: boolean }): SearchIndexDb<T> {
    const path = join(dir, DB_FILENAME);
    if (opts.readonly) {
      const db = new Database(path, { readonly: true });
      db.run('PRAGMA busy_timeout = 5000');
      return new SearchIndexDb<T>(db, true, null);
    }
    mkdirSync(dir, { recursive: true });
    const lockPath = join(dir, LOCK_FILENAME);
    if (!tryAcquireLock(lockPath)) {
      const db = new Database(path, { readonly: true });
      db.run('PRAGMA busy_timeout = 5000');
      return new SearchIndexDb<T>(db, true, null);
    }
    try {
      const db = new Database(path);
      db.run('PRAGMA journal_mode = WAL');
      db.run('PRAGMA synchronous = NORMAL');
      db.run('PRAGMA busy_timeout = 5000');
      db.run(`CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`);
      db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS terms_fts USING fts5(
        key UNINDEXED,
        terms,
        tokenize = 'unicode61'
      )`);
      db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS tri_fts USING fts5(
        key UNINDEXED,
        norm,
        tokenize = 'trigram'
      )`);
      db.run(`CREATE TABLE IF NOT EXISTS docs_norm (
        key TEXT PRIMARY KEY,
        norm TEXT NOT NULL
      )`);
      return new SearchIndexDb<T>(db, false, lockPath);
    } catch (error) {
      releaseLock(lockPath);
      throw error;
    }
  }

  close(): void {
    this.db.close();
    if (this.lockPath !== null) releaseLock(this.lockPath);
  }

  get(key: string): T | undefined {
    const row = this.db.query('SELECT value FROM kv WHERE key = ?').get(key) as
      | { value: string }
      | null;
    return row === null ? undefined : (JSON.parse(row.value) as T);
  }

  set(key: string, value: T): void {
    this.batch([{ op: 'set', key, value }]);
  }

  del(key: string): void {
    this.batch([{ op: 'del', key }]);
  }

  batch(ops: readonly { op: 'set' | 'del'; key: string; value?: T }[]): void {
    if (ops.length === 0) return;
    const put = this.db.prepare(
      'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    const delKv = this.db.prepare('DELETE FROM kv WHERE key = ?');
    const putTerms = this.db.prepare('INSERT INTO terms_fts (key, terms) VALUES (?, ?)');
    const delTerms = this.db.prepare('DELETE FROM terms_fts WHERE key = ?');
    const putTri = this.db.prepare('INSERT INTO tri_fts (key, norm) VALUES (?, ?)');
    const delTri = this.db.prepare('DELETE FROM tri_fts WHERE key = ?');
    const putNorm = this.db.prepare(
      'INSERT INTO docs_norm (key, norm) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET norm = excluded.norm',
    );
    const delNorm = this.db.prepare('DELETE FROM docs_norm WHERE key = ?');
    this.db.transaction(() => {
      for (const op of ops) {
        if (op.op === 'del') {
          delKv.run(op.key);
          if (isDocKey(op.key)) {
            delTerms.run(op.key);
            delTri.run(op.key);
            delNorm.run(op.key);
          }
          continue;
        }
        const value = op.value as T;
        put.run(op.key, JSON.stringify(value));
        if (!isDocKey(op.key)) continue;
        // Re-index: drop any prior FTS/norm rows, then index the text when
        // the value is an indexable doc (message/title with non-empty text).
        delTerms.run(op.key);
        delTri.run(op.key);
        delNorm.run(op.key);
        const doc = value as IndexableDoc;
        if (
          (doc.kind !== 'message' && doc.kind !== 'title') ||
          typeof doc.text !== 'string' ||
          doc.text.length === 0
        ) {
          continue;
        }
        const norm = normalizeLiteral(doc.text);
        putTerms.run(op.key, tokenize(doc.text).join(' '));
        putTri.run(op.key, norm);
        putNorm.run(op.key, norm);
      }
    })();
  }

  /** Keys (and optionally values) under a prefix, in key order. */
  queryPrefix(prefix: string, opts: { values: boolean }): { key: string; value: T }[] {
    // LIKE with ESCAPE: meta prefixes contain backslashes that must not act
    // as wildcards; escaping keeps the scan exact.
    const like = `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = this.db
      .query("SELECT key, value FROM kv WHERE key LIKE ? ESCAPE '\\' ORDER BY key")
      .all(like) as { key: string; value: string }[];
    if (!opts.values) return rows.map((row) => ({ key: row.key, value: undefined as T }));
    return rows.map((row) => ({ key: row.key, value: JSON.parse(row.value) as T }));
  }

  /**
   * SQLite FTS5 indexes are built synchronously at table creation — there is
   * no async "building" state. Always returns false so call sites that
   * previously checked minidb's `textIndexBuilding` stay correct.
   */
  textIndexBuilding(_name: string): false {
    return false;
  }

  /** Total stored keys (docs + metas), same meaning as minidb's `size`. */
  get size(): number {
    const row = this.db.query('SELECT count(*) AS n FROM kv').get() as { n: number };
    return row.n;
  }

  /**
   * Terms-mode candidate pass: MATCH over the pre-tokenized terms index.
   * `op` maps to FTS5 AND/OR of quoted terms; the caller's `limit` is applied
   * directly (the service asks for cap+1 so an over-cap set is detectable).
   * `truncated` reports a FULL page — a further candidate may exist. Scores
   * come from bm25 (negated: higher is better, matching the service's sort).
   * `maxVisits` is accepted for interface compatibility; FTS5 exposes no
   * postings-visit accounting, so it is not enforced (see file header).
   */
  searchTerms(
    queryTerms: readonly string[],
    opts: { op: 'AND' | 'OR'; limit: number; maxVisits: number },
  ): { hits: SearchHit<T>[]; visits: number; truncated: boolean } {
    if (queryTerms.length === 0) return { hits: [], visits: 0, truncated: false };
    const expr = queryTerms.map(escapeMatch).join(opts.op === 'AND' ? ' AND ' : ' OR ');
    const rows = this.db
      .query(
        `SELECT t.key AS key, k.value AS value, -bm25(terms_fts) AS score
         FROM terms_fts t JOIN kv k ON k.key = t.key
         WHERE terms_fts MATCH ?
         ORDER BY bm25(terms_fts)
         LIMIT ?`,
      )
      .all(expr, opts.limit) as { key: string; value: string; score: number }[];
    return {
      hits: rows.map((row) => ({ key: row.key, value: JSON.parse(row.value) as T, score: row.score })),
      visits: rows.length,
      truncated: rows.length >= opts.limit,
    };
  }

  /**
   * Literal-mode candidate pass: a trigram phrase MATCH for queries of ≥3
   * normalized code points, a bounded `instr` scan over `docs_norm` for
   * 2-code-point queries. Candidates are confirmed downstream, so hash-level
   * false positives are impossible on the wire.
   */
  searchLiteral(
    literalQuery: string,
    opts: { limit: number; maxVisits: number },
  ): { hits: SearchHit<T>[]; visits: number; truncated: boolean } {
    const chars = Array.from(literalQuery).length;
    const rows =
      chars >= 3
        ? (this.db
            .query(
              `SELECT t.key AS key, k.value AS value
               FROM tri_fts t JOIN kv k ON k.key = t.key
               WHERE tri_fts MATCH ?
               LIMIT ?`,
            )
            .all(escapeMatch(literalQuery), opts.limit) as { key: string; value: string }[])
        : (this.db
            .query(
              `SELECT n.key AS key, k.value AS value
               FROM docs_norm n JOIN kv k ON k.key = n.key
               WHERE instr(n.norm, ?) > 0
               LIMIT ?`,
            )
            .all(literalQuery, opts.limit) as { key: string; value: string }[]);
    return {
      hits: rows.map((row) => ({ key: row.key, value: JSON.parse(row.value) as T, score: 0 })),
      visits: rows.length,
      truncated: rows.length >= opts.limit,
    };
  }

  /**
   * Cheap on-disk freshness fingerprint (the service polls it per search on
   * read-only instances): db + WAL ino/mtime/size. A change means another
   * process committed writes; this process's next queries see them already —
   * the fingerprint only drives the `stale` flag, not any catch-up.
   */
  static async fingerprint(dir: string): Promise<string> {
    const parts: string[] = [];
    for (const name of [DB_FILENAME, `${DB_FILENAME}-wal`]) {
      try {
        const s = await stat(join(dir, name));
        parts.push(`${name}:${s.ino}:${s.mtimeMs}:${s.size}`);
      } catch {
        parts.push(`${name}:-`);
      }
    }
    return parts.join('|');
  }
}

/**
 * Writer-election lock file: O_EXCL create carrying the holder PID. A lock
 * whose holder is dead (or whose PID cannot be parsed) is stale and
 * reclaimed; `process.kill(pid, 0)` probes liveness without signalling.
 */
function tryAcquireLock(lockPath: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeFileSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false;
      let holder: number | null = null;
      try {
        holder = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
      } catch {
        holder = null;
      }
      let alive = false;
      if (holder !== null && Number.isInteger(holder) && holder > 0) {
        try {
          process.kill(holder, 0);
          alive = true;
        } catch {
          alive = false;
        }
      }
      if (alive) return false;
      // Stale lock: best-effort reclaim; a racing peer may win the unlink,
      // in which case our next create attempt decides.
      try {
        unlinkSync(lockPath);
      } catch {
        // raced or unreadable — the next create attempt settles it
      }
    }
  }
  return false;
}

function releaseLock(lockPath: string): void {
  try {
    // Only remove the lock we still own: a crashed-then-restarted peer could
    // have reclaimed the path after we lost it.
    const holder = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
    if (holder === process.pid) unlinkSync(lockPath);
  } catch {
    // already gone or unreadable
  }
}

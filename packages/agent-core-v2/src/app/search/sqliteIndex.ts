/**
 * `search` domain — SQLite (`bun:sqlite`) storage backend for the global
 * search index at `<homeDir>/search/index.sqlite`.
 */

import { Database } from "bun:sqlite";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { normalizeLiteral, tokenize } from "./tokenize";

export const DB_FILENAME = "index.sqlite";
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
  return !key.startsWith("\0");
}

function escapeMatch(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

export class SqliteSearchIndex<T> {
  private constructor(
    private readonly db: Database,
    readonly readOnly: boolean,
    private readonly lockPath: string | null,
  ) {}

  static open<T>(
    dir: string,
    opts: { readonly: boolean },
  ): SqliteSearchIndex<T> {
    const path = join(dir, DB_FILENAME);
    if (opts.readonly) {
      const db = new Database(path, { readonly: true });
      db.run("PRAGMA busy_timeout = 5000");
      return new SqliteSearchIndex<T>(db, true, null);
    }
    mkdirSync(dir, { recursive: true });
    const lockPath = join(dir, LOCK_FILENAME);
    if (!tryAcquireLock(lockPath)) {
      const db = new Database(path, { readonly: true });
      db.run("PRAGMA busy_timeout = 5000");
      return new SqliteSearchIndex<T>(db, true, null);
    }
    try {
      const db = new Database(path);
      db.run("PRAGMA journal_mode = WAL");
      db.run("PRAGMA synchronous = NORMAL");
      db.run("PRAGMA busy_timeout = 5000");
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
      return new SqliteSearchIndex<T>(db, false, lockPath);
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
    const row = this.db
      .query("SELECT value FROM kv WHERE key = ?")
      .get(key) as { value: string } | null;
    return row === null ? undefined : (JSON.parse(row.value) as T);
  }

  batch(ops: readonly { op: "set" | "del"; key: string; value?: T }[]): void {
    if (ops.length === 0) return;
    const put = this.db.prepare(
      "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    const delKv = this.db.prepare("DELETE FROM kv WHERE key = ?");
    const putTerms = this.db.prepare(
      "INSERT INTO terms_fts (key, terms) VALUES (?, ?)",
    );
    const delTerms = this.db.prepare("DELETE FROM terms_fts WHERE key = ?");
    const putTri = this.db.prepare(
      "INSERT INTO tri_fts (key, norm) VALUES (?, ?)",
    );
    const delTri = this.db.prepare("DELETE FROM tri_fts WHERE key = ?");
    const putNorm = this.db.prepare(
      "INSERT INTO docs_norm (key, norm) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET norm = excluded.norm",
    );
    const delNorm = this.db.prepare("DELETE FROM docs_norm WHERE key = ?");
    this.db.transaction(() => {
      for (const op of ops) {
        if (op.op === "del") {
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
        delTerms.run(op.key);
        delTri.run(op.key);
        delNorm.run(op.key);
        const doc = value as IndexableDoc;
        if (
          (doc.kind !== "message" && doc.kind !== "title") ||
          typeof doc.text !== "string" ||
          doc.text.length === 0
        ) {
          continue;
        }
        const norm = normalizeLiteral(doc.text);
        putTerms.run(op.key, tokenize(doc.text).join(" "));
        putTri.run(op.key, norm);
        putNorm.run(op.key, norm);
      }
    })();
  }

  queryPrefix(
    prefix: string,
    opts: { values: boolean },
  ): { key: string; value: T }[] {
    const like = `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = this.db
      .query(
        "SELECT key, value FROM kv WHERE key LIKE ? ESCAPE '\\' ORDER BY key",
      )
      .all(like) as { key: string; value: string }[];
    if (!opts.values) {
      return rows.map((row) => ({ key: row.key, value: undefined as T }));
    }
    return rows.map((row) => ({
      key: row.key,
      value: JSON.parse(row.value) as T,
    }));
  }

  get size(): number {
    const row = this.db.query("SELECT count(*) AS n FROM kv").get() as {
      n: number;
    };
    return row.n;
  }

  searchLiteral(
    literalQuery: string,
    opts: { limit: number },
  ): { hits: SearchHit<T>[]; truncated: boolean } {
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
            .all(escapeMatch(literalQuery), opts.limit) as {
            key: string;
            value: string;
          }[])
        : (this.db
            .query(
              `SELECT n.key AS key, k.value AS value
               FROM docs_norm n JOIN kv k ON k.key = n.key
               WHERE instr(n.norm, ?) > 0
               LIMIT ?`,
            )
            .all(literalQuery, opts.limit) as { key: string; value: string }[]);
    return {
      hits: rows.map((row) => ({
        key: row.key,
        value: JSON.parse(row.value) as T,
        score: 0,
      })),
      truncated: rows.length >= opts.limit,
    };
  }

  searchTerms(
    queryTerms: readonly string[],
    opts: { op: "AND" | "OR"; limit: number },
  ): { hits: SearchHit<T>[]; truncated: boolean } {
    if (queryTerms.length === 0) {
      return { hits: [], truncated: false };
    }
    const expr = queryTerms
      .map(escapeMatch)
      .join(opts.op === "AND" ? " AND " : " OR ");
    const rows = this.db
      .query(
        `SELECT t.key AS key, k.value AS value, -bm25(terms_fts) AS score
         FROM terms_fts t JOIN kv k ON k.key = t.key
         WHERE terms_fts MATCH ?
         ORDER BY bm25(terms_fts)
         LIMIT ?`,
      )
      .all(expr, opts.limit) as {
      key: string;
      value: string;
      score: number;
    }[];
    return {
      hits: rows.map((row) => ({
        key: row.key,
        value: JSON.parse(row.value) as T,
        score: row.score,
      })),
      truncated: rows.length >= opts.limit,
    };
  }

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
    return parts.join("|");
  }
}

function tryAcquireLock(lockPath: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeFileSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
      let holder: number | null = null;
      try {
        holder = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
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
      try {
        unlinkSync(lockPath);
      } catch {
        // raced or unreadable
      }
    }
  }
  return false;
}

function releaseLock(lockPath: string): void {
  try {
    const holder = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    if (holder === process.pid) unlinkSync(lockPath);
  } catch {
    // already gone or unreadable
  }
}

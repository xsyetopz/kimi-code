/**
 * Minimal in-memory stand-in for `bun:sqlite` so vitest (Node) can exercise
 * search code paths. Production runs under Bun and uses the real module.
 */

type Row = Record<string, unknown>;

export class Database {
  private readonly kv = new Map<string, string>();
  private readonly termsFts = new Map<string, string>();

  constructor(
    _path: string,
    _opts?: { readonly?: boolean },
  ) {}

  run(sql: string): void {
    if (sql.startsWith("PRAGMA")) return;
    if (sql.includes("CREATE")) return;
  }

  prepare(sql: string) {
    const self = this;
    return {
      run(...args: unknown[]) {
        self.mutate(sql, args);
      },
      get(...args: unknown[]) {
        return self.queryRows(sql, args)[0] ?? null;
      },
      all(...args: unknown[]) {
        return self.queryRows(sql, args);
      },
    };
  }

  query(sql: string) {
    const self = this;
    return {
      get(...args: unknown[]) {
        return self.queryRows(sql, args)[0] ?? null;
      },
      all(...args: unknown[]) {
        return self.queryRows(sql, args);
      },
    };
  }

  transaction<T>(fn: () => T): () => T {
    return fn;
  }

  close(): void {}

  private mutate(sql: string, args: unknown[]): void {
    if (sql.includes("INSERT INTO kv")) {
      this.kv.set(String(args[0]), String(args[1]));
      return;
    }
    if (sql.includes("DELETE FROM kv")) {
      this.kv.delete(String(args[0]));
      return;
    }
    if (sql.includes("INSERT INTO terms_fts")) {
      this.termsFts.set(String(args[0]), String(args[1]));
      return;
    }
    if (sql.includes("DELETE FROM terms_fts")) {
      this.termsFts.delete(String(args[0]));
    }
  }

  private queryRows(sql: string, args: unknown[]): Row[] {
    if (sql.includes("SELECT value FROM kv WHERE key = ?")) {
      const value = this.kv.get(String(args[0]));
      return value === undefined ? [] : [{ value }];
    }
    if (sql.includes("SELECT count(*) AS n FROM kv")) {
      return [{ n: this.kv.size }];
    }
    if (sql.includes("SELECT key, value FROM kv WHERE key LIKE")) {
      const like = String(args[0]);
      const prefix = like.replace(/\\%/g, "%").replace(/%$/, "").replace(/\\/g, "");
      const rows = [...this.kv.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => ({ key, value }));
      return rows;
    }
    if (sql.includes("terms_fts MATCH")) {
      const expr = String(args[0]);
      const terms = expr
        .split(" AND ")
        .map((part) => part.replaceAll('"', "").trim())
        .filter((part) => part.length > 0);
      const limit = Number(args[1]);
      const hits: Row[] = [];
      for (const [key, termsText] of this.termsFts) {
        const haystack = ` ${termsText} `;
        if (terms.every((term) => haystack.includes(` ${term} `))) {
          const value = this.kv.get(key);
          if (value !== undefined) hits.push({ key, value, score: 1 });
        }
      }
      return hits.slice(0, limit);
    }
    return [];
  }
}

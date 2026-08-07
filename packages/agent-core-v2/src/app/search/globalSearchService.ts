/**
 * `search` domain — `IGlobalSearchService` skeleton over `SqliteSearchIndex`.
 *
 * Opens the index at `<homeDir>/search/index.sqlite`, gates on the
 * `bun-sqlite-search` experimental flag, and incrementally projects session
 * wire.jsonl files through `wireIndexer`. Literal mode and stale/incomplete
 * index paths fall back to ripgrep over session wire dirs. Bound at App scope.
 */

import { join } from "node:path";

import {
  LifecycleScope,
  ScopeActivation,
  registerScopedService,
} from "#/_base/di/scope";
import { IBootstrapService } from "#/app/bootstrap/bootstrap";
import { IFlagService } from "#/app/flag/flag";
import {
  ISessionIndex,
  type SessionSummary,
} from "#/app/sessionIndex/sessionIndex";
import { tokenize, normalizeLiteral } from "./tokenize";

import type {
  GlobalSearchHit,
  GlobalSearchIncomplete,
  GlobalSearchPage,
  GlobalSearchQuery,
} from "./contract";
import { BUN_SQLITE_SEARCH_FLAG_ID } from "./flag";
import { GlobalSearchError, IGlobalSearchService } from "./globalSearch";
import { searchLiteralRipgrep } from "./rgLiteral";
import {
  STATS_KEY,
  LITERAL_CANDIDATE_CAP,
  MAX_LITERAL_QUERY_CHARS,
  searchIndexDir,
  type MessageDoc,
  type SearchDoc,
  type TitleDoc,
} from "./searchDocs";
import { makeSnippet } from "./snippet";
import { SqliteSearchIndex } from "./sqliteIndex";
import {
  collectWireFiles,
  syncWireFile,
  type WireIndexHost,
} from "./wireIndexer";

function emptyIndexState(
  indexedSessions: number,
  totalSessions: number,
  documents: number,
  state: "building" | "ready" | "readonly" = "building",
  extra?: { stale?: boolean; degraded?: string },
): GlobalSearchPage["indexState"] {
  return {
    state,
    indexedSessions,
    totalSessions,
    documents,
    ...extra,
  };
}

function makeTermsSnippet(text: string, query: string): string {
  const terms = tokenize(query);
  const lower = text.toLowerCase();
  for (const term of terms) {
    const at = lower.indexOf(term);
    if (at !== -1) {
      const start = Math.max(0, at - 40);
      const end = Math.min(text.length, at + term.length + 40);
      return text.slice(start, end);
    }
  }
  return text.slice(0, 80);
}

export class GlobalSearchService implements IGlobalSearchService {
  declare readonly _serviceBrand: undefined;

  private index: SqliteSearchIndex<SearchDoc> | null = null;
  private readonly indexDir: string;
  private readonly sessionsDir: string;
  private fullSyncDone = false;
  private syncReplaced = false;
  private disposed = false;
  private generation = 1;
  private cachedSessions: SessionSummary[] = [];

  constructor(
    @ISessionIndex private readonly sessionIndex: ISessionIndex,
    @IBootstrapService bootstrap: IBootstrapService,
    @IFlagService private readonly flags: IFlagService,
  ) {
    this.indexDir = searchIndexDir(bootstrap.homeDir);
    this.sessionsDir = bootstrap.sessionsDir;
  }

  private requireEnabled(): void {
    if (!this.flags.enabled(BUN_SQLITE_SEARCH_FLAG_ID)) {
      throw new GlobalSearchError(
        "index_unavailable",
        "global search is disabled; enable the bun-sqlite-search experimental flag",
      );
    }
  }

  private openIndex(): SqliteSearchIndex<SearchDoc> {
    this.requireEnabled();
    if (this.index === null) {
      this.index = SqliteSearchIndex.open<SearchDoc>(this.indexDir, {
        readonly: false,
      });
    }
    return this.index;
  }

  private host(): WireIndexHost {
    return { disposed: this.disposed, syncReplaced: this.syncReplaced };
  }

  private async syncSessions(): Promise<void> {
    const index = this.openIndex();
    const host = this.host();
    let sessions = 0;
    let documents = 0;
    const summaries: SessionSummary[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await this.sessionIndex.listRecent({
        limit: 100,
        ...(before !== undefined ? { before } : {}),
      });
      for (const summary of page.items) {
        summaries.push(summary);
        sessions++;
        const sessionDir = join(
          this.sessionsDir,
          summary.workspaceId,
          summary.id,
        );
        const files = await collectWireFiles(sessionDir);
        for (const file of files) {
          await syncWireFile(host, index, summary, file);
        }
      }
      if (page.nextCursor === undefined) break;
      before = page.nextCursor;
    }
    this.cachedSessions = summaries;
    for (const row of index.queryPrefix("", { values: true })) {
      const doc = row.value;
      if (doc?.kind === "message" || doc?.kind === "title") documents++;
    }
    index.batch([
      {
        op: "set",
        key: STATS_KEY,
        value: {
          kind: "stats",
          sessions,
          documents,
          lastIndexedAt: Date.now(),
        },
      },
    ]);
    this.syncReplaced = host.syncReplaced;
    this.fullSyncDone = true;
  }

  async search(query: GlobalSearchQuery): Promise<GlobalSearchPage> {
    this.requireEnabled();
    const mode = query.mode ?? "terms";
    const q = mode === "literal" ? query.query : query.query.trim();
    if (q.length === 0) {
      throw new GlobalSearchError(
        "invalid_query",
        "query must be a non-empty string",
      );
    }
    const pageSize = query.pageSize ?? 20;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) {
      throw new GlobalSearchError(
        "invalid_query",
        "pageSize must be an integer between 1 and 50",
      );
    }

    await this.syncSessions();
    const index = this.openIndex();
    const stats = index.get(STATS_KEY);
    const indexed = stats?.kind === "stats" ? stats.sessions : 0;
    const documents = stats?.kind === "stats" ? stats.documents : 0;
    const stale = !this.fullSyncDone || index.readOnly;
    const indexStateBase = emptyIndexState(
      indexed,
      indexed,
      documents,
      index.readOnly ? "readonly" : this.fullSyncDone ? "ready" : "building",
      stale ? { stale: true } : undefined,
    );

    if (mode === "literal") {
      return this.searchLiteral(
        { ...query, query: q, pageSize },
        index,
        indexStateBase,
      );
    }

    const terms = [...new Set(tokenize(q))];
    const { hits, truncated } = index.searchTerms(terms, {
      op: query.op ?? "AND",
      limit: pageSize + 1,
    });

    const items: GlobalSearchHit[] = [];
    for (const hit of hits.slice(0, pageSize)) {
      const doc = hit.value;
      if (doc.kind !== "message" && doc.kind !== "title") continue;
      if (!matchesFilters(doc, query)) continue;
      items.push(hitToSearchHit(doc, hit.score, q, false));
    }

    return {
      items,
      hasMore: hits.length > pageSize,
      incomplete: truncated ? "candidate_cap" : undefined,
      indexState: indexStateBase,
      source: "index",
    };
  }

  private async searchLiteral(
    query: GlobalSearchQuery,
    index: SqliteSearchIndex<SearchDoc>,
    indexState: GlobalSearchPage["indexState"],
  ): Promise<GlobalSearchPage> {
    const literalQuery = normalizeLiteral(query.query);
    const literalLength = Array.from(literalQuery).length;
    if (literalLength < 2) {
      throw new GlobalSearchError(
        "invalid_query",
        "literal queries need at least 2 characters (after Unicode normalization)",
      );
    }
    if (literalLength > MAX_LITERAL_QUERY_CHARS) {
      throw new GlobalSearchError(
        "invalid_query",
        `literal queries are limited to ${MAX_LITERAL_QUERY_CHARS} characters`,
      );
    }

    const stale = indexState.stale === true;
    let incomplete: GlobalSearchIncomplete | undefined;

    if (!stale) {
      const { hits, truncated } = index.searchLiteral(literalQuery, {
        limit: LITERAL_CANDIDATE_CAP + 1,
      });
      if (truncated) {
        incomplete = "candidate_cap";
      } else if (hits.length > 0) {
        const pageSize = query.pageSize ?? 20;
        const items: GlobalSearchHit[] = [];
        for (const hit of hits.slice(0, pageSize)) {
          const doc = hit.value;
          if (doc.kind !== "message" && doc.kind !== "title") continue;
          if (!matchesFilters(doc, query)) continue;
          const norm = normalizeLiteral(doc.text);
          const at = norm.indexOf(literalQuery);
          items.push(hitToSearchHit(doc, hit.score, query.query, true, at));
        }
        return {
          items,
          hasMore: hits.length > (query.pageSize ?? 20),
          incomplete,
          indexState,
          source: "index",
        };
      }
    }

    const rg = await searchLiteralRipgrep({
      sessionsDir: this.sessionsDir,
      query,
      literalQuery,
      sessions: this.cachedSessions,
    });

    return {
      items: rg.items,
      hasMore: rg.hasMore,
      incomplete: rg.incomplete ?? incomplete,
      indexState: emptyIndexState(
        indexState.indexedSessions,
        indexState.totalSessions,
        indexState.documents,
        indexState.state,
        {
          ...(indexState.stale === true ? { stale: true } : {}),
          ...(rg.degraded !== undefined ? { degraded: rg.degraded } : {}),
        },
      ),
      source: "ripgrep",
    };
  }

  async reindex(): Promise<{ sessions: number; documents: number }> {
    this.requireEnabled();
    this.index?.close();
    this.index = null;
    this.fullSyncDone = false;
    this.generation++;
    await this.syncSessions();
    const stats = this.openIndex().get(STATS_KEY);
    return {
      sessions: stats?.kind === "stats" ? stats.sessions : 0,
      documents: stats?.kind === "stats" ? stats.documents : 0,
    };
  }

  async status(): Promise<{
    sessions: number;
    documents: number;
    lastIndexedAt: number | null;
    generation: number;
    degraded?: string;
  }> {
    this.requireEnabled();
    const index = this.openIndex();
    const stats = index.get(STATS_KEY);
    return {
      sessions: stats?.kind === "stats" ? stats.sessions : 0,
      documents: stats?.kind === "stats" ? stats.documents : 0,
      lastIndexedAt: stats?.kind === "stats" ? stats.lastIndexedAt : null,
      generation: this.generation,
    };
  }
}

function matchesFilters(
  doc: MessageDoc | TitleDoc,
  query: GlobalSearchQuery,
): boolean {
  if (
    query.container?.sessionId !== undefined &&
    doc.sessionId !== query.container.sessionId
  ) {
    return false;
  }
  if (
    query.container?.agentId !== undefined &&
    doc.agentId !== query.container.agentId
  ) {
    return false;
  }
  if (query.role !== undefined && doc.role !== query.role) return false;
  if (query.startTime !== undefined && doc.time < query.startTime) return false;
  if (query.endTime !== undefined && doc.time > query.endTime) return false;
  return true;
}

function hitToSearchHit(
  doc: MessageDoc | TitleDoc,
  score: number,
  query: string,
  literal: boolean,
  anchorAt?: number,
): GlobalSearchHit {
  const snippet =
    literal && anchorAt !== undefined
      ? makeSnippet(doc.text, query, 80, {
          at: anchorAt,
          len: normalizeLiteral(query).length,
        })
      : literal
        ? makeSnippet(doc.text, query)
        : makeTermsSnippet(doc.text, query);
  const base = {
    sessionId: doc.sessionId,
    workspaceId: doc.workspaceId,
    sessionTitle: doc.sessionTitle,
    agentId: doc.agentId,
    role: doc.role,
    snippet,
    time: doc.time,
    score,
  };
  if (doc.kind !== "message") return base;
  return {
    ...base,
    ...(doc.turn !== undefined ? { turn: doc.turn } : {}),
    ...(doc.stepId !== undefined ? { stepId: doc.stepId } : {}),
  };
}

registerScopedService(
  LifecycleScope.App,
  IGlobalSearchService,
  GlobalSearchService,
  ScopeActivation.OnScopeCreated,
  "globalSearch",
);

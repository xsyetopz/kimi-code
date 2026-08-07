/**
 * `search` domain — `IGlobalSearchService` skeleton over `SqliteSearchIndex`.
 *
 * Opens the index at `<homeDir>/search/index.sqlite`, gates on the
 * `bun-sqlite-search` experimental flag, and incrementally projects session
 * wire.jsonl files through `wireIndexer`. Bound at App scope.
 */

import { join } from "node:path";

import { LifecycleScope, ScopeActivation, registerScopedService } from "#/_base/di/scope";
import { IBootstrapService } from "#/app/bootstrap/bootstrap";
import { IFlagService } from "#/app/flag/flag";
import { ISessionIndex } from "#/app/sessionIndex/sessionIndex";
import { tokenize } from "./tokenize";

import type { GlobalSearchHit, GlobalSearchPage, GlobalSearchQuery } from "./contract";
import { BUN_SQLITE_SEARCH_FLAG_ID } from "./flag";
import {
  GlobalSearchError,
  IGlobalSearchService,
} from "./globalSearch";
import {
  STATS_KEY,
  searchIndexDir,
  type MessageDoc,
  type SearchDoc,
  type TitleDoc,
} from "./searchDocs";
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
): GlobalSearchPage["indexState"] {
  return {
    state,
    indexedSessions,
    totalSessions,
    documents,
  };
}

function makeSnippet(text: string, query: string): string {
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

  constructor(
    @ISessionIndex private readonly sessionIndex: ISessionIndex,
    @IBootstrapService bootstrap: IBootstrapService,
    @IFlagService private readonly flags: IFlagService,
  ) {
    this.indexDir = searchIndexDir(bootstrap.homeDir);
    this.sessionsDir = bootstrap.sessionsDir;
  }

  setLiveTranscriptSource(_source: unknown): void {
    // Live route lands in a later slice.
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
    let before: string | undefined;
    for (;;) {
      const page = await this.sessionIndex.listRecent({
        limit: 100,
        ...(before !== undefined ? { before } : {}),
      });
      for (const summary of page.items) {
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
    const q = query.query.trim();
    if (q.length === 0) {
      throw new GlobalSearchError("invalid_query", "query must be a non-empty string");
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
    const mode = query.mode ?? "terms";
    const terms = mode === "terms" ? [...new Set(tokenize(q))] : [];
    const { hits } =
      mode === "terms"
        ? index.searchTerms(terms, {
            op: query.op ?? "AND",
            limit: pageSize + 1,
          })
        : { hits: [] as { key: string; value: SearchDoc; score: number }[] };

    const items: GlobalSearchHit[] = [];
    for (const hit of hits.slice(0, pageSize)) {
      const doc = hit.value;
      if (doc.kind !== "message" && doc.kind !== "title") continue;
      if (
        query.container?.sessionId !== undefined &&
        doc.sessionId !== query.container.sessionId
      ) {
        continue;
      }
      if (
        query.container?.agentId !== undefined &&
        doc.agentId !== query.container.agentId
      ) {
        continue;
      }
      if (query.role !== undefined && doc.role !== query.role) continue;
      if (query.startTime !== undefined && doc.time < query.startTime) continue;
      if (query.endTime !== undefined && doc.time > query.endTime) continue;
      items.push(hitToSearchHit(doc, hit.score, q));
    }

    const stats = index.get(STATS_KEY);
    const indexed =
      stats?.kind === "stats" ? stats.sessions : 0;
    const documents = stats?.kind === "stats" ? stats.documents : 0;

    return {
      items,
      hasMore: hits.length > pageSize,
      indexState: emptyIndexState(
        indexed,
        indexed,
        documents,
        index.readOnly
          ? "readonly"
          : this.fullSyncDone
            ? "ready"
            : "building",
      ),
      source: "index",
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
      lastIndexedAt:
        stats?.kind === "stats" ? stats.lastIndexedAt : null,
      generation: this.generation,
    };
  }
}

function hitToSearchHit(
  doc: MessageDoc | TitleDoc,
  score: number,
  query: string,
): GlobalSearchHit {
  const base = {
    sessionId: doc.sessionId,
    workspaceId: doc.workspaceId,
    sessionTitle: doc.sessionTitle,
    agentId: doc.agentId,
    role: doc.role,
    snippet: makeSnippet(doc.text, query),
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

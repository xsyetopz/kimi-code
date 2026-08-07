/**
 * `search` module — `IGlobalSearchService` implementation (temporary feature,
 * lives in kap-server until it graduates into agent-core-v2).
 *
 * Module layout:
 *   - `searchDocs` — stored document shapes and wire turn/step counters
 *   - `searchQuery` — query normalization, pagination, and matching
 *   - `searchWireIndex` — incremental wire.jsonl projection
 *   - `searchIndexLifecycle` — db open/sync coordinator
 *   - `searchService` (this file) — public service and query routes
 */

import { rm } from 'node:fs/promises';

import {
  IBootstrapService,
  ILogService,
  ISessionIndex,
  LifecycleScope,
  ScopeActivation,
  registerScopedService,
} from '@moonshot-ai/agent-core-v2';
import { MiniDb, OpTracker, TextIndexBuildingError } from '@moonshot-ai/minidb';
import type { TranscriptStore } from '@moonshot-ai/transcript';

import type { GlobalSearchIndexState, GlobalSearchIncomplete, GlobalSearchPage, GlobalSearchQuery } from './contract';
import { SearchIndexLifecycle } from './searchIndexLifecycle';
import {
  LITERAL_CANDIDATE_CAP,
  MAX_DOC_TEXT_CHARS,
  MAX_LITERAL_QUERY_CHARS,
  MAX_POSTINGS_VISITS,
  MAX_QUERY_TERMS,
  MAX_TEXT_HITS,
  QUERY_DEADLINE_MS,
  QUERY_TEXT_BUDGET_CHARS,
  STATS_KEY,
  TEXT_INDEX_NAME,
  TRI_INDEX_NAME,
  drainGlobalSearchDisposals,
  errorMessage,
  pendingDisposals,
  type MessageDoc,
  type SearchDoc,
  type TitleDoc,
} from './searchDocs';
import {
  GlobalSearchError,
  IGlobalSearchService,
  decodePageToken,
  matchDocs,
  matchLiveTerms,
  normalizeQuery,
  toSearchPage,
  type LiveTranscriptSource,
  type MatchBudget,
  type NormalizedQuery,
} from './searchQuery';

export {
  drainGlobalSearchDisposals,
  GlobalSearchError,
  IGlobalSearchService,
};
export type { LiveTranscriptSource };

export class GlobalSearchService extends SearchIndexLifecycle implements IGlobalSearchService {
  declare readonly _serviceBrand: undefined;

  syncDebounceMs = 2_000;
  literalCandidateCap = LITERAL_CANDIDATE_CAP;
  maxTextHits = MAX_TEXT_HITS;
  postingsVisitBudget = MAX_POSTINGS_VISITS;
  queryDeadlineMs = QUERY_DEADLINE_MS;
  queryTextBudgetChars = QUERY_TEXT_BUDGET_CHARS;
  maxQueryTerms = MAX_QUERY_TERMS;

  db: MiniDb<SearchDoc> | null = null;
  openPromise: Promise<void> | null = null;
  syncPromise: Promise<void> | null = null;
  refreshPromise: Promise<void> | null = null;
  lastSyncStartedAt = 0;
  fullSyncDone = false;
  walOffset = 0;
  fingerprint = '';
  summaries = new Map();
  disposed = false;
  readonly ops = new OpTracker();
  reindexing = false;
  liveSource: LiveTranscriptSource | null = null;
  generation = 0;
  syncReplaced = false;
  syncQueued = false;
  syncTimer: ReturnType<typeof setTimeout> | null = null;
  lastRefreshError: { at: number; message: string } | null = null;
  openError: string | null = null;
  fileMetaMigrated = false;

  constructor(
    readonly sessionIndex: ISessionIndex,
    readonly bootstrap: IBootstrapService,
    readonly log: ILogService,
  ) {
    super();
    this.requestSync();
  }

  setLiveTranscriptSource(source: LiveTranscriptSource): void {
    this.liveSource = source;
  }

  dispose(): void {
    this.disposed = true;
    if (this.syncTimer !== null) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    const pending = (async () => {
      await this.ops.close();
      await this.openPromise?.catch(() => {});
      const db = this.db;
      this.db = null;
      if (db) await db.close().catch(() => {});
    })();
    pendingDisposals.add(pending);
    void pending.finally(() => pendingDisposals.delete(pending));
  }

  async search(input: GlobalSearchQuery): Promise<GlobalSearchPage> {
    const q = normalizeQuery(input, this.maxQueryTerms);
    const sessionId = q.container?.sessionId;
    const liveStore = sessionId !== undefined ? this.liveSource?.forSessionLive(sessionId) : undefined;
    if (liveStore !== undefined && sessionId !== undefined) {
      return this.searchLive(q, sessionId, liveStore, input.pageToken);
    }
    return this.searchIndex(q, input.pageToken);
  }

  // -- live route (in-memory transcript scan) ------------------------------------

  private async searchLive(
    q: NormalizedQuery,
    sessionId: string,
    store: TranscriptStore,
    pageToken: string | undefined,
  ): Promise<GlobalSearchPage> {
    // The live route has no published generations — the store mutates
    // continuously — so its keyset tokens carry no `g` and no generation
    // check applies; the (time, key) cursor itself is what keeps pages
    // consistent under concurrent appends.
    const page = decodePageToken(q, 'live', pageToken, undefined);
    const source = this.liveSource;
    if (source === null) {
      // Unreachable (the router only enters with a source-wired store), but a
      // null deref here would mask a wiring bug — fail loudly instead.
      throw new GlobalSearchError('index_unavailable', 'live transcript source is not wired');
    }
    // Backfill gates: the main-agent history, then every agent in scope, so
    // the scan covers full history rather than only post-resume content.
    await source.whenReady(sessionId);
    const agentIds =
      q.container?.agentId !== undefined
        ? [q.container.agentId]
        : store.agents().map((agent) => agent.agentId);
    for (const agentId of agentIds) {
      await source.ensureAgentHistory(sessionId, agentId);
    }
    const docs = await this.collectLiveDocs(sessionId, store, agentIds);
    const budget: MatchBudget = {
      deadlineAt: Date.now() + this.queryDeadlineMs,
      textCharsLeft: this.queryTextBudgetChars,
    };
    const boundary = page.kind === 'keyset' ? page.boundary : undefined;
    // Literal mode needs no candidate index: every in-memory document is a
    // candidate and the shared confirmation pass decides. Terms mode runs the
    // in-memory AND match first, scoring each hit.
    const matched =
      q.mode === 'literal'
        ? matchDocs(
            q,
            docs.map(({ key, value }) => ({ key, value, score: 0 })),
            boundary,
            budget,
          )
        : matchDocs(q, matchLiveTerms(q.termsQuery ?? [], docs), boundary, budget);
    return toSearchPage(this.summaries, q, 'live', page, matched.rows, matched.incomplete, {
      state: 'ready',
      indexedSessions: 1,
      totalSessions: 1,
      documents: docs.length,
    });
  }

  /**
   * Flatten the live transcript store into the same document shape the index
   * route searches (`MessageDoc` / `TitleDoc`), each with a stable synthetic
   * key for keyset pagination:
   *   - one user doc per non-empty `turn.prompt` (turn ordinal + turn time);
   *   - one assistant doc per assistant-role text frame (turn ordinal +
   *     stepId); thinking / tool / notice frames are skipped;
   *   - one title doc from the session-index summary, same as the sync path.
   * Text is trimmed and empty results skipped, mirroring the index side's
   * `wireExtract` (which trims both user and assistant text).
   */
  private async collectLiveDocs(
    sessionId: string,
    store: TranscriptStore,
    agentIds: readonly string[],
  ): Promise<{ key: string; value: MessageDoc | TitleDoc }[]> {
    const summary = await this.sessionIndex.get(sessionId);
    const workspaceId = summary?.workspaceId ?? '';
    const sessionTitle = summary?.title ?? '';
    const fallbackTime = summary?.updatedAt ?? 0;
    const parseTime = (iso: string | undefined): number => {
      if (iso === undefined) return fallbackTime;
      const ms = Date.parse(iso);
      return Number.isNaN(ms) ? fallbackTime : ms;
    };
    const docs: { key: string; value: MessageDoc | TitleDoc }[] = [];
    for (const agentId of agentIds) {
      const transcript = store.getAgent(agentId);
      if (transcript === undefined) continue;
      for (const item of transcript.snapshot().items) {
        if (item.kind !== 'turn') continue;
        const turnTime = parseTime(item.startedAt);
        const prompt = item.prompt?.trim() ?? '';
        if (prompt.length > 0) {
          docs.push({
            key: `${sessionId}/${agentId}/live/u/t${item.ordinal}`,
            value: {
              kind: 'message',
              sessionId,
              workspaceId,
              sessionTitle,
              agentId,
              role: 'user',
              text: prompt.length > MAX_DOC_TEXT_CHARS ? prompt.slice(0, MAX_DOC_TEXT_CHARS) : prompt,
              time: turnTime,
              turn: item.ordinal,
              stepId: undefined,
            },
          });
        }
        for (const step of item.steps) {
          const stepTime = parseTime(step.endedAt ?? step.startedAt ?? item.startedAt);
          for (const frame of step.frames) {
            if (frame.kind !== 'text' || frame.role !== 'assistant') continue;
            const text = frame.text.trim();
            if (text.length === 0) continue;
            docs.push({
              key: `${sessionId}/${agentId}/live/a/${frame.frameId}`,
              value: {
                kind: 'message',
                sessionId,
                workspaceId,
                sessionTitle,
                agentId,
                role: 'assistant',
                text: text.length > MAX_DOC_TEXT_CHARS ? text.slice(0, MAX_DOC_TEXT_CHARS) : text,
                time: stepTime,
                turn: item.ordinal,
                stepId: step.stepId,
              },
            });
          }
        }
      }
    }
    if (sessionTitle.length > 0) {
      docs.push({
        key: `${sessionId}/$title`,
        value: {
          kind: 'title',
          sessionId,
          workspaceId,
          sessionTitle,
          agentId: '',
          role: 'title',
          text: sessionTitle,
          time: fallbackTime,
        },
      });
    }
    return docs;
  }

  // -- index route (minidb) -------------------------------------------------------

  private async searchIndex(
    q: NormalizedQuery,
    pageToken: string | undefined,
  ): Promise<GlobalSearchPage> {
    // Query validation comes before any index-state handling: an invalid
    // query must fail the same way whether or not a generation is published.
    if (q.mode === 'literal') {
      // The n-gram index cannot confirm queries shorter than 2 normalized
      // code points. Judged AFTER normalization on purpose: NFKC can change
      // the length (the ligature 'ﬀ' folds to 'ff' and becomes legal). The
      // live route has no such constraint — it never reaches this branch.
      const literalLength = Array.from(q.literalQuery ?? '').length;
      if (literalLength < 2) {
        throw new GlobalSearchError(
          'invalid_query',
          'literal queries need at least 2 characters (after Unicode normalization)',
        );
      }
      if (literalLength > MAX_LITERAL_QUERY_CHARS) {
        throw new GlobalSearchError(
          'invalid_query',
          `literal queries are limited to ${MAX_LITERAL_QUERY_CHARS} characters`,
        );
      }
    }

    // The request path serves the currently published generation and never
    // waits for an open, sync, reopen or reindex: with no published base yet
    // it answers with `building` semantics and lets the background
    // coordinator catch up.
    const db = this.db;
    if (db === null) {
      if (this.disposed) {
        throw new GlobalSearchError('index_unavailable', 'search service is disposed');
      }
      if (this.openError !== null) {
        // The last open failed (e.g. a read-only open racing a writer's
        // compaction): surface the failure, but ALSO kick a background retry
        // (runSync → ensureOpen), so search traffic self-heals the index once
        // the transient cause goes away — a successful retry clears openError.
        this.requestSync();
        throw new GlobalSearchError(
          'index_unavailable',
          `search index failed to open: ${this.openError}`,
        );
      }
      if (pageToken !== undefined) {
        // No generation to validate the token against — the client restarts
        // the search once a base is published.
        throw new GlobalSearchError(
          'invalid_page_token',
          'the search index is not ready yet; restart the search',
        );
      }
      this.requestSync(); // kicks the open + first sync if nothing is running
      return this.buildingPage(null);
    }

    let stale: boolean;
    let serveDb = db;
    if (serveDb.readOnly) {
      // Cheap freshness probe (3 stats). A changed fingerprint refreshes in
      // the BACKGROUND — this request deliberately serves the stale
      // generation instead of waiting for a catch-up or a full reopen.
      let fp: string | null = null;
      try {
        fp = await this.computeFingerprint();
      } catch (error) {
        this.lastRefreshError = { at: Date.now(), message: errorMessage(error) };
      }
      // A background refresh may have swapped (and closed) the captured
      // handle during the await. Re-pin to the currently published handle.
      // (The stage-6 async query path awaits again below, so a later swap
      // can still close it mid-query — the bounded pass retries once on the
      // fresh handle for exactly that race.)
      if (this.db === null) {
        throw new GlobalSearchError('index_unavailable', 'search service is disposed');
      }
      serveDb = this.db;
      if (serveDb.readOnly) {
        stale = fp === null || fp !== this.fingerprint || this.refreshPromise !== null;
        if (fp !== null && fp !== this.fingerprint) void this.refreshReadonly();
      } else {
        // The reopen promoted this process to writer (the old writer's lock
        // was gone): serve from it and kick the coordinator like a writer.
        this.requestSync();
        stale = this.syncPromise !== null || this.syncQueued || this.syncTimer !== null;
      }
    } else {
      // Writer: kick the coordinator (never awaited); the served generation
      // is the one published by the last completed pass.
      this.requestSync();
      stale = this.syncPromise !== null || this.syncQueued || this.syncTimer !== null;
    }
    const generation = this.generation;
    const page = decodePageToken(q, 'index', pageToken, generation);

    // The served handle's text base is still (re)building — the deferred
    // open-time build on the no-generation fallback path has not committed (or
    // finally failed). Answer with the building page instead of running a
    // pass that would raise TextIndexBuildingError; the background build
    // commits and a later search serves real hits. Tokens from an older
    // generation already failed validation above, so reaching here with a
    // building handle is always a first-page situation.
    if (serveDb.textIndexBuilding(q.mode === 'literal' ? TRI_INDEX_NAME : TEXT_INDEX_NAME)) {
      return this.buildingPage(serveDb);
    }

    // One bounded text-index pass: db.searchBoundedAsync returns at most the
    // budgeted candidates with their scores (stage 6: the async variant —
    // postings reads and disk-mode value reads run off the event loop);
    // container/role/time filters and the requested sort are applied in
    // memory. (A separate db.query({text}) for pagination would scan the
    // same postings a second time.)
    let candidates: { key: string; value: SearchDoc | undefined; score: number }[];
    let incomplete: GlobalSearchIncomplete | undefined;
    const runBounded = (db2: MiniDb<SearchDoc>): Promise<{ hits: { key: string; value: SearchDoc; score: number }[]; visits: number; truncated: boolean }> => {
      if (q.mode === 'literal') {
        // Ask for one past the cap so an over-cap candidate set is
        // detectable; the postings budget bounds the index-side work before
        // confirmation even starts.
        return db2.searchBoundedAsync(TRI_INDEX_NAME, q.query, {
          op: 'AND',
          limit: this.literalCandidateCap + 1,
          maxVisits: this.postingsVisitBudget,
        });
      }
      return db2.searchBoundedAsync(TEXT_INDEX_NAME, q.query, {
        op: q.op,
        limit: this.maxTextHits + 1,
        maxVisits: this.postingsVisitBudget,
      });
    };
    try {
      let res: { hits: { key: string; value: SearchDoc; score: number }[]; visits: number; truncated: boolean };
      try {
        res = await runBounded(serveDb);
      } catch (error) {
        // The async query path awaits: a background read-only refresh may
        // have swapped (and closed) the pinned handle mid-query. Re-pin the
        // currently published handle and retry ONCE — anything else is a
        // real failure.
        const msg = error instanceof Error ? error.message : String(error);
        const closedRace = msg.includes('postings file is closed') || msg.includes('MiniDb is closed') || msg.includes('ValueReader is not open');
        if (!closedRace || this.db === null || this.db === serveDb) throw error;
        serveDb = this.db;
        res = await runBounded(serveDb);
      }
      if (q.mode === 'literal') {
        candidates = res.hits;
        if (res.truncated) incomplete = 'postings_budget';
        if (candidates.length > this.literalCandidateCap) {
          candidates.length = this.literalCandidateCap;
          incomplete ??= 'candidate_cap';
        }
      } else {
        candidates = res.hits;
        if (res.truncated) incomplete = 'postings_budget';
        if (candidates.length > this.maxTextHits) {
          candidates.length = this.maxTextHits;
          incomplete ??= 'candidate_cap';
        }
      }
    } catch (error) {
      // The base build's state flipped between the early check and the pass
      // (or a read-only refresh swapped in a still-building handle mid-page):
      // serve the same building page the early check produces.
      if (error instanceof TextIndexBuildingError) {
        return this.buildingPage(serveDb);
      }
      // A read-only instance can open before the writer has created the text
      // index — serve an empty page instead of failing the search.
      if (error instanceof Error && error.message.includes('no such text index')) {
        return {
          items: [],
          hasMore: false,
          pageToken: undefined,
          incomplete: undefined,
          indexState: this.readIndexState(serveDb, stale),
          source: 'index',
        };
      }
      throw error;
    }

    const budget: MatchBudget = {
      deadlineAt: Date.now() + this.queryDeadlineMs,
      textCharsLeft: this.queryTextBudgetChars,
    };
    const boundary = page.kind === 'keyset' ? page.boundary : undefined;
    const matched = matchDocs(q, candidates, boundary, budget);
    incomplete ??= matched.incomplete;
    return toSearchPage(this.summaries, 
      q,
      'index',
      page,
      matched.rows,
      incomplete,
      this.readIndexState(serveDb, stale),
      generation,
    );
  }

  async reindex(): Promise<{ sessions: number; documents: number }> {
    try {
      // Block new background passes BEFORE the first await, so no sync can
      // start writing into the db this rebuild is about to swap out.
      this.reindexing = true;
      await this.ensureOpen();
      if (this.db?.readOnly === true) {
        throw new GlobalSearchError(
          'readonly_index',
          'another process holds the search-index write lock; reindex from that process',
        );
      }
      // Let the in-flight sync settle before closing the db it writes into.
      // Syncs triggered while we wait see `reindexing` and return as no-ops,
      // so one await is sufficient — no new writer of the old db can appear.
      await this.syncPromise?.catch(() => {});
      const db = this.db;
      if (db) {
        await db.close().catch(() => {});
        this.db = null;
      }
      this.openPromise = null;
      this.fullSyncDone = false;
      await rm(this.indexDir, { recursive: true, force: true });
      await this.ensureOpen();
      // The rebuild runs the authoritative sync itself — an explicit
      // maintenance operation, never ordinary in-request work.
      this.reindexing = false;
      await this.ensureSyncStarted();
      this.lastRefreshError = null;
    } catch (error) {
      this.reindexing = false;
      this.lastRefreshError = { at: Date.now(), message: errorMessage(error) };
      throw error;
    }
    const stats = this.db?.get(STATS_KEY);
    return {
      sessions: stats?.kind === 'stats' ? stats.sessions : 0,
      documents: stats?.kind === 'stats' ? stats.documents : 0,
    };
  }

  async status(): Promise<{
    sessions: number;
    documents: number;
    lastIndexedAt: number | null;
    generation: number;
    degraded?: string;
  }> {
    await this.ensureOpen();
    if (this.db?.readOnly === true) {
      // An explicit status call may wait for the refresh; searches may not.
      await this.refreshReadonly();
    } else {
      this.requestSync();
    }
    const stats = this.db?.get(STATS_KEY);
    return {
      sessions: stats?.kind === 'stats' ? stats.sessions : 0,
      documents: stats?.kind === 'stats' ? stats.documents : 0,
      lastIndexedAt: stats?.kind === 'stats' ? stats.lastIndexedAt : null,
      generation: this.generation,
      degraded: this.lastRefreshError?.message,
    };
  }

  /**
   * The page served while the index base is unavailable: the first full sync
   * has not finished (no db yet), or a deferred open-time base build is
   * still running / finally failed on the served handle. Same "never wait"
   * rule as every other request path — the background coordinator/build
   * catches up and a later search serves real hits.
   */
  private buildingPage(db: MiniDb<SearchDoc> | null): GlobalSearchPage {
    const stats = db?.get(STATS_KEY);
    const indexed = stats?.kind === 'stats' ? stats.sessions : 0;
    return {
      items: [],
      hasMore: false,
      pageToken: undefined,
      incomplete: undefined,
      indexState: {
        state: 'building',
        indexedSessions: indexed,
        totalSessions: db === null ? this.summaries.size : db.readOnly ? indexed : Math.max(indexed, this.summaries.size),
        documents: stats?.kind === 'stats' ? stats.documents : 0,
        stale: true,
        degraded: this.lastRefreshError?.message,
      },
      source: 'index',
    };
  }

  private readIndexState(db: MiniDb<SearchDoc>, stale: boolean): GlobalSearchIndexState {
    const stats = db.get(STATS_KEY);
    const indexed = stats?.kind === 'stats' ? stats.sessions : 0;
    const documents = stats?.kind === 'stats' ? stats.documents : 0;
    // A deferred open-time base build (no-generation fallback path) puts the
    // served handle's text indexes into the building state — surface it as
    // the same 'building' the first-sync window uses, whatever the process role.
    const building = db.textIndexBuilding(TEXT_INDEX_NAME) || db.textIndexBuilding(TRI_INDEX_NAME);
    return {
      state: building ? 'building' : db.readOnly ? 'readonly' : this.fullSyncDone ? 'ready' : 'building',
      indexedSessions: indexed,
      totalSessions: db.readOnly ? indexed : Math.max(indexed, this.summaries.size),
      documents,
      stale: stale || undefined,
      degraded: this.lastRefreshError?.message,
    };
  }
}

registerScopedService(
  LifecycleScope.App,
  IGlobalSearchService,
  GlobalSearchService,
  ScopeActivation.OnScopeCreated,
  'globalSearch',
);

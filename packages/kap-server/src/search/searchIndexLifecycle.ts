import { join } from 'node:path';
import { rm, stat } from 'node:fs/promises';

import {
  IBootstrapService,
  ILogService,
  ISessionIndex,
  sessionDirOf,
  workspacePersistenceScope,
  type SessionSummary,
} from '@moonshot-ai/agent-core-v2';
import { LockError, MiniDb, OpTracker, type BatchInputOp } from '@moonshot-ai/minidb';

import {
  FILE_META_PREFIX,
  INDEX_DIR_NAME,
  SESSION_META_PREFIX,
  SESSION_PAGE_SIZE,
  STATS_KEY,
  TEXT_INDEX_NAME,
  TRI_INDEX_NAME,
  errorMessage,
  fileMetaKey,
  fileMetaPrefixFor,
  type SearchDoc,
  type SessionMetaDoc,
  type StatsDoc,
  type TitleDoc,
} from './searchDocs';
import { GlobalSearchError } from './searchQuery';
import {
  collectWireFiles,
  deleteFileDocs,
  isRebuildableCorruption,
  pathExists,
  syncWireFile,
  type WireIndexHost,
} from './searchWireIndex';

export abstract class SearchIndexLifecycle implements WireIndexHost {
  abstract readonly sessionIndex: ISessionIndex;
  abstract readonly bootstrap: IBootstrapService;
  abstract readonly log: ILogService;

  abstract db: MiniDb<SearchDoc> | null;
  abstract openPromise: Promise<void> | null;
  abstract syncPromise: Promise<void> | null;
  abstract refreshPromise: Promise<void> | null;
  abstract lastSyncStartedAt: number;
  abstract fullSyncDone: boolean;
  abstract walOffset: number;
  abstract fingerprint: string;
  abstract summaries: Map<string, SessionSummary>;
  abstract disposed: boolean;
  abstract readonly ops: OpTracker;
  abstract reindexing: boolean;
  abstract syncReplaced: boolean;
  abstract syncQueued: boolean;
  abstract syncTimer: ReturnType<typeof setTimeout> | null;
  abstract lastRefreshError: { at: number; message: string } | null;
  abstract openError: string | null;
  abstract fileMetaMigrated: boolean;
  abstract generation: number;
  abstract syncDebounceMs: number;

  protected get indexDir(): string {
    return join(this.bootstrap.homeDir, INDEX_DIR_NAME);
  }

  protected ensureOpen(): Promise<void> {
    this.openPromise ??= this.openDb().then(
      () => {
        this.openError = null;
      },
      (error: unknown) => {
        this.openPromise = null;
        this.openError = errorMessage(error);
        throw error;
      },
    );
    return this.openPromise;
  }

  protected async openDb(): Promise<void> {
    const db = await this.openSearchDb();
    // The scope may have been disposed while the (slow) open was in flight —
    // close the handle immediately instead of leaking it and writing the
    // text-index definition below into a directory the caller may already be
    // deleting.
    if (this.disposed) {
      await db.close().catch(() => {});
      throw new GlobalSearchError('index_unavailable', 'search service is disposed');
    }
    await this.publishDb(db, null);
  }

  /**
   * Swap a freshly opened db in as the new published generation: writer-side
   * text-index definitions and the (handle-independent) fingerprint are
   * computed BEFORE the swap, so a failure closes `next` and leaves `prev`
   * (or the no-db state) untouched; the swap itself is one synchronous
   * segment with no failure point between publishing `next` and closing
   * `prev`.
   */
  protected async publishDb(next: MiniDb<SearchDoc>, prev: MiniDb<SearchDoc> | null): Promise<void> {
    let fingerprint: string;
    try {
      if (!next.readOnly) {
        // Both indexes are created here (not at first write) so a
        // pre-existing db gets the tri index built over its current documents
        // on first open after the upgrade, and a read-only peer only ever
        // reopens on the definitions-file fingerprint change.
        for (const [name, options] of [
          [TEXT_INDEX_NAME, { fields: ['text'] }],
          [TRI_INDEX_NAME, { fields: ['text'], tokenizer: 'ngram' }],
        ] as const) {
          try {
            await next.createTextIndex(name, options);
          } catch (error) {
            if (!(error instanceof Error && error.message.includes('already exists'))) throw error;
          }
        }
      }
      fingerprint = await this.computeFingerprint();
    } catch (error) {
      await next.close().catch(() => {});
      throw error;
    }
    this.db = next;
    this.walOffset = next.recoveryInfo?.walScanEnd ?? 0;
    this.generation++;
    this.fingerprint = fingerprint;
    if (prev !== null) await prev.close().catch(() => {});
  }

  /**
   * Open the index db, rebuilding from scratch on unrecoverable corruption
   * (the index is derived data — never repaired, only rebuilt).
   *
   * Rebuild is WRITER-ONLY: a process that fails to grab the write lock must
   * never delete the directory out from under the live indexer. Lock state is
   * not observable once `open` throws, so corruption is disambiguated with a
   * probe open WITHOUT `onLockFail`: it throws `LockError` before recovery
   * when another process holds the lock, and re-throws the corruption
   * (releasing the lock) when the lock is free — in which case this process
   * is the would-be writer and may rebuild.
   */
  protected async openSearchDb(): Promise<MiniDb<SearchDoc>> {
    const opts = {
      dir: this.indexDir,
      valueCodec: 'json',
      fsyncPolicy: 'everysec',
      onLockFail: 'readonly',
    } as const;
    try {
      return await MiniDb.open<SearchDoc>(opts);
    } catch (error) {
      if (!isRebuildableCorruption(error)) throw error;
      let probeError: unknown;
      try {
        const probe = await MiniDb.open<SearchDoc>({ dir: opts.dir, valueCodec: opts.valueCodec });
        await probe.close().catch(() => {});
        probeError = undefined; // lock free AND data fine — cannot happen, but treat as rebuildable
      } catch (error) {
        probeError = error;
      }
      if (probeError instanceof LockError) {
        // Another process holds the write lock: leave its files alone. The
        // caller's open fails; the next search retries from scratch.
        throw error;
      }
      await rm(this.indexDir, { recursive: true, force: true });
      return MiniDb.open<SearchDoc>(opts);
    }
  }


  /**
   * Run one lifecycle-managed background op under the dispose drain gate:
   * skipped once dispose has started, and dispose waits for every op that
   * already entered before it closes the db (review #20).
   */
  protected async tracked(op: () => Promise<void>): Promise<void> {
    if (!this.ops.enter()) return;
    try {
      await op();
    } finally {
      this.ops.leave();
    }
  }

  // -- read-only freshness (fingerprint + WAL catch-up) -------------------------

  protected async computeFingerprint(): Promise<string> {
    const parts: string[] = [];
    for (const name of ['db.wal', 'db.snapshot', 'db.textindexes.json']) {
      try {
        const s = await stat(join(this.indexDir, name));
        parts.push(`${name}:${s.dev}:${s.ino}:${s.mtimeMs}:${s.size}`);
      } catch {
        parts.push(`${name}:-`);
      }
    }
    return parts.join('|');
  }

  /**
   * Bring a read-only instance up to date with the indexer's committed
   * writes. Unchanged fingerprint → zero IO; WAL pure-append → incremental
   * `catchUpFromWal`; anything else → open the replacement db and swap (which
   * may also promote this process to indexer when the old writer's lock is
   * gone). Single-flight; a failure is recorded in `lastRefreshError` and
   * the stale generation keeps serving (surfaced as `indexState.degraded`).
   */
  protected refreshReadonly(): Promise<void> {
    this.refreshPromise ??= this.tracked(() => this.doRefreshReadonly())
      .then(
        () => {
          this.lastRefreshError = null;
        },
        (error: unknown) => {
          // A failed refresh must not fail the search — serve the stale view,
          // but no longer swallow the error silently.
          this.lastRefreshError = { at: Date.now(), message: errorMessage(error) };
          this.log.warn('global search: read-only refresh failed; serving the stale view', {
            error: errorMessage(error),
          });
        },
      )
      .finally(() => {
        this.refreshPromise = null;
      });
    return this.refreshPromise;
  }

  protected async doRefreshReadonly(): Promise<void> {
    const db = this.db;
    if (!db || !db.readOnly || this.disposed) return;
    const fp = await this.computeFingerprint();
    if (fp === this.fingerprint) return;
    const [, snapPrev, defsPrev] = this.fingerprint.split('|');
    const [, snapNow, defsNow] = fp.split('|');
    if (snapPrev === snapNow && defsPrev === defsNow) {
      const res = await db.catchUpFromWal(this.walOffset);
      if (res !== null) {
        this.walOffset = res.offset;
        this.fingerprint = fp;
        return;
      }
    }
    // WAL rotated/truncated, snapshot or index definitions changed, or the
    // watermark no longer aligns: reopen from scratch. The replacement is
    // opened and published BEFORE the stale handle closes, so a failed
    // reopen leaves the previous generation servable instead of dropping
    // the index out from under in-flight searches.
    const next = await this.openSearchDb();
    if (this.disposed) {
      await next.close().catch(() => {});
      return;
    }
    if (this.db !== db) {
      // A concurrent refresh already swapped: just close the duplicate.
      await next.close().catch(() => {});
      return;
    }
    await this.publishDb(next, db);
  }

  // -- sync coordinator (indexer only) -------------------------------------------
  //
  // Requests never await a sync; they ask the coordinator to schedule one.
  // Single-flight serializes passes, the debounce window coalesces bursts,
  // and backpressure is one queued follow-up behind the in-flight pass.

  protected requestSync(): void {
    if (this.disposed || this.reindexing) return;
    if (this.syncPromise !== null) {
      // A pass is already running: queue exactly one follow-up.
      this.syncQueued = true;
      return;
    }
    const wait = this.syncDebounceMs - (Date.now() - this.lastSyncStartedAt);
    if (wait > 0) {
      // Inside the debounce window: coalesce requests into one trailing pass.
      if (this.syncTimer === null) {
        this.syncTimer = setTimeout(() => {
          this.syncTimer = null;
          this.requestSync();
        }, wait);
        this.syncTimer.unref?.();
      }
      return;
    }
    this.startSyncPass();
  }

  protected startSyncPass(): void {
    this.syncQueued = false;
    void this.ensureSyncStarted().then(
      () => {
        this.lastRefreshError = null;
        if (this.syncQueued) {
          this.syncQueued = false;
          this.requestSync();
        }
      },
      (error: unknown) => {
        this.lastRefreshError = { at: Date.now(), message: errorMessage(error) };
        this.log.warn('global search: background sync failed', { error: errorMessage(error) });
      },
    );
  }

  /** Single-flight: concurrent callers share the in-flight sync. */
  protected ensureSyncStarted(): Promise<void> {
    if (this.syncPromise === null) {
      const p = this.tracked(() => this.runSync()).finally(() => {
        if (this.syncPromise === p) this.syncPromise = null;
      });
      this.syncPromise = p;
    }
    return this.syncPromise;
  }

  protected async runSync(): Promise<void> {
    // `reindexing`: a rebuild is swapping the db out — this pass is a no-op;
    // the rebuild itself runs the authoritative sync when done.
    if (this.disposed || this.reindexing) return;
    this.syncReplaced = false;
    const sessions = await this.listAllSessions();
    // Nothing to index and no index on disk yet: don't even create the
    // `<home>/search-index` directory — it would show up in the fs folder
    // picker and cost every server boot a pointless db open.
    if (sessions.length === 0 && !(await pathExists(this.indexDir))) {
      this.summaries = new Map();
      this.lastSyncStartedAt = Date.now();
      this.fullSyncDone = true;
      return;
    }

    await this.ensureOpen();
    const db = this.db;
    if (!db || db.readOnly || this.disposed) return;
    this.lastSyncStartedAt = Date.now();

    // One-time rewrite of pre-v2 hash-only file-meta keys, inside the
    // background pass — never in the query path. After it, every per-session
    // lookup below scans only that session's meta prefix.
    await this.migrateFileMetaKeys(db);

    this.summaries = new Map(sessions.map((s) => [s.id, s]));
    const currentIds = new Set(sessions.map((s) => s.id));

    // Drop sessions whose directory disappeared since the last sync. The
    // disposed gate covers this loop and the trailing stats write (review
    // #20): once dispose starts, the pass skips them instead of writing into
    // a db whose close is already draining.
    for (const row of db.query({ key: { prefix: SESSION_META_PREFIX }, project: [] })) {
      if (this.disposed) return;
      const sessionId = row.key.slice(SESSION_META_PREFIX.length);
      if (!currentIds.has(sessionId)) await this.deleteSessionDocs(db, sessionId);
    }

    let indexed = 0;
    for (const summary of sessions) {
      if (this.disposed) return;
      try {
        await this.syncSession(db, summary);
        indexed++;
      } catch (error) {
        // One unreadable session must not abort the whole pass.
        this.log.warn('global search: failed to index session', {
          sessionId: summary.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (this.disposed) return; // dispose started mid-pass: skip the trailing write (review #20)
    const metaCount = db.query({ key: { prefix: '\0meta\\' }, project: [] }).length;
    const stats: StatsDoc = {
      kind: 'stats',
      sessions: indexed,
      documents: db.size - metaCount,
      lastIndexedAt: Date.now(),
    };
    await db.set(STATS_KEY, stats);
    this.fullSyncDone = true;
    if (this.syncReplaced) {
      // The pass REPLACED indexed documents (shrink rescan / title
      // overwrite), so their sort keys may have moved: page tokens from the
      // previous generation must restart instead of drifting.
      this.generation++;
    }
  }

  /**
   * One-time per-process migration of pre-v2 hash-only file-meta keys to the
   * session-scoped format (`fileMetaKey`). A single full prefix scan of the
   * meta namespace; per-session work afterwards only scans that session's
   * keys. Idempotent — a crash mid-migration just rescans on the next pass.
   */
  protected async migrateFileMetaKeys(db: MiniDb<SearchDoc>): Promise<void> {
    if (this.fileMetaMigrated) return;
    const ops: BatchInputOp<SearchDoc>[] = [];
    for (const row of db.query({ key: { prefix: FILE_META_PREFIX }, project: [] })) {
      const rest = row.key.slice(FILE_META_PREFIX.length);
      if (rest.includes('\\')) continue; // already session-scoped
      const meta = row.value;
      if (meta.kind !== 'fileMeta') continue;
      ops.push({ op: 'set', key: fileMetaKey(meta.sessionId, meta.path), value: meta });
      ops.push({ op: 'del', key: row.key });
    }
    // Batch the rewrite instead of one op per key; empty on every later pass.
    if (ops.length > 0) await db.batch(ops);
    this.fileMetaMigrated = true;
  }

  protected async listAllSessions(): Promise<SessionSummary[]> {
    const out: SessionSummary[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.sessionIndex.listRecent({ before: cursor, limit: SESSION_PAGE_SIZE });
      out.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return out;
  }

  protected async deleteSessionDocs(db: MiniDb<SearchDoc>, sessionId: string): Promise<void> {
    for (const row of db.query({ key: { prefix: `${sessionId}/` }, project: [] })) {
      await db.del(row.key);
    }
    for (const row of db.query({ key: { prefix: fileMetaPrefixFor(sessionId) }, project: [] })) {
      await db.del(row.key);
    }
    await db.del(SESSION_META_PREFIX + sessionId);
  }

  protected async syncSession(db: MiniDb<SearchDoc>, summary: SessionSummary): Promise<void> {
    const sessionDir = sessionDirOf(
      this.bootstrap.homeDir,
      workspacePersistenceScope(this.bootstrap.scope('sessions'), summary.workspaceId),
      summary.id,
    );
    const wireFiles = await collectWireFiles(sessionDir);
    const seenPaths = new Set(wireFiles.map((file) => file.path));

    // A wire file that vanished on its own (e.g. one agent's log deleted
    // while the session lives on): drop its docs and meta. Session-level
    // disappearance is handled separately in runSync. The scan is scoped to
    // THIS session's meta prefix — O(files of this session), independent of
    // the global session count.
    for (const row of db.query({ key: { prefix: fileMetaPrefixFor(summary.id) } })) {
      const meta = row.value;
      if (meta.kind !== 'fileMeta') continue;
      if (seenPaths.has(meta.path)) continue;
      await deleteFileDocs(db, meta);
      await db.del(row.key);
    }

    for (const file of wireFiles) {
      await syncWireFile(this, db, summary, file);
    }

    const title = summary.title ?? '';
    const titleKey = `${summary.id}/$title`;
    const existing = db.get(titleKey);
    if (title.length > 0) {
      if (existing?.kind !== 'title' || existing.text !== title) {
        const doc: TitleDoc = {
          kind: 'title',
          sessionId: summary.id,
          workspaceId: summary.workspaceId,
          sessionTitle: title,
          agentId: '',
          role: 'title',
          text: title,
          time: summary.updatedAt,
        };
        await db.set(titleKey, doc);
        // Overwriting an existing title doc moves its sort key mid-pagination
        // — a replacing change, unlike the additive first-time create.
        if (existing !== undefined) this.syncReplaced = true;
      }
    } else if (existing !== undefined) {
      await db.del(titleKey);
    }
    // Session marker: presence is the information — write only when missing.
    if (db.get(SESSION_META_PREFIX + summary.id) === undefined) {
      const sessionMeta: SessionMetaDoc = { kind: 'sessionMeta' };
      await db.set(SESSION_META_PREFIX + summary.id, sessionMeta);
    }
  }
}

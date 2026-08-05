/**
 * `sessionIndex` domain (L2) — `FileSessionIndex` implementation.
 *
 * Serves session listings, point lookups, and counts straight from the
 * authoritative store: the directory tree is enumerated and every
 * `state.json` is read (see `sessionIndexSource`). Always correct, linear in
 * the number of sessions.
 *
 * Keyset pagination is canonical (`updatedAt` desc, `id` desc): a cursor is a
 * session id resolved inside the collected, canonically sorted listing, so
 * same-millisecond ties never lose or duplicate an item across pages. An
 * unknown cursor id yields an empty, terminal page.
 *
 * This is the local-deployment backend of `ISessionIndex`; a server
 * deployment would substitute a database-backed implementation. Bound at App
 * scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { Page } from '#/persistence/interface/queryStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import {
  ISessionIndex,
  type SessionCountQuery,
  type SessionIndexStatus,
  type SessionListQuery,
  type SessionSummary,
} from './sessionIndex';
import {
  listSessionIds,
  listWorkspaceIds,
  readSessionSummary,
  summaryMatchesChildOf,
} from './sessionIndexSource';

function canonicalOrder(a: SessionSummary, b: SessionSummary): number {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export class FileSessionIndex extends Disposable implements ISessionIndex {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
  ) {
    super();
  }

  prepare(_options?: { deadlineMs?: number }): Promise<SessionIndexStatus> {
    return Promise.resolve(this.status());
  }

  status(): SessionIndexStatus {
    return { state: 'uninitialized', degradedCount: 0 };
  }

  async get(id: string): Promise<SessionSummary | undefined> {
    for (const workspaceId of await listWorkspaceIds(this.storage, this.sessionsScope)) {
      const sessionIds = await listSessionIds(this.storage, this.sessionsScope, workspaceId);
      if (!sessionIds.includes(id)) continue;
      const summary = await readSessionSummary(this.docs, this.sessionsScope, workspaceId, id);
      if (summary !== undefined) return summary;
    }
    return undefined;
  }

  async listRecent(query: SessionListQuery): Promise<Page<SessionSummary>> {
    if (query.sessionId !== undefined) {
      const summary = await this.get(query.sessionId);
      const items =
        summary !== undefined && (!summary.archived || query.includeArchived === true)
          ? [summary]
          : [];
      return { items: query.limit !== undefined ? items.slice(0, query.limit) : items };
    }

    const workspaceIds = query.workspaceIds ?? (await listWorkspaceIds(this.storage, this.sessionsScope));
    const collected: SessionSummary[] = [];
    for (const workspaceId of workspaceIds) {
      for (const sessionId of await listSessionIds(this.storage, this.sessionsScope, workspaceId)) {
        const summary = await readSessionSummary(this.docs, this.sessionsScope, workspaceId, sessionId);
        if (summary === undefined) continue;
        if (summary.archived && query.includeArchived !== true) continue;
        if (!summaryMatchesChildOf(summary, query.childOf)) continue;
        collected.push(summary);
      }
    }
    const items = collected.toSorted(canonicalOrder);

    let start = 0;
    let end = items.length;
    const cursorId = query.before ?? query.after;
    if (cursorId !== undefined) {
      const index = items.findIndex((summary) => summary.id === cursorId);
      if (index === -1) return { items: [] };
      if (query.before !== undefined) start = index + 1;
      else end = index;
    }
    const window = items.slice(start, end);
    if (query.limit === undefined) return { items: window };
    const kept = window.slice(0, query.limit);
    return {
      items: kept,
      nextCursor: window.length > query.limit ? kept.at(-1)!.id : undefined,
    };
  }

  async count(query: SessionCountQuery): Promise<number> {
    let count = 0;
    const workspaceIds =
      query.workspaceIds ?? (await listWorkspaceIds(this.storage, this.sessionsScope));
    for (const workspaceId of workspaceIds) {
      for (const sessionId of await listSessionIds(this.storage, this.sessionsScope, workspaceId)) {
        const summary = await readSessionSummary(this.docs, this.sessionsScope, workspaceId, sessionId);
        if (summary === undefined) continue;
        if (query.includeArchived === true || !summary.archived) count += 1;
      }
    }
    return count;
  }

  async remove(_id: string): Promise<void> {}

  private get sessionsScope(): string {
    return this.bootstrap.scope('sessions');
  }
}

registerScopedService(
  LifecycleScope.App,
  ISessionIndex,
  FileSessionIndex,
  ScopeActivation.OnScopeCreated,
  'sessionIndex',
);

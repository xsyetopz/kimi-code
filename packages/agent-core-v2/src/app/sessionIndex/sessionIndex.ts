/**
 * `sessionIndex` domain (L2) — session index contract.
 *
 * `ISessionIndex` is a domain-specific persistence Store: a backend-neutral
 * query facade over the set of persisted sessions (open or closed). It serves
 * recency-ordered pages, point lookups, and counts (`SessionSummary` data or
 * numbers — never filesystem paths or live handles). Writes (create /
 * archive) live in `sessionLifecycle` / `session`. Backends are
 * deployment-specific (local filesystem today; database on a server).
 * `remove` is the one write: it evicts a deleted session's derived/cached
 * state so `get` stops answering for the id — the authoritative record (the
 * session directory) is deleted by the caller (`sessionLifecycle.delete`).
 *
 * Listings follow a canonical order — `updatedAt` descending, `id`
 * descending as the tie-break — and page with keyset cursors: `before` /
 * `after` take a session id and return the page strictly older / newer than
 * it; `Page.nextCursor` carries the id to pass as `before` for the next
 * older page. An unknown cursor id yields an empty, terminal page.
 *
 * There is no derived read model: reads are served straight from the
 * authoritative session directories. `prepare()` / `status()` are kept for
 * composition-root compatibility (`prepare()` is a no-op, `status()` always
 * reports `uninitialized`).
 */

import {
  createDecorator,
  type ServiceIdentifier,
} from "#/_base/di/instantiation";
import type { Page } from "#/persistence/interface/queryStore";

export const PARENT_SESSION_ID_KEY = "parent_session_id";

export const CHILD_SESSION_KIND_KEY = "child_session_kind";

export const CHILD_SESSION_KIND = "child";

export interface SessionSummary {
  readonly id: string;
  readonly workspaceId: string;
  readonly cwd?: string;
  readonly title?: string;
  readonly lastPrompt?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived: boolean;
  readonly custom?: Record<string, unknown>;
}

export interface SessionListQuery {
  /**
   * Restrict to sessions persisted under any of these workspace ids. A single
   * workspace is `[id]`; callers resolving a legacy split bucket (one
   * directory, several id spellings — see `IWorkspaceAliases.resolveAliasIds`)
   * pass the whole alias set and get one merged listing. Absent lists every
   * bucket.
   */
  readonly workspaceIds?: readonly string[];
  readonly sessionId?: string;
  readonly includeArchived?: boolean;
  readonly limit?: number;
  readonly childOf?: string;
  /** Keyset cursor: the page strictly older than this session id. */
  readonly before?: string;
  /** Keyset cursor: the page strictly newer than this session id. */
  readonly after?: string;
}

export interface SessionCountQuery {
  readonly workspaceIds?: readonly string[];
  readonly includeArchived?: boolean;
}

export type SessionIndexState =
  | "uninitialized"
  | "preparing"
  | "ready"
  | "degraded";

export interface SessionIndexStatus {
  readonly state: SessionIndexState;
  readonly generation?: number;
  readonly reason?: string;
  readonly degradedCount: number;
}

export interface ISessionIndex {
  readonly _serviceBrand: undefined;

  /**
   * Lifecycle hook kept for composition roots that warm up services before
   * serving traffic. Reads need no preparation, so this simply returns the
   * current `status()`.
   */
  prepare(options?: { deadlineMs?: number }): Promise<SessionIndexStatus>;
  status(): SessionIndexStatus;
  get(id: string): Promise<SessionSummary | undefined>;
  /** Recency-ordered keyset page over the persisted session set. */
  listRecent(query: SessionListQuery): Promise<Page<SessionSummary>>;
  /** Count over the given workspace-id set. */
  count(query: SessionCountQuery): Promise<number>;
  /**
   * Evict a deleted session's derived/cached state so `get` stops answering
   * for the id — the authoritative record (the session directory) is deleted
   * by the caller (`sessionLifecycle.delete`). The filesystem backend keeps
   * no derived state, so this is a no-op there.
   */
  remove(id: string): Promise<void>;
}

export const ISessionIndex: ServiceIdentifier<ISessionIndex> =
  createDecorator<ISessionIndex>("sessionIndex");

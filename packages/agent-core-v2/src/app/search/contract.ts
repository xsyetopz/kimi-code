/**
 * `search` domain — global message search contract.
 *
 * Single source of truth for request/response shapes shared by
 * `IGlobalSearchService`, the kap-server REST adapter, and klient.
 */

// ---- request ---------------------------------------------------------------

export interface GlobalSearchQuery {
  /** Keyword(s), required. */
  readonly query: string;
  /**
   * 'terms' (default) — word-level full-text; 'literal' — exact substring
   * match (case-insensitive, NFKC-folded; needs at least 2 normalized
   * characters). `op`/`sort` only apply to 'terms'; literal hits carry
   * score 0 and sort by time desc.
   */
  readonly mode?: "terms" | "literal";
  /** Term combination, default AND. */
  readonly op?: "AND" | "OR";
  /** Omit to search across every session. */
  readonly container?: {
    readonly sessionId?: string;
    readonly agentId?: string;
  };
  /** Restrict to one document role. */
  readonly role?: "user" | "assistant" | "title";
  /** Epoch ms, inclusive bounds. */
  readonly startTime?: number;
  readonly endTime?: number;
  /** Default 'score' (relevance). */
  readonly sort?: "score" | "time_desc" | "time_asc";
  /** Default 20, max 50. */
  readonly pageSize?: number;
  /** Opaque cursor from the previous page; omit for the first page. */
  readonly pageToken?: string;
}

// ---- response --------------------------------------------------------------

export interface GlobalSearchHit {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly sessionTitle: string;
  /** 'main' or a subagent id. */
  readonly agentId: string;
  readonly role: "user" | "assistant" | "title";
  /** ~80-char window around the first hit term, generated server-side. */
  readonly snippet: string;
  /** Epoch ms of the wire record (session `updatedAt` for title docs). */
  readonly time: number;
  readonly turn?: number;
  readonly stepId?: string;
  readonly score: number;
}

export interface GlobalSearchIndexState {
  readonly state: "building" | "ready" | "readonly";
  readonly indexedSessions: number;
  readonly totalSessions: number;
  readonly documents: number;
  readonly stale?: boolean;
  readonly degraded?: string;
}

export type GlobalSearchSource = "index" | "ripgrep";

export type GlobalSearchIncomplete =
  | "candidate_cap"
  | "postings_budget"
  | "deadline";

export interface GlobalSearchPage {
  readonly items: GlobalSearchHit[];
  readonly hasMore: boolean;
  readonly pageToken?: string;
  readonly incomplete?: GlobalSearchIncomplete;
  readonly indexState: GlobalSearchIndexState;
  readonly source: GlobalSearchSource;
}

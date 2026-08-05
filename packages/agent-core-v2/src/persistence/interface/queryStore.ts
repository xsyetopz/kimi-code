/**
 * `Page` — the keyset-paginated result shape shared by persistence query
 * facades (e.g. `ISessionIndex.listRecent`). `nextCursor` carries the opaque
 * cursor to pass back for the next page; absent means the listing is
 * exhausted.
 */

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

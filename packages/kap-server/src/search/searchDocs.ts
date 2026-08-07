import { createHash } from 'node:crypto';

import type { StepEffect, TurnEffect } from './wireExtract';

// ---------------------------------------------------------------------------
// Constants & stored document shapes
// ---------------------------------------------------------------------------

export const INDEX_DIR_NAME = 'search-index';
export const TEXT_INDEX_NAME = 'body';
/** n-gram substring index backing literal mode, alongside 'body'. */
export const TRI_INDEX_NAME = 'tri';
export const WIRE_FILENAME = 'wire.jsonl';

/** Key namespaces inside the single db. */
export const FILE_META_PREFIX = '\0meta\\file\\';
export const SESSION_META_PREFIX = '\0meta\\session\\';
export const STATS_KEY = '\0meta\\stats';

function hashPath(filePath: string): string {
  return createHash('sha256').update(filePath).digest('hex').slice(0, 32);
}

/**
 * minidb keys are limited to 128 bytes, far shorter than an absolute wire
 * path — the file meta key carries the owning session id plus a hash of the
 * path (the path itself lives in the value). The session segment makes a
 * per-session prefix scan (`fileMetaPrefixFor`) touch only that session's
 * metas instead of the global meta namespace.
 */
export function fileMetaKey(sessionId: string, filePath: string): string {
  return `${FILE_META_PREFIX}${sessionId}\\${hashPath(filePath)}`;
}

/** All file-meta keys of one session (prefix-scan argument). */
export function fileMetaPrefixFor(sessionId: string): string {
  return `${FILE_META_PREFIX}${sessionId}\\`;
}

/**
 * Pre-v2 file-meta key: hash-only, the owning session identifiable only via
 * the value — a per-session lookup required scanning every file meta.
 * Read side of the migration: `syncWireFile` still resolves it by point
 * lookup; `migrateFileMetaKeys` rewrites the rest in one background pass.
 */
export function legacyFileMetaKey(filePath: string): string {
  return FILE_META_PREFIX + hashPath(filePath);
}

/** Cap one indexed document's text so huge pastes do not bloat the index. */
export const MAX_DOC_TEXT_CHARS = 20_000;
/** Upper bound for text-index candidates handed to the scoring map / query. */
export const MAX_TEXT_HITS = 100_000;
/**
 * Upper bound for literal-mode n-gram candidates handed to the confirmation
 * pass (a store `get` plus a substring scan each — pure CPU). Beyond the cap
 * the page is truncated and flagged `incomplete: 'candidate_cap'`.
 */
export const LITERAL_CANDIDATE_CAP = 10_000;
/** Sessions are listed in pages of this size. */
export const SESSION_PAGE_SIZE = 500;

// -- query budgets (service knobs; the defaults are the production values) ----

/** Max distinct query terms in terms mode. */
export const MAX_QUERY_TERMS = 32;
/** Max literal-query length in normalized code points (bounds n-gram terms). */
export const MAX_LITERAL_QUERY_CHARS = 1_024;
/**
 * Max posting entries the index may visit for one query (both modes). A hot
 * term/n-gram whose postings overflow the budget contributes a prefix and
 * the page is flagged `incomplete: 'postings_budget'` — the budget applies
 * at the postings/score stage, not just at final confirmation.
 */
export const MAX_POSTINGS_VISITS = 250_000;
/** Wall-clock budget for the in-memory match/confirm phase of one query. */
export const QUERY_DEADLINE_MS = 500;
/** Max document text processed by literal confirmation per query (UTF-16
 *  code units) — the backstop for pathological huge-document corpora. */
export const QUERY_TEXT_BUDGET_CHARS = 16_000_000;
/** How often the match loop re-checks the deadline (candidate iterations). */
export const DEADLINE_CHECK_STRIDE = 64;

/** One wire-delta read slice: growth is consumed in bounded chunks instead
 *  of one `size - offset` allocation. */
export const WIRE_READ_CHUNK_BYTES = 1 << 20;
/** Flush doc ops to the db in batches of this size while scanning a delta. */
export const WIRE_BATCH_OPS = 1_000;
export const EMPTY_BUFFER = Buffer.alloc(0);

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface MessageDoc {
  readonly kind: 'message';
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly sessionTitle: string;
  readonly agentId: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly time: number;
  /**
   * 0-based turn ordinal in the transcript view (groupTurns numbering). Absent
   * for docs indexed before turn tracking existed.
   */
  readonly turn?: number;
  /**
   * Transcript step id (`t<turn>.<step>`, engine live numbering from the wire
   * record's `step` field) of the step that produced this assistant text.
   * Absent for user docs and docs indexed before step tracking existed.
   */
  readonly stepId?: string;
}

export interface TitleDoc {
  readonly kind: 'title';
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly sessionTitle: string;
  /** Titles belong to the session, not an agent — always ''. */
  readonly agentId: '';
  readonly role: 'title';
  readonly text: string;
  readonly time: number;
}

export interface FileMetaDoc {
  readonly kind: 'fileMeta';
  /** Owning session, used to drop metas when a session disappears. */
  readonly sessionId: string;
  /** Doc-key coordinates of this file's documents (see `docKeyPrefix`). */
  readonly agentId: string;
  readonly source: 'root' | 'agents';
  /** Absolute wire path (debugging aid; the key is its session + hash). */
  readonly path: string;
  /** Byte offset up to which the wire file has been indexed. */
  readonly offset: number;
  readonly size: number;
  /**
   * File mtime/inode at the last sync pass. A changed inode (atomic
   * replacement) or a bumped mtime at an unchanged size (in-place rewrite)
   * forces a rescan even when `size === offset`. Absent in metas written
   * before change tracking — such metas are simply refreshed with the
   * current stat on the next pass, without a rescan.
   */
  readonly mtimeMs?: number;
  readonly ino?: number;
  /**
   * Turn counter state at `offset` — persisted with the watermark so an
   * incremental pass resumes counting instead of restarting at turn 0.
   * Absent in metas written before turn tracking; treated as the initial
   * state, which makes a legacy meta resume mid-file with a zeroed counter —
   * an accepted one-time drift, self-healing on the next shrink/rescan.
   */
  readonly turnState?: TurnCounterState;
  /**
   * Step tracker state at `offset` — persisted with the watermark for the
   * same resume reason as `turnState`. Absent in metas written before step
   * tracking: such a file is RESCANNED from scratch (docs dropped, offset
   * reset) so stepIds are all-or-nothing per file instead of drifting.
   */
  readonly stepState?: StepTrackerState;
}

export interface SessionMetaDoc {
  readonly kind: 'sessionMeta';
}

// ---------------------------------------------------------------------------
// Turn counter (transcript groupTurns numbering, replayed over the wire file)
// ---------------------------------------------------------------------------

interface TurnOpener {
  readonly turn: number;
  readonly anchor: boolean;
}

export interface TurnCounterState {
  /** Ordinal the next opened turn will get (0-based). */
  readonly next: number;
  /** Whether a turn is currently open (groupTurns' `ensureTurn` gate). */
  readonly hasTurn: boolean;
  /** Turn openers, in order — the replay stack for `context.undo`. */
  readonly openers: readonly TurnOpener[];
}

const INITIAL_TURN_STATE: TurnCounterState = { next: 0, hasTurn: false, openers: [] };

export function initialTurnState(): TurnCounterState {
  return INITIAL_TURN_STATE;
}

/**
 * Replay `context.undo {count}`: drop the last `count` anchor-opened turns.
 * The counter rewinds to the ordinal of the earliest dropped anchor, and the
 * opener stack is truncated there. An undo with fewer anchors than `count`
 * never reaches the wire (the engine's precheck rejects it) — left untouched.
 */
function applyUndoToTurnState(state: TurnCounterState, count: number): TurnCounterState {
  let found = 0;
  for (let i = state.openers.length - 1; i >= 0; i--) {
    if (state.openers[i]!.anchor) {
      found++;
      if (found === count) {
        return {
          next: state.openers[i]!.turn,
          hasTurn: i > 0,
          openers: state.openers.slice(0, i),
        };
      }
    }
  }
  return state;
}

/**
 * Advance the counter with one record's turn effect. Returns the ordinal that
 * documents extracted from the SAME record belong to: a user opener carries
 * the turn it opens; assistant content carries the current turn (after the
 * `ensure` gate). Undefined when the record owns no turn.
 */
export function advanceTurnCounter(
  state: TurnCounterState,
  effect: TurnEffect,
): { docTurn: number | undefined; state: TurnCounterState } {
  switch (effect.kind) {
    case 'open':
      return {
        docTurn: state.next,
        state: {
          next: state.next + 1,
          hasTurn: true,
          openers: [...state.openers, { turn: state.next, anchor: effect.anchor }],
        },
      };
    case 'ensure': {
      const next = state.hasTurn ? state : { ...state, next: state.next + 1, hasTurn: true };
      return { docTurn: next.next - 1, state: next };
    }
    case 'undo':
      return { docTurn: undefined, state: applyUndoToTurnState(state, effect.count) };
    case 'none':
      return { docTurn: undefined, state };
  }
}

// ---------------------------------------------------------------------------
// Step tracker (transcript step ids `t<turn>.<step>`, per-turn uuid → ordinal)
// ---------------------------------------------------------------------------

export interface StepTrackerState {
  /** Current turn's step uuid → ordinal (the wire `step` field, else the fallback counter). */
  readonly byUuid: Record<string, number>;
  /** `step.begin` count within the current turn — the fallback ordinal source. */
  readonly begins: number;
}

const INITIAL_STEP_STATE: StepTrackerState = { byUuid: {}, begins: 0 };

export function initialStepState(): StepTrackerState {
  return INITIAL_STEP_STATE;
}

/** Advance the tracker with one record's step effect. */
export function advanceStepTracker(state: StepTrackerState, effect: StepEffect): StepTrackerState {
  if (effect.kind !== 'begin') return state;
  const begins = state.begins + 1;
  const ordinal = effect.ordinal ?? begins;
  if (state.byUuid[effect.uuid] === ordinal) return state;
  return { byUuid: { ...state.byUuid, [effect.uuid]: ordinal }, begins };
}

export interface StatsDoc {
  readonly kind: 'stats';
  readonly sessions: number;
  readonly documents: number;
  readonly lastIndexedAt: number;
}

export type SearchDoc = MessageDoc | TitleDoc | FileMetaDoc | SessionMetaDoc | StatsDoc;

/**
 * Fire-and-forget close promises produced by `dispose()` (DI disposal is
 * synchronous). The server shutdown path awaits these via
 * `drainGlobalSearchDisposals()` before the homeDir is released, so a
 * teardown `rm()` never races an in-flight minidb open/close.
 */
export const pendingDisposals = new Set<Promise<void>>();

export async function drainGlobalSearchDisposals(): Promise<void> {
  while (pendingDisposals.size > 0) {
    await Promise.all(pendingDisposals);
  }
}

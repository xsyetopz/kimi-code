import { createHash } from "node:crypto";

import type { StepEffect, TurnEffect } from "./wireExtract";

export const SEARCH_DIR_NAME = "search";
export const WIRE_FILENAME = "wire.jsonl";

export const FILE_META_PREFIX = "\0meta\\file\\";
export const SESSION_META_PREFIX = "\0meta\\session\\";
export const STATS_KEY = "\0meta\\stats";

function hashPath(filePath: string): string {
  return createHash("sha256").update(filePath).digest("hex").slice(0, 32);
}

export function fileMetaKey(sessionId: string, filePath: string): string {
  return `${FILE_META_PREFIX}${sessionId}\\${hashPath(filePath)}`;
}

export function fileMetaPrefixFor(sessionId: string): string {
  return `${FILE_META_PREFIX}${sessionId}\\`;
}

export function legacyFileMetaKey(filePath: string): string {
  return FILE_META_PREFIX + hashPath(filePath);
}

export const MAX_DOC_TEXT_CHARS = 20_000;
export const WIRE_READ_CHUNK_BYTES = 1 << 20;
export const WIRE_BATCH_OPS = 1_000;
export const EMPTY_BUFFER = Buffer.alloc(0);

export interface MessageDoc {
  readonly kind: "message";
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly sessionTitle: string;
  readonly agentId: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly time: number;
  readonly turn?: number;
  readonly stepId?: string;
}

export interface TitleDoc {
  readonly kind: "title";
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly sessionTitle: string;
  readonly agentId: "";
  readonly role: "title";
  readonly text: string;
  readonly time: number;
}

export interface FileMetaDoc {
  readonly kind: "fileMeta";
  readonly sessionId: string;
  readonly agentId: string;
  readonly source: "root" | "agents";
  readonly path: string;
  readonly offset: number;
  readonly size: number;
  readonly mtimeMs?: number;
  readonly ino?: number;
  readonly turnState?: TurnCounterState;
  readonly stepState?: StepTrackerState;
}

export interface SessionMetaDoc {
  readonly kind: "sessionMeta";
}

interface TurnOpener {
  readonly turn: number;
  readonly anchor: boolean;
}

export interface TurnCounterState {
  readonly next: number;
  readonly hasTurn: boolean;
  readonly openers: readonly TurnOpener[];
}

const INITIAL_TURN_STATE: TurnCounterState = {
  next: 0,
  hasTurn: false,
  openers: [],
};

export function initialTurnState(): TurnCounterState {
  return INITIAL_TURN_STATE;
}

function applyUndoToTurnState(
  state: TurnCounterState,
  count: number,
): TurnCounterState {
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

export function advanceTurnCounter(
  state: TurnCounterState,
  effect: TurnEffect,
): { docTurn: number | undefined; state: TurnCounterState } {
  switch (effect.kind) {
    case "open":
      return {
        docTurn: state.next,
        state: {
          next: state.next + 1,
          hasTurn: true,
          openers: [
            ...state.openers,
            { turn: state.next, anchor: effect.anchor },
          ],
        },
      };
    case "ensure": {
      const next = state.hasTurn
        ? state
        : { ...state, next: state.next + 1, hasTurn: true };
      return { docTurn: next.next - 1, state: next };
    }
    case "undo":
      return {
        docTurn: undefined,
        state: applyUndoToTurnState(state, effect.count),
      };
    case "none":
      return { docTurn: undefined, state };
  }
}

export interface StepTrackerState {
  readonly byUuid: Record<string, number>;
  readonly begins: number;
}

const INITIAL_STEP_STATE: StepTrackerState = { byUuid: {}, begins: 0 };

export function initialStepState(): StepTrackerState {
  return INITIAL_STEP_STATE;
}

export function advanceStepTracker(
  state: StepTrackerState,
  effect: StepEffect,
): StepTrackerState {
  if (effect.kind !== "begin") return state;
  const begins = state.begins + 1;
  const ordinal = effect.ordinal ?? begins;
  if (state.byUuid[effect.uuid] === ordinal) return state;
  return { byUuid: { ...state.byUuid, [effect.uuid]: ordinal }, begins };
}

export interface StatsDoc {
  readonly kind: "stats";
  readonly sessions: number;
  readonly documents: number;
  readonly lastIndexedAt: number;
}

export type SearchDoc =
  | MessageDoc
  | TitleDoc
  | FileMetaDoc
  | SessionMetaDoc
  | StatsDoc;

export type IndexBatchOp<T> = {
  op: "set" | "del";
  key: string;
  value?: T;
};

export function searchIndexDir(homeDir: string): string {
  return `${homeDir}/${SEARCH_DIR_NAME}`;
}

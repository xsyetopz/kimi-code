/**
 * `search` domain — incremental wire.jsonl projection into the SQLite
 * search index.
 */

import { open, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import type { SessionSummary } from "#/app/sessionIndex/sessionIndex";

import type { SqliteSearchIndex } from "./sqliteIndex";
import {
  EMPTY_BUFFER,
  MAX_DOC_TEXT_CHARS,
  WIRE_BATCH_OPS,
  WIRE_FILENAME,
  WIRE_READ_CHUNK_BYTES,
  advanceStepTracker,
  advanceTurnCounter,
  initialStepState,
  initialTurnState,
  type FileMetaDoc,
  type IndexBatchOp,
  type MessageDoc,
  type SearchDoc,
  type StepTrackerState,
  type TurnCounterState,
} from "./searchDocs";
import { fileMetaKey, legacyFileMetaKey } from "./searchDocs";
import { analyzeWireLine } from "./wireExtract";

export interface WireFileRef {
  readonly path: string;
  readonly agentId: string;
  readonly source: "root" | "agents";
}

export async function collectWireFiles(
  sessionDir: string,
): Promise<WireFileRef[]> {
  const files: WireFileRef[] = [];
  const root = join(sessionDir, WIRE_FILENAME);
  try {
    if ((await stat(root)).isFile()) {
      files.push({ path: root, agentId: "main", source: "root" });
    }
  } catch {
    // no legacy root log
  }
  const agentsDir = join(sessionDir, "agents");
  try {
    const entries = await readdir(agentsDir, {
      recursive: true,
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isFile() || entry.name !== WIRE_FILENAME) continue;
      const path = join(entry.parentPath, entry.name);
      files.push({
        path,
        agentId: relative(agentsDir, entry.parentPath),
        source: "agents",
      });
    }
  } catch {
    // no agents dir
  }
  return files;
}

export function docKeyPrefix(sessionId: string, file: WireFileRef): string {
  return `${sessionId}/${file.agentId}/${file.source}:`;
}

export interface WireIndexHost {
  readonly disposed: boolean;
  syncReplaced: boolean;
}

export function deleteFileDocs(
  index: SqliteSearchIndex<SearchDoc>,
  meta: FileMetaDoc,
): void {
  const prefix = `${meta.sessionId}/${meta.agentId}/${meta.source}:`;
  for (const row of index.queryPrefix(prefix, { values: false })) {
    index.batch([{ op: "del", key: row.key }]);
  }
}

export function collectWireLine(
  ops: IndexBatchOp<SearchDoc>[],
  summary: SessionSummary,
  file: WireFileRef,
  line: string,
  lineOffset: number,
  counters: { turnState: TurnCounterState; stepState: StepTrackerState },
): { turnState: TurnCounterState; stepState: StepTrackerState } {
  let { turnState, stepState } = counters;
  const analysis = analyzeWireLine(line);
  const advanced = advanceTurnCounter(turnState, analysis.turn);
  if (
    analysis.turn.kind === "open" ||
    analysis.turn.kind === "undo" ||
    (analysis.turn.kind === "ensure" && !turnState.hasTurn)
  ) {
    stepState = initialStepState();
  }
  turnState = advanced.state;
  stepState = advanceStepTracker(stepState, analysis.step);
  const extracted = analysis.messages;
  for (let i = 0; i < extracted.length; i++) {
    const e = extracted[i]!;
    const stepOrdinal =
      e.stepUuid !== undefined ? stepState.byUuid[e.stepUuid] : undefined;
    const doc: MessageDoc = {
      kind: "message",
      sessionId: summary.id,
      workspaceId: summary.workspaceId,
      sessionTitle: summary.title ?? "",
      agentId: file.agentId,
      role: e.role,
      text:
        e.text.length > MAX_DOC_TEXT_CHARS
          ? e.text.slice(0, MAX_DOC_TEXT_CHARS)
          : e.text,
      time: e.time ?? summary.updatedAt,
      ...(advanced.docTurn !== undefined ? { turn: advanced.docTurn } : {}),
      ...(advanced.docTurn !== undefined && stepOrdinal !== undefined
        ? { stepId: `t${advanced.docTurn}.${stepOrdinal}` }
        : {}),
    };
    ops.push({
      op: "set",
      key: `${docKeyPrefix(summary.id, file)}${lineOffset}:${i}`,
      value: doc,
    });
  }
  return { turnState, stepState };
}

export async function syncWireFile(
  host: WireIndexHost,
  index: SqliteSearchIndex<SearchDoc>,
  summary: SessionSummary,
  file: WireFileRef,
): Promise<void> {
  let st: { size: number; mtimeMs: number; ino: number };
  try {
    st = await stat(file.path);
  } catch {
    return;
  }
  const size = st.size;
  const metaKey = fileMetaKey(summary.id, file.path);
  let meta = index.get(metaKey);
  let legacyKey: string | null = null;
  if (meta?.kind !== "fileMeta") {
    const oldKey = legacyFileMetaKey(file.path);
    const legacy = index.get(oldKey);
    if (legacy?.kind === "fileMeta") {
      meta = legacy;
      legacyKey = oldKey;
    }
  }
  const known = meta?.kind === "fileMeta" ? meta : undefined;
  let offset = known?.offset ?? 0;
  let turnState: TurnCounterState = known?.turnState ?? initialTurnState();
  let stepState: StepTrackerState = known?.stepState ?? initialStepState();
  const fileMeta = (
    nextOffset: number,
    turns: TurnCounterState,
    steps: StepTrackerState,
  ): FileMetaDoc => ({
    kind: "fileMeta",
    sessionId: summary.id,
    agentId: file.agentId,
    source: file.source,
    path: file.path,
    offset: nextOffset,
    size,
    mtimeMs: st.mtimeMs,
    ino: st.ino,
    turnState: turns,
    stepState: steps,
  });
  const legacyMeta = known !== undefined && known.stepState === undefined;
  const replacedFile = known?.ino !== undefined && known.ino !== st.ino;
  const rewrittenInPlace =
    known?.mtimeMs !== undefined &&
    size === known.offset &&
    st.mtimeMs > known.mtimeMs;
  if (size < offset || legacyMeta || replacedFile || rewrittenInPlace) {
    host.syncReplaced = true;
    deleteFileDocs(index, fileMeta(0, initialTurnState(), initialStepState()));
    offset = 0;
    turnState = initialTurnState();
    stepState = initialStepState();
  }
  if (size === offset) {
    if (
      legacyKey !== null ||
      known === undefined ||
      known.size !== size ||
      known.mtimeMs !== st.mtimeMs ||
      known.ino !== st.ino ||
      known.offset !== offset
    ) {
      const ops: IndexBatchOp<SearchDoc>[] = [
        { op: "set", key: metaKey, value: fileMeta(offset, turnState, stepState) },
      ];
      if (legacyKey !== null) ops.push({ op: "del", key: legacyKey });
      index.batch(ops);
    }
    return;
  }

  const handle = await open(file.path, "r");
  const ops: IndexBatchOp<SearchDoc>[] = [];
  let byteCursor = offset;
  try {
    let position = offset;
    let pending: Buffer = EMPTY_BUFFER;
    const chunk = Buffer.allocUnsafe(WIRE_READ_CHUNK_BYTES);
    while (position < size) {
      if (host.disposed) return;
      const { bytesRead } = await handle.read(
        chunk,
        0,
        Math.min(chunk.length, size - position),
        position,
      );
      if (bytesRead === 0) break;
      const slice = chunk.subarray(0, bytesRead);
      position += bytesRead;
      let start = 0;
      for (;;) {
        const nl = slice.indexOf(0x0a, start);
        if (nl === -1) break;
        const lineBuf =
          pending.length > 0
            ? Buffer.concat([pending, slice.subarray(start, nl)])
            : slice.subarray(start, nl);
        pending = EMPTY_BUFFER;
        const lineOffset = byteCursor;
        byteCursor += lineBuf.length + 1;
        ({ turnState, stepState } = collectWireLine(
          ops,
          summary,
          file,
          lineBuf.toString("utf8"),
          lineOffset,
          { turnState, stepState },
        ));
        start = nl + 1;
      }
      pending =
        pending.length > 0
          ? Buffer.concat([pending, slice.subarray(start)])
          : Buffer.from(slice.subarray(start));
      if (ops.length >= WIRE_BATCH_OPS) {
        index.batch(ops);
        ops.length = 0;
      }
    }
  } finally {
    await handle.close();
  }

  if (byteCursor === offset && legacyKey === null) return;
  ops.push({
    op: "set",
    key: metaKey,
    value: fileMeta(byteCursor, turnState, stepState),
  });
  if (legacyKey !== null) ops.push({ op: "del", key: legacyKey });
  index.batch(ops);
}

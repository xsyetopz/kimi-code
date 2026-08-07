import {
  type AgentTranscriptSnapshot,
  type TranscriptMarker,
  type TranscriptOperation,
  type TranscriptTaskRef,
  type TranscriptTurn,
} from "@moonshot-ai/transcript";

/**
 * Flatten a snapshot into idempotent upsert ops (turn/step/frame upserts,
 * standalone items, tasks, meta). Deliberately never a `reset`: upserts merge
 * by id and keep ordinal order, so the backfill cannot clobber live ops that
 * landed while the records were being read.
 *
 * Standalone items (markers / taskrefs) carry a `beforeTurn` placement anchor:
 * the reducer's standalone path is append-only, so without an anchor a
 * historical marker replayed after live turns arrived would land past them.
 * The anchor is the ordinal of the snapshot turn directly following the item
 * (trailing items anchor past the last snapshot turn, which is where the
 * engine's next live turn lands); a turn-anchored insert places the item
 * before the first turn with `ordinal >= beforeTurn`.
 *
 * `turnOps` customizes the per-turn flattening (the backfill passes a
 * live-first merge; the default flattens wholesale for cold reads).
 */
export function snapshotToOps(
  snapshot: AgentTranscriptSnapshot,
  turnOps: (turn: TranscriptTurn) => TranscriptOperation[] = snapshotTurnOps,
): TranscriptOperation[] {
  const ops: TranscriptOperation[] = [];
  /** Standalone items seen since the last turn, awaiting their anchor. */
  const pending: (TranscriptMarker | TranscriptTaskRef)[] = [];
  let lastTurnOrdinal: number | undefined;
  const flushPending = (beforeTurn?: number): void => {
    for (const item of pending) {
      ops.push(
        item.kind === "marker"
          ? { op: "marker.upsert", item, beforeTurn }
          : { op: "taskref.upsert", item, beforeTurn },
      );
    }
    pending.length = 0;
  };
  for (const item of snapshot.items) {
    if (item.kind === "turn") {
      flushPending(item.ordinal);
      lastTurnOrdinal = item.ordinal;
      ops.push(...turnOps(item));
    } else {
      pending.push(item);
    }
  }
  // Trailing standalone items followed the last snapshot turn in history but
  // precede the engine's next live turn (`lastTurnOrdinal + 1`, matched
  // robustly by the reducer's `>=` placement when ordinals drift).
  flushPending(lastTurnOrdinal === undefined ? undefined : lastTurnOrdinal + 1);
  for (const task of snapshot.tasks) {
    ops.push({ op: "task.upsert", task });
  }
  ops.push({ op: "meta.merge", meta: snapshot.meta });
  return ops;
}

/** One snapshot turn flattened wholesale (the cold / unseen-turn path). */
export function snapshotTurnOps(turn: TranscriptTurn): TranscriptOperation[] {
  const ops: TranscriptOperation[] = [];
  const { steps, ...header } = turn;
  ops.push({ op: "turn.upsert", turn: header });
  for (const step of steps) {
    const { frames, ...stepHeader } = step;
    ops.push({ op: "step.upsert", turnId: turn.turnId, step: stepHeader });
    for (const frame of frames) {
      ops.push({
        op: "frame.upsert",
        turnId: turn.turnId,
        stepId: step.stepId,
        frame,
      });
    }
  }
  return ops;
}

/** Post-turn heals fire this long after the last terminal turn of an agent. */
export const TURN_HEAL_DEBOUNCE_MS = 250;
export const TERMINAL_TURN_STATES: ReadonlySet<TranscriptTurn["state"]> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/**
 * Merge one persisted (snapshot) turn back into the live store after the turn
 * ended — the post-turn heal for mid-turn attaches:
 *   - turn the live store never saw: taken wholesale;
 *   - header: the snapshot is authoritative for origin/prompt (it reads the
 *     persisted user message, which a mid-turn-attached projector missed);
 *     the live header wins on state and timestamps;
 *   - steps the live turn never saw: taken wholesale from the snapshot;
 *   - existing steps: text/thinking frames are re-emitted only when the
 *     persisted text is longer and the kind matches (a fresh live frame may
 *     still be ahead of a lagging flush); tool frames are re-emitted when
 *     the live step lacks the frame or the live frame lacks the outcome the
 *     persisted one carries (a tool.result dropped in the attach race is
 *     otherwise unrecoverable until a cold rebuild) — live-only extras
 *     (display / agentRefs / approvalId) are preserved on the emitted frame;
 *   - interactions are never re-emitted: they are global entities (not step
 *     content), are not persisted as context messages, and the live kernel
 *     bridge is always richer.
 */
export function healTurnOps(
  snapshotTurn: TranscriptTurn,
  liveTurn: TranscriptTurn | undefined,
): TranscriptOperation[] {
  const { steps, ...header } = snapshotTurn;
  const ops: TranscriptOperation[] = [];
  if (liveTurn === undefined) {
    ops.push({ op: "turn.upsert", turn: header });
    for (const step of steps) {
      const { frames, ...stepHeader } = step;
      ops.push({
        op: "step.upsert",
        turnId: snapshotTurn.turnId,
        step: stepHeader,
      });
      for (const frame of frames) {
        ops.push({
          op: "frame.upsert",
          turnId: snapshotTurn.turnId,
          stepId: step.stepId,
          frame,
        });
      }
    }
    return ops;
  }
  ops.push({
    op: "turn.upsert",
    turn: {
      ...header,
      state: liveTurn.state,
      prompt: liveTurn.prompt ?? header.prompt,
      startedAt: liveTurn.startedAt ?? header.startedAt,
      endedAt: liveTurn.endedAt ?? header.endedAt,
    },
  });
  for (const step of steps) {
    const liveStep = liveTurn.steps.find(
      (entry) => entry.stepId === step.stepId,
    );
    const { frames, ...stepHeader } = step;
    if (liveStep === undefined) {
      ops.push({
        op: "step.upsert",
        turnId: snapshotTurn.turnId,
        step: stepHeader,
      });
      for (const frame of frames) {
        ops.push({
          op: "frame.upsert",
          turnId: snapshotTurn.turnId,
          stepId: step.stepId,
          frame,
        });
      }
      continue;
    }
    for (const frame of frames) {
      const liveFrame = liveStep.frames.find(
        (entry) => entry.frameId === frame.frameId,
      );
      if (frame.kind === "tool") {
        // Recover frames the live step never saw and results missed in the
        // attach race (a dropped tool.result is unrecoverable live). Live
        // frames that already carry the outcome stay untouched, and live-only
        // extras (display / agentRefs / approvalId) ride the emitted frame.
        const liveTool = liveFrame?.kind === "tool" ? liveFrame : undefined;
        const liveHasOutcome =
          liveTool !== undefined &&
          (liveTool.output !== undefined || liveTool.error !== undefined);
        const snapshotHasOutcome =
          frame.output !== undefined || frame.error !== undefined;
        if (liveTool !== undefined && (liveHasOutcome || !snapshotHasOutcome))
          continue;
        ops.push({
          op: "frame.upsert",
          turnId: snapshotTurn.turnId,
          stepId: step.stepId,
          frame:
            liveTool === undefined
              ? frame
              : {
                  ...frame,
                  display: liveTool.display ?? frame.display,
                  agentRefs: liveTool.agentRefs ?? frame.agentRefs,
                  approvalId: liveTool.approvalId ?? frame.approvalId,
                },
        });
        continue;
      }
      if (frame.kind !== "text" && frame.kind !== "thinking") continue;
      // The length shortcut only applies to the SAME frame kind: a
      // kind-mismatched live frame (the projector guessed the stream kind
      // wrong mid-turn) must be replaced by the persisted one, not skipped.
      if (
        liveFrame !== undefined &&
        liveFrame.kind === frame.kind &&
        (liveFrame.kind === "text" || liveFrame.kind === "thinking") &&
        liveFrame.text.length >= frame.text.length
      ) {
        continue;
      }
      ops.push({
        op: "frame.upsert",
        turnId: snapshotTurn.turnId,
        stepId: step.stepId,
        frame,
      });
    }
  }
  return ops;
}

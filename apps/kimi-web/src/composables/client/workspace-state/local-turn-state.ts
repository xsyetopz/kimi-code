import { queueFlushFailures } from "./shared";

const promptGenerationBySession = new Map<string, number>();
const pendingLocalTurnStarts = new Map<string, Set<number>>();
const afterLocalTurnsSettled = new Map<string, () => void>();
let nextLocalTurnToken = 0;

export interface LocalTurnStartState {
  generation: number;
  pending: boolean;
}

export function localTurnStartState(sid: string): LocalTurnStartState {
  return {
    generation: promptGenerationBySession.get(sid) ?? 0,
    pending: (pendingLocalTurnStarts.get(sid)?.size ?? 0) > 0,
  };
}

export function beginLocalTurn(sid: string): number {
  const token = ++nextLocalTurnToken;
  promptGenerationBySession.set(sid, token);
  const pending = pendingLocalTurnStarts.get(sid) ?? new Set<number>();
  pending.add(token);
  pendingLocalTurnStarts.set(sid, pending);
  return token;
}

export function settleLocalTurn(sid: string, token: number): void {
  const pending = pendingLocalTurnStarts.get(sid);
  if (pending === undefined) return;
  pending.delete(token);
  if (pending.size > 0) return;
  pendingLocalTurnStarts.delete(sid);
  const callback = afterLocalTurnsSettled.get(sid);
  afterLocalTurnsSettled.delete(sid);
  callback?.();
}

export function forgetLocalTurnState(sid: string): void {
  promptGenerationBySession.delete(sid);
  pendingLocalTurnStarts.delete(sid);
  afterLocalTurnsSettled.delete(sid);
  queueFlushFailures.delete(sid);
}

export function isLocalTurnSnapshotCurrent(
  sid: string,
  atRequest: LocalTurnStartState,
): boolean {
  return (
    !atRequest.pending &&
    atRequest.generation === (promptGenerationBySession.get(sid) ?? 0)
  );
}

export function afterLocalTurnStartsSettle(
  sid: string,
  callback: () => void,
): void {
  if ((pendingLocalTurnStarts.get(sid)?.size ?? 0) === 0) {
    callback();
    return;
  }
  afterLocalTurnsSettled.set(sid, callback);
}

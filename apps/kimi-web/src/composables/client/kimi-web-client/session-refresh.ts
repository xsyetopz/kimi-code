import { ref } from "vue";
import { getKimiWebApi } from "../../../api";
import { safeGetString, safeSetString } from "../../../lib/storage";
import type { AppGoal, AppSessionRuntimeStatus, ThinkingLevel } from "../../../api/types";
import {
  rawState,
  ONBOARDED_STORAGE_KEY,
  CONVERSATION_TOC_STORAGE_KEY,
  bumpOptimisticMsgSeq,
} from "./runtime";
import { updateSession } from "./session-mutations";
import { pushOperationFailure } from "./warnings-snapshot";


function loadConversationTocFromStorage(): boolean {
  try {
    const raw = safeGetString(CONVERSATION_TOC_STORAGE_KEY);
    return raw === null ? true : raw === "true";
  } catch {
    return true;
  }
}
function saveConversationTocToStorage(v: boolean): void {
  try {
    safeSetString(CONVERSATION_TOC_STORAGE_KEY, v ? "true" : "false");
  } catch {
    // ignore
  }
}
export const conversationToc = ref<boolean>(loadConversationTocFromStorage());

function loadStringFromStorage(key: string): string {
  try {
    return safeGetString(key) ?? "";
  } catch {
    return "";
  }
}
export const onboarded = ref<boolean>(
  loadStringFromStorage(ONBOARDED_STORAGE_KEY) === "1",
);
export async function refreshSessionStatus(sessionId: string): Promise<void> {
  let st: AppSessionRuntimeStatus;
  try {
    st = await getKimiWebApi().getSessionStatus(sessionId);
  } catch {
    return; // status endpoint missing/unreachable — keep what we have.
  }
  updateSession(sessionId, (s) => ({
    ...s,
    model: st.model || s.model,
    usage: {
      ...s.usage,
      contextTokens: st.contextTokens,
      contextLimit: st.maxContextTokens,
    },
  }));
  rawState.swarmModeBySession = {
    ...rawState.swarmModeBySession,
    [sessionId]: st.swarmMode,
  };
  rawState.planModeBySession = {
    ...rawState.planModeBySession,
    [sessionId]: st.planMode,
  };
  // Fold the session's own thinking level too — per-session state wins over the
  // per-model storage pick (see thinkingBySession on ExtendedState).
  if (st.thinkingEffort.length > 0) {
    rawState.thinkingBySession = {
      ...rawState.thinkingBySession,
      [sessionId]: st.thinkingEffort as ThinkingLevel,
    };
  }
}

/**
 * Fetch GET /sessions/{id}/goal and fold the result into goalBySession — the
 * recovery channel for the goal card after a full-page reload (the snapshot +
 * WS-replay path never carries the historical `goal.updated`, since its seq is
 * ≤ the snapshot watermark). Never throws — an old daemon without the /goal
 * endpoint keeps any live-event state.
 */
export async function refreshSessionGoal(sessionId: string): Promise<void> {
  // A live `goal.updated` arriving during the request is newer than whatever
  // the server read when handling it — never let this recovery write override
  // such an event (it would resurrect a finished goal until the next reload).
  // Track the per-session goal event version, not the goal entry itself:
  // clear/complete events DELETE the entry, which would leave an
  // undefined === undefined comparison blind to exactly the race that matters.
  const versionBefore = rawState.goalVersionBySession[sessionId] ?? 0;
  let goal: AppGoal | null;
  try {
    goal = await getKimiWebApi().getSessionGoal(sessionId);
  } catch {
    return; // goal endpoint missing/unreachable — keep what we have.
  }
  if ((rawState.goalVersionBySession[sessionId] ?? 0) !== versionBefore) {
    return; // a live goal event won the race
  }
  // Mirror the reducer's goalUpdated branch: null (or a completed goal) clears
  // the card, anything else replaces it.
  const nextGoals = { ...rawState.goalBySession };
  if (goal === null || goal.status === "complete") delete nextGoals[sessionId];
  else nextGoals[sessionId] = goal;
  rawState.goalBySession = nextGoals;
}

/** Persist runtime controls to a session via POST /profile, then re-read
 *  /status. `sessionId` overrides the active session — used when creating a
 *  session and immediately persisting its draft modes, so a concurrent session
 *  switch can't write the patch to the wrong session.
 *
 *  Resolves false when the daemon did not apply the patch (also surfaced via
 *  pushOperationFailure — the UI already updated optimistically, so the user
 *  must be told); true on success. Most callers fire-and-forget via
 *  `void persistSessionProfile(...)`; call sites that must order strictly
 *  after the profile (e.g. a skill activation that can't carry its own modes)
 *  await it and must NOT proceed on false — awaiting alone enforces nothing,
 *  since the promise never rejects. */
export function persistSessionProfile(
  patch: {
    model?: string;
    permissionMode?: string;
    planMode?: boolean;
    swarmMode?: boolean;
    goalObjective?: string;
    goalControl?: "pause" | "resume" | "cancel";
    thinking?: string;
  },
  sessionId?: string,
): Promise<boolean> {
  const sid = sessionId ?? rawState.activeSessionId;
  if (!sid) return Promise.resolve(false);
  // Promise.resolve wrap: tolerate a sync/undefined return (e.g. test mocks).
  return Promise.resolve(getKimiWebApi().updateSession(sid, patch))
    .then(() => refreshSessionStatus(sid))
    .then(() => true)
    .catch((err) => {
      // Local state already reflects the change; tell the user (and the log)
      // that the daemon did not persist it.
      pushOperationFailure("persistSessionProfile", err, { sessionId: sid });
      return false;
    });
}

export function setConversationToc(v: boolean): void {
  conversationToc.value = v;
  saveConversationTocToStorage(v);
}

export function setOnboarded(done: boolean): void {
  onboarded.value = done;
  try {
    safeSetString(ONBOARDED_STORAGE_KEY, done ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export function nextOptimisticMsgId(): string {
  const seq = bumpOptimisticMsgSeq();
  return `msg_opt_${Date.now().toString(36)}_${seq}`;
}

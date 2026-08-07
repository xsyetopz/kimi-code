import { getKimiWebApi } from "../../../api";
import { i18n } from "../../../i18n";
import { useConfirmDialog } from "../../useConfirmDialog";
import { isDaemonApiError } from "../../../api/errors";
import { SERVER_AUTH_UNAUTHORIZED_CODE } from "../../../api/daemon/http";
import { isPlaceholderSessionUsage } from "../../../api/daemon/mappers";
import type {
  AppConfig,
  AppInFlightTurn,
  AppMessage,
  AppSession,
  AppWorkspace,
  ApprovalDecision,
  ApprovalResponse,
  FsEntry,
  KimiEventConnection,
  QuestionResponse,
} from "../../../api/types";
import {
  loadWorkspaceNameOverrides,
  safeRemove,
  saveWorkspaceNameOverrides,
  STORAGE_KEYS,
} from "../../../lib/storage";
import { parseDiff } from "../../../lib/parseDiff";
import { workspaceRootKey } from "../../../lib/rootKey";
import { sessionExportTraceToJsonl, traceKeyEvent } from "../../../debug/trace";
import { readSessionIdFromLocation, sessionUrl } from "../../../lib/sessionRoute";
import type { SessionUrlMode } from "../../../lib/sessionRoute";
import type {
  ActivityState,
  ConversationStatus,
  DiffViewLine,
  PermissionMode,
  WorkspaceView,
} from "../../../types";
import type { ExtendedState, PromptAttachment } from "../kimi-web-client/types";
import type { UseWorkspaceStateDeps } from "./types";
import type { WorkspaceStateCtx } from "./context";
import {
  beginLocalTurn,
  settleLocalTurn,
  localTurnStartState,
  isLocalTurnSnapshotCurrent,
  afterLocalTurnStartsSettle,
} from "./local-turn-state";
import {
  MESSAGES_PAGE_SIZE,
  SESSIONS_INITIAL_PAGE_SIZE,
  PROMPT_NOT_FOUND_CODE,
  WORKSPACE_NOT_FOUND_CODE,
  ALREADY_RESOLVED_CODE,
  FIRST_LOAD_AUTH_RETRY_MS,
  TASK_ALREADY_FINISHED_CODE,
  MAX_QUEUE_FLUSH_FAILURES,
  isAlreadyResolvedError,
  isTaskAlreadyFinishedError,
  pendingQuestionActions,
  pendingApprovalActions,
  pendingTaskCancellations,
  startingFirstPromptWorkspaces,
  queueFlushFailures,
  nextQueueEntryId,
  type AuthCheckResult,
} from "./shared";

export function createPromptQueueActions(
  rawState: ExtendedState,
  deps: UseWorkspaceStateDeps,
  ctx: WorkspaceStateCtx,
) {
  const { t } = i18n.global;
  const { confirm } = useConfirmDialog();
  const {
    taskPoller,
    sideChat,
    modelProvider,
    pushOperationFailure,
    activity,
    sessionsKnownEmpty,
    setSessions,
    updateSession,
    upsertSessionFront,
    appendSession,
    forgetSession,
    setActiveSessionId,
    updateSessionMessages,
    nextOptimisticMsgId,
    getEventConn,
    syncSessionFromSnapshot,
    reopenSession,
    hasLoadedMessages,
    refreshSessionStatus,
    refreshSessionGoal,
    persistSessionProfile,
    mergedWorkspaces,
    workspacesView,
    status,
    workspaceIdForSession,
    savePermissionToStorage,
    savePlanModeToStorage,
    saveSwarmModeToStorage,
    saveGoalModeToStorage,
    draftModes,
    saveUnread,
    saveActiveWorkspaceToStorage,
    saveHiddenWorkspacesToStorage,
    goalErrorMessage,
    resetFastMoon,
    initialized,
    connectIssue,
    selectedDiffPath,
    fileDiffLines,
    fileDiffLoading,
  } = deps;
  let exportInFlight = false;

  function enqueue(text: string, attachments?: PromptAttachment[]): void {
    const sid = rawState.activeSessionId;
    if (!sid) return;
    const current = rawState.queuedBySession[sid] ?? [];
    // The id keys the per-entry flush failure budget (removing/reordering
    // the head then resets the next entry's budget).
    const entry = { text, attachments, id: nextQueueEntryId() };
    rawState.queuedBySession = {
      ...rawState.queuedBySession,
      [sid]: [...current, entry],
    };
  }

  /**
   * Submit the head of the session's local prompt queue. On failure the
   * entry goes back at the head with NO immediate retry — the daemon that
   * just rejected it is the one we'd race against (e.g. right after an
   * abort); the next turn end or the next idle sendPrompt drives the next
   * attempt. After MAX_QUEUE_FLUSH_FAILURES consecutive failures the entry
   * is dropped instead, so one permanently rejected prompt cannot wedge the
   * queue. The budget is tracked PER ENTRY (by id), so removing or
   * reordering the head resets it for the next entry. Every failure is
   * already surfaced via pushOperationFailure.
   */
  function flushQueueHead(sid: string): void {
    const [next, ...rest] = rawState.queuedBySession[sid] ?? [];
    if (next === undefined) return;
    rawState.queuedBySession = { ...rawState.queuedBySession, [sid]: rest };
    void ctx.submitPromptInternal(sid, next.text, next.attachments).then(
      (outcome: "ok" | "rejected" | "uncertain") => {
        if (outcome === "ok") {
          queueFlushFailures.delete(sid);
          return;
        }
        // Ambiguous failure: the daemon may have accepted the prompt and lost
        // the response — the entry is dropped (the failure was already toasted)
        // rather than re-queued and possibly submitted twice.
        if (outcome === "uncertain") {
          queueFlushFailures.delete(sid);
          return;
        }
        // Definitively rejected below this point. If the session was forgotten
        // (e.g. archived) while the submit was pending, its queue was already
        // discarded — don't resurrect it.
        if (!rawState.sessions.some((s) => s.id === sid)) {
          queueFlushFailures.delete(sid);
          return;
        }
        // Per-entry budget: a different head (removed/reordered since) starts
        // fresh instead of inheriting the previous entry's failures.
        const key = next.id ?? next.text;
        const previous = queueFlushFailures.get(sid);
        const count =
          previous !== undefined && previous.key === key
            ? previous.count + 1
            : 1;
        if (count >= MAX_QUEUE_FLUSH_FAILURES) {
          queueFlushFailures.delete(sid);
          // Advance the queue instead of stranding the entries behind the
          // dropped head: the failed submit produced no turn, so nothing else
          // will drive the next entry until the user sends again. The new head
          // carries its own budget, so a poisoned successor just goes through
          // the same retry cycle.
          if ((rawState.queuedBySession[sid]?.length ?? 0) > 0) {
            ctx.flushQueueHead(sid);
          }
          return;
        }
        queueFlushFailures.set(sid, { key, count });
        const current = rawState.queuedBySession[sid] ?? [];
        rawState.queuedBySession = {
          ...rawState.queuedBySession,
          [sid]: [next, ...current],
        };
      },
    );
  }

  /**
   * Shared prompt-finish cleanup, used by BOTH the main-turn-ended path
   * (facade `onMainTurnEnd`) and the authoritative-snapshot path
   * (handleSessionSnapshot below). Returns whether this call actually flipped
   * an in-flight prompt to finished.
   *
   * Clears the local in-flight/prompt-id state and drains exactly ONE
   * queued message — the resubmitted prompt re-arms the in-flight flag, and
   * its own finish drains the following one. Repeat calls (e.g. a late
   * duplicate idle event) therefore cannot drain more than one message per
   * real turn end. Callers layer their own side effects (notify, sound,
   * unread) on top; the snapshot path deliberately adds none.
   *
   * The drain is GATED on this client having actually witnessed a live
   * prompt/turn: a finish with no local in-flight prompt, no locally
   * tracked active turn, and no `turnWasActive` hint must NOT submit
   * queued prompts. That is what fired stale queued messages (and their
   * old file attachments) spontaneously when a session was merely
   * re-opened after an earlier drain had failed.
   */
  function finishPromptLocal(
    sid: string,
    opts?: { turnWasActive?: boolean },
  ): boolean {
    const wasInFlight = rawState.inFlightBySession[sid] === true;
    rawState.inFlightBySession = {
      ...rawState.inFlightBySession,
      [sid]: false,
    };
    // Drop any cached prompt_id so a later skill activation (which has no
    // prompt_id) doesn't accidentally reuse this stale id for :abort.
    if (rawState.promptIdBySession[sid] !== undefined) {
      const nextPromptIds = { ...rawState.promptIdBySession };
      delete nextPromptIds[sid];
      rawState.promptIdBySession = nextPromptIds;
    }
    if (sid === rawState.activeSessionId) {
      resetFastMoon();
    }

    const mayDrain =
      wasInFlight ||
      opts?.turnWasActive === true ||
      (rawState.turnActiveBySession[sid] ?? false);
    if (mayDrain) {
      ctx.flushQueueHead(sid);
    }

    return wasInFlight;
  }

  /**
   * Snapshot-driven finish. An authoritative snapshot replaces the event
   * stream on resync (buffer overflow / epoch change / delta gap): no
   * sessionStatusChanged event arrives in that case, so without this the
   * local in-flight flag would stick forever — the moon keeps spinning and
   * the next prompt queues behind a turn that already ended.
   *
   * Unlike the WS path this adds NO completion side effects (no notification,
   * sound, or unread): opening a historical session must not cry wolf. The
   * queue drain inside finishPromptLocal is additionally gated on a locally
   * witnessed prompt/turn, so merely re-opening a session can never
   * spontaneously submit queued prompts (with their stale attachments).
   */
  function handleSessionSnapshot(
    sid: string,
    snapshot: { inFlightTurn: AppInFlightTurn | null; busy: boolean },
  ): void {
    // inFlightTurn tracks only the main agent, while busy aggregates all
    // agents and background work. Keep the local prompt alive only when both
    // facts still support a running main turn. Either terminal fact may also
    // reconcile the other tracker when a snapshot catches it stale.
    if (snapshot.inFlightTurn !== null && snapshot.busy) return;
    finishPromptLocal(sid);
  }

  async function abortCurrentPrompt(): Promise<void> {
    const sid = rawState.activeSessionId;
    if (!sid) return;
    const session = rawState.sessions.find((s) => s.id === sid);

    // 1. Authoritative id captured at submit time.
    let promptId = rawState.promptIdBySession[sid];

    // 2. Fallback to projector-derived id only when it is a real daemon prompt_id.
    //    The v1 daemon uses `prompt_...`, server-v2 legacy uses `msg_...`;
    //    only local synthetic `pr_...` ids are rejected by the daemon.
    if (promptId === undefined) {
      const candidate = session?.currentPromptId;
      if (
        candidate !== undefined &&
        candidate.length > 0 &&
        !candidate.startsWith("pr_")
      ) {
        promptId = candidate;
      }
    }

    const api = getKimiWebApi();

    // 3. If we have a real id, try the per-prompt abort first. If the daemon
    //    reports the prompt is missing/already completed, clear the stale id and
    //    fall back to session-level abort for whatever is currently running.
    if (promptId !== undefined) {
      try {
        const result = await api.abortPrompt(sid, promptId);
        if (result.aborted) return;
        const nextPromptIds = { ...rawState.promptIdBySession };
        delete nextPromptIds[sid];
        rawState.promptIdBySession = nextPromptIds;
      } catch (err) {
        if (isDaemonApiError(err) && err.code === PROMPT_NOT_FOUND_CODE) {
          // Stale id — try the session-level fallback below.
          const nextPromptIds = { ...rawState.promptIdBySession };
          delete nextPromptIds[sid];
          rawState.promptIdBySession = nextPromptIds;
        } else {
          pushOperationFailure("abortCurrentPrompt", err, { sessionId: sid });
          return;
        }
      }
    }

    // 4. No real id, or the prompt id is no longer recognized: cancel whatever
    //    is running in the session (including skill activations).
    try {
      await api.abortSession(sid);
    } catch (err) {
      pushOperationFailure("abortCurrentPrompt", err, { sessionId: sid });
    }
  }

  return {
    enqueue,
    flushQueueHead,
    finishPromptLocal,
    handleSessionSnapshot,
    abortCurrentPrompt,
  };
}

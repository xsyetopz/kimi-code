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

export function createPromptSubmitActions(
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

  async function submitPromptInternal(
    sid: string,
    text: string,
    attachments?: PromptAttachment[],
  ): Promise<"ok" | "rejected" | "uncertain"> {
    // Mark this session as having a prompt in flight BEFORE any await, so a racing
    // sendPrompt sees it and enqueues. Cleared when the main turn ends (or the
    // prompt dies without one). beginLocalTurn also bumps the snapshot generation
    // and marks the submit pending, so a racing terminal snapshot can't clear
    // this prompt (see handleSessionSnapshot).
    const localTurnToken = beginLocalTurn(sid);
    rawState.inFlightBySession = { ...rawState.inFlightBySession, [sid]: true };
    const tempId = nextOptimisticMsgId();
    try {
      const api = getKimiWebApi();
      const content: import("../../../api/types").AppMessageContent[] = [];
      if (text) content.push({ type: "text", text });
      for (const att of attachments ?? []) {
        if (att.kind === "video")
          content.push({
            type: "video",
            source: { kind: "file", fileId: att.fileId },
          });
        else if (att.kind === "file") {
          content.push({
            type: "file",
            fileId: att.fileId,
            name: att.name ?? "",
            mediaType: att.mediaType || "application/octet-stream",
            size: att.size ?? 0,
          });
        } else
          content.push({
            type: "image",
            source: { kind: "file", fileId: att.fileId },
          });
      }
      if (content.length === 0) {
        rawState.inFlightBySession = {
          ...rawState.inFlightBySession,
          [sid]: false,
        };
        return "rejected";
      }

      // OPTIMISTICALLY add the user message to local state BEFORE awaiting the
      // submit.  The real daemon does NOT emit a user-message event over WS, so
      // without this the user's own text never appears in the transcript.
      const optimisticMsg: AppMessage = {
        id: tempId,
        sessionId: sid,
        role: "user",
        content,
        createdAt: new Date().toISOString(),
        metadata: { "kimiWeb.optimisticUserMessage": true },
      };
      updateSessionMessages(sid, (msgs) => [...msgs, optimisticMsg]);

      // The daemon now requires `model` + `thinking` on every prompt. Resolve the
      // model from the session (falls back to the daemon's default_model) and the
      // thinking level from the user's setting.
      const promptSession = rawState.sessions.find((s) => s.id === sid);
      const model =
        (promptSession?.model && promptSession.model.length > 0
          ? promptSession.model
          : rawState.defaultModel) ?? undefined;

      // Modes are per-session: read this session's own toggles (not the global
      // active-session value), so a prompt enqueued for a background session uses
      // that session's settings.
      const planMode = rawState.planModeBySession[sid] ?? false;
      const swarmMode = rawState.swarmModeBySession[sid] ?? false;
      const goalMode = rawState.goalModeBySession[sid] ?? false;

      if (goalMode && text) {
        try {
          await api.updateSession(sid, { goalObjective: text.trim() });
        } catch (err) {
          pushOperationFailure("createGoal", err, { sessionId: sid });
          rawState.inFlightBySession = {
            ...rawState.inFlightBySession,
            [sid]: false,
          };
          updateSessionMessages(sid, (msgs) =>
            msgs.some((m) => m.id === tempId)
              ? msgs.filter((m) => m.id !== tempId)
              : msgs,
          );
          return "rejected";
        }
      }

      const result = await api.submitPrompt(sid, {
        content,
        model,
        // Resolved against THIS prompt's session + model: the session's own
        // daemon-reported level when declared, else the model's stored pick or
        // catalog default — never the active-session rawState.thinking, which
        // tracks whatever session the user is looking at now: a queue drain for
        // a background session would otherwise submit the level of the session
        // the user switched to since enqueueing.
        thinking:
          (await modelProvider.resolveThinkingForPrompt(sid, model)) ??
          rawState.thinking,
        permissionMode: rawState.permission,
        planMode,
        swarmMode,
      });

      // Goal mode is a one-shot flag: consumed by this send, then cleared.
      if (goalMode) {
        rawState.goalModeBySession = {
          ...rawState.goalModeBySession,
          [sid]: false,
        };
        saveGoalModeToStorage();
      }

      // Authoritative prompt_id for :abort — race-free (the projector binding can
      // lose to a fast turn.started and synthesize a `pr_…` id the daemon rejects).
      rawState.promptIdBySession = {
        ...rawState.promptIdBySession,
        [sid]: result.promptId,
      };

      // Reconcile without changing the id: ChatPane keys user turns by message id,
      // so replacing msg_opt_* with userMessageId remounts the bubble and flickers.
      // If a daemon/stub later echoes the user message, the reducer merges it into
      // this optimistic entry instead of appending a duplicate.
      updateSessionMessages(sid, (msgs) => {
        const idx = msgs.findIndex((m) => m.id === tempId);
        if (idx === -1) return msgs;
        const updated = [...msgs];
        updated[idx] = {
          ...updated[idx]!,
          promptId: updated[idx]!.promptId ?? result.promptId,
        };
        return updated;
      });

      // Bind the real daemon prompt_id into the event projector so the upcoming
      // turn.started stamps this turn's messages with it (instead of a synthetic
      // pr_ id the daemon rejects on :abort). Stop's authoritative prompt_id
      // comes from the submit response above and the daemon's
      // event.session.status_changed — this binding is for transcript grouping.
      getEventConn()?.bindNextPromptId(sid, result.promptId);

      // NOTE: we no longer set a local auto-title here. The daemon generates a
      // smarter title from the first prompt and announces it via
      // session.meta.updated (projected to sessionMetaUpdated). PATCHing a title
      // locally would mark the session isCustomTitle=true and SUPPRESS the
      // daemon's auto-title, so we let the daemon own it.
      return "ok";
    } catch (err) {
      // Submit failed — clear the in-flight flag so the next prompt isn't stuck
      // queued forever (turn.ended will never arrive), and roll back the
      // optimistic user message so the transcript doesn't show a delivered-
      // looking message the daemon never received. A structured API error is a
      // definitive refusal; anything else (network, truncated response) is
      // ambiguous — the prompt may already sit in the server's queue.
      rawState.inFlightBySession = {
        ...rawState.inFlightBySession,
        [sid]: false,
      };
      updateSessionMessages(sid, (msgs) =>
        msgs.some((m) => m.id === tempId)
          ? msgs.filter((m) => m.id !== tempId)
          : msgs,
      );
      pushOperationFailure("sendPrompt", err, { sessionId: sid });
      return isDaemonApiError(err) ? "rejected" : "uncertain";
    } finally {
      // The daemon answered the submit (accepted or rejected) — the pending
      // window in which a snapshot can't reflect this turn is over.
      settleLocalTurn(sid, localTurnToken);
    }
  }

  async function sendPrompt(
    text: string,
    attachments?: PromptAttachment[],
  ): Promise<void> {
    const sid = rawState.activeSessionId;
    if (!sid) return;

    // If the session is not idle OR a prompt is already in flight (submitted but
    // the WS turn.started hasn't arrived yet), enqueue instead of submitting
    // directly. The in-flight flag closes the window where two rapid prompts
    // would both submit and race.
    if (activity.value !== "idle" || rawState.inFlightBySession[sid]) {
      ctx.enqueue(text, attachments);
      return;
    }

    // The queue should be empty by the time the session is idle, so a
    // non-empty queue means earlier prompts never made it out (e.g. a drain
    // that raced a still-busy daemon right after an abort). Preserve FIFO:
    // enqueue this prompt behind them and flush the head now — the flush
    // re-arms the in-flight flag, and each later turn end drains the next
    // entry. Submitting directly here would jump the queue AND leave the
    // stuck entries without a flush driver.
    if ((rawState.queuedBySession[sid]?.length ?? 0) > 0) {
      ctx.enqueue(text, attachments);
      ctx.flushQueueHead(sid);
      return;
    }

    await submitPromptInternal(sid, text, attachments);
  }

  /**
   * steerPrompt() — TUI ctrl+s parity: merge any locally queued prompts with the
   * live composer text and inject the result into the RUNNING turn instead of
   * waiting for it to finish. Two-step against the daemon: submit (parks the
   * prompt behind the active one) then POST /prompts:steer. Falls back to a
   * normal send when the session is idle.
   */
  async function steerPrompt(
    text: string,
    attachments?: PromptAttachment[],
  ): Promise<void> {
    const sid = rawState.activeSessionId;
    if (!sid) return;

    // Merge queued texts (oldest first) + the live text, like the TUI does.
    const queue = rawState.queuedBySession[sid] ?? [];
    const parts: string[] = [];
    const mergedAttachments: PromptAttachment[] = [];
    for (const q of queue) {
      const trimmed = q.text.trim();
      if (trimmed) parts.push(trimmed);
      if (q.attachments?.length) mergedAttachments.push(...q.attachments);
    }
    const live = text.trim();
    if (live) parts.push(live);
    if (attachments?.length) mergedAttachments.push(...attachments);
    if (parts.length === 0 && mergedAttachments.length === 0) return;
    if (queue.length > 0) {
      rawState.queuedBySession = { ...rawState.queuedBySession, [sid]: [] };
    }
    const merged = parts.join("\n\n");

    // Put back every entry that was merged into this steer when its submit
    // fails, so the queued prompts aren't silently lost. Entries enqueued
    // while the submit was in flight stay behind them.
    const restoreQueue = (): void => {
      if (queue.length === 0) return;
      const current = rawState.queuedBySession[sid] ?? [];
      rawState.queuedBySession = {
        ...rawState.queuedBySession,
        [sid]: [...queue, ...current],
      };
    };

    // Idle and nothing in flight — there is no turn to steer into; normal send.
    if (activity.value === "idle" && !rawState.inFlightBySession[sid]) {
      const outcome = await submitPromptInternal(
        sid,
        merged,
        mergedAttachments,
      );
      // Same never-duplicate rule as the running-path catch below: restore
      // the merged entries only on a definitive rejection.
      if (outcome === "rejected") restoreQueue();
      return;
    }

    // Optimistic transcript echo (the daemon emits no user-message WS event).
    const content: import("../../../api/types").AppMessageContent[] = [];
    if (merged) content.push({ type: "text", text: merged });
    for (const att of mergedAttachments) {
      if (att.kind === "video")
        content.push({
          type: "video",
          source: { kind: "file", fileId: att.fileId },
        });
      else if (att.kind === "file") {
        content.push({
          type: "file",
          fileId: att.fileId,
          name: att.name ?? "",
          mediaType: att.mediaType || "application/octet-stream",
          size: att.size ?? 0,
        });
      } else
        content.push({
          type: "image",
          source: { kind: "file", fileId: att.fileId },
        });
    }
    const tempId = nextOptimisticMsgId();
    const optimisticMsg: AppMessage = {
      id: tempId,
      sessionId: sid,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
      metadata: { "kimiWeb.optimisticUserMessage": true },
    };
    updateSessionMessages(sid, (msgs) => [...msgs, optimisticMsg]);

    const localTurnToken = beginLocalTurn(sid);
    try {
      const api = getKimiWebApi();
      const promptSession = rawState.sessions.find((s) => s.id === sid);
      const model =
        (promptSession?.model && promptSession.model.length > 0
          ? promptSession.model
          : rawState.defaultModel) ?? undefined;
      const result = await api.submitPrompt(sid, {
        content,
        model,
        // Resolved against this prompt's own session + model, same as a normal
        // send (see submitPromptInternal).
        thinking:
          (await modelProvider.resolveThinkingForPrompt(sid, model)) ??
          rawState.thinking,
        permissionMode: rawState.permission,
        planMode: rawState.planModeBySession[sid] ?? false,
        swarmMode: rawState.swarmModeBySession[sid] ?? false,
      });

      // Stamp the real prompt_id onto the optimistic echo. Unlike a normal send,
      // a steered prompt IS echoed back by the daemon as a messageCreated user
      // event; matching that echo by prompt_id (instead of content) is what keeps
      // an image steer from rendering two user bubbles.
      updateSessionMessages(sid, (msgs) => {
        const idx = msgs.findIndex((m) => m.id === tempId);
        if (idx === -1) return msgs;
        const updated = [...msgs];
        updated[idx] = {
          ...updated[idx]!,
          promptId: updated[idx]!.promptId ?? result.promptId,
        };
        return updated;
      });

      if (result.status !== "queued") {
        // The turn ended while the user was typing — the prompt started a turn
        // of its own. Wire it up like a regular send so :abort keeps working.
        rawState.promptIdBySession = {
          ...rawState.promptIdBySession,
          [sid]: result.promptId,
        };
        getEventConn()?.bindNextPromptId(sid, result.promptId);
        return;
      }

      try {
        await api.steerPrompts(sid, [result.promptId]);
      } catch {
        // The active turn finished between submit and steer — the daemon starts
        // the parked prompt as its own turn. Nothing to roll back.
      }
    } catch (err) {
      // Submit failed: drop the optimistic echo so the transcript doesn't show
      // a delivered-looking message the daemon never received.
      updateSessionMessages(sid, (msgs) => msgs.filter((m) => m.id !== tempId));
      // Restore the merged queue entries ONLY on a definitive daemon rejection
      // (a structured API error means nothing was accepted). On an ambiguous
      // failure — dropped response, network error — the merged prompt may
      // already be queued server-side; re-queueing the originals would
      // duplicate it (the exact ghost-send behavior this change exists to
      // prevent). The failure toast below tells the user what happened.
      if (isDaemonApiError(err)) restoreQueue();
      pushOperationFailure("steer", err, { sessionId: sid });
    } finally {
      settleLocalTurn(sid, localTurnToken);
    }
  }

  /**
   * Upload an image file to the daemon's /api/v1/files endpoint.
   * Returns { fileId, name, mediaType } on success, or null on error (warning added to state).
   */
  async function uploadImage(
    file: Blob,
    name?: string,
  ): Promise<{ fileId: string; name: string; mediaType: string } | null> {
    try {
      const api = getKimiWebApi();
      const result = await api.uploadFile({ file, name });
      return {
        fileId: result.id,
        name: result.name,
        mediaType: result.mediaType,
      };
    } catch (err) {
      pushOperationFailure("uploadImage", err);
      return null;
    }
  }

  /** Enqueue a message for the active session; flushed when activity returns to idle */
  return {
    submitPromptInternal,
    sendPrompt,
    steerPrompt,
    uploadImage,
  };
}

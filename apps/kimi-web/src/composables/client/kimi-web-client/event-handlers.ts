import type { AppEvent, KimiEventMeta } from "../../../api/types";
import { rawState, appearance, sideChat, workspaceState } from "./runtime";
import { applyEvent } from "./event-reducer";
import {
  onMainTurnEnd,
  onQuestionRequested,
  onApprovalRequested,
  clearWorkingFlags,
} from "./turn-notifications";

export function processEvent(appEvent: AppEvent, meta: KimiEventMeta): void {
  // Capture BEFORE applyEvent advances lastSeqBySession: turn-end side
  // effects below only run when this event actually moves the durable cursor
  // forward. A late duplicate idle (e.g. replayed after a snapshot already
  // advanced past it) must not drain a second queued message.
  const prevSeq = rawState.lastSeqBySession[meta.sessionId] ?? 0;
  const wasMainTurnActive =
    rawState.turnActiveBySession[meta.sessionId] ?? false;
  // meta carries wire-level seq/sessionId so the reducer can advance
  // lastSeqBySession[sessionId] = seq. Compaction completion appends a
  // persistent divider marker in the reducer (TUI parity: the scrollback
  // is kept, only a marker line records the compaction).
  applyEvent(appEvent, meta.sessionId, meta.seq);

  const sideTarget = sideChat!.sideChatTargetBySession.value[meta.sessionId];
  if (sideTarget) {
    const { agentId } = sideTarget;
    const parentId = meta.sessionId;
    if (appEvent.type === "agentDelta" && appEvent.agentId === agentId) {
      if (appEvent.delta.text) {
        sideChat!.appendSideChatAssistantText(
          agentId,
          parentId,
          appEvent.delta.text,
        );
      }
    } else if (
      appEvent.type === "agentTurnEnded" &&
      appEvent.agentId === agentId
    ) {
      sideChat!.finishSideChatAgent(agentId, parentId);
    } else if (
      appEvent.type === "taskProgress" &&
      appEvent.taskId === agentId
    ) {
      sideChat!.appendSideChatAssistantText(
        agentId,
        parentId,
        appEvent.outputChunk,
      );
    } else if (
      appEvent.type === "taskCompleted" &&
      appEvent.taskId === agentId
    ) {
      sideChat!.finishSideChatAgent(agentId, parentId, appEvent.outputPreview);
    }
  }

  // The daemon's prompt.submitted event is projected as a user messageCreated
  // carrying the real prompt_id. When the HTTP submit response is lost
  // (timeout / network error) this is the fallback that lets Stop work.
  if (
    appEvent.type === "messageCreated" &&
    appEvent.message.role === "user" &&
    appEvent.message.promptId !== undefined
  ) {
    const sid = appEvent.message.sessionId;
    if (rawState.promptIdBySession[sid] !== appEvent.message.promptId) {
      rawState.promptIdBySession = {
        ...rawState.promptIdBySession,
        [sid]: appEvent.message.promptId,
      };
    }
  }

  if (
    appEvent.type === "assistantDelta" &&
    meta.sessionId === rawState.activeSessionId
  ) {
    appearance.recordMoonDelta(
      (appEvent.delta.text?.length ?? 0) +
        (appEvent.delta.thinking?.length ?? 0),
    );
  }

  // Prompt-end cleanup. The MAIN agent's turn boundary is the authoritative
  // "the prompt is done" signal: it drives the in-flight/moon cleanup, the
  // queued-message drain, and the completion side effects. The session may
  // stay busy afterwards (background subagents / BTW) — that must NOT hold
  // any of these. The session's idle/aborted status is only a fallback quiet
  // signal (a turn.ended can be lost on abrupt agent disposal): it clears the
  // boolean liveness flags, but drain/notify stay single-owned by the
  // turn-boundary path. Both are gated on the durable cursor advancing so a
  // late duplicate cannot fire twice.
  if (
    appEvent.type === "turnActiveChanged" &&
    !appEvent.active &&
    meta.seq > prevSeq
  ) {
    const reason = appEvent.reason;
    // wasMainTurnActive was captured BEFORE the reducer consumed this event
    // (the reducer clears turnActiveBySession on turn end), so it is the only
    // remaining signal that this client witnessed a live turn — pass it down
    // so finishPromptLocal may drain queued prompts behind a turn the user
    // actually watched (including one started by another client).
    onMainTurnEnd(
      appEvent.sessionId,
      reason === "cancelled" || reason === "failed" || reason === "blocked"
        ? "aborted"
        : "idle",
      wasMainTurnActive,
    );
  }

  if (
    appEvent.type === "sessionWorkChanged" &&
    ((appEvent.mainTurnActive === false && wasMainTurnActive) ||
      (appEvent.mainTurnActive === undefined && !appEvent.busy)) &&
    meta.seq > prevSeq
  ) {
    clearWorkingFlags(appEvent.sessionId);
  }

  // A prompt that never produced a turn gets no turn.ended and no session
  // status flip: a QUEUED prompt aborted before launch (prompt.aborted), or a
  // prompt blocked by a pre-submit hook (prompt.completed with reason
  // 'blocked'). Without this the local in-flight flag — and the working moon —
  // would stick forever. Keyed on the promptId captured at submit: a normal
  // turn's prompt.completed/aborted arrives AFTER its status_changed (which
  // already cleared the id), so it no-ops; another client's prompt never
  // matches. Only fires when the event moves the durable cursor forward, same
  // as the status path above.
  if (
    (appEvent.type === "promptAborted" ||
      (appEvent.type === "promptCompleted" && appEvent.reason === "blocked")) &&
    meta.seq > prevSeq &&
    rawState.promptIdBySession[appEvent.sessionId] === appEvent.promptId
  ) {
    workspaceState!.finishPromptLocal(appEvent.sessionId);
  }

  // The agent asked a question and is waiting for an answer — surface it so
  // the user comes back. Hooked on the request event (fires once per new
  // question, and not for questions restored from a snapshot) rather than the
  // awaitingQuestion status flip, which can arrive in any order relative to it.
  if (appEvent.type === "questionRequested") {
    onQuestionRequested(appEvent.sessionId, appEvent.question);
  }

  // The agent needs approval for a tool call — surface it so the user comes back.
  if (appEvent.type === "approvalRequested") {
    onApprovalRequested(appEvent.sessionId, appEvent.approval);
  }
}

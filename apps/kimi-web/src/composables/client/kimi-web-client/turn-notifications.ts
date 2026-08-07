import type { AppApprovalRequest, AppQuestionRequest } from "../../../api/types";
import { shouldNotifyCompletion } from "../useNotification";
import { rawState, notification, sound, workspaceState } from "./runtime";
import { refreshSessionStatus } from "./session-refresh";
import { saveUnread } from "../../../lib/storage";

export function isUserWatching(sid: string): boolean {
  return (
    sid === rawState.activeSessionId &&
    typeof document !== "undefined" &&
    document.visibilityState === "visible" &&
    document.hasFocus()
  );
}

/**
 * Authoritative-quiet escape hatch. The session's idle/aborted status means no
 * main turn can still be in flight (an awaiting interaction would report
 * awaiting_*, not idle), so both working-moon flags are cleared even when the
 * turn.ended that owned them never arrived (e.g. abrupt agent disposal). This
 * is the ONLY writer of `turnActiveBySession` outside the reducer /
 * snapshot seed, and the ONLY clearer of `inFlightBySession` outside
 * finishPromptLocal / the entry points' error paths. Drain and completion
 * side effects are NOT run here — they stay single-owned by the turn.ended
 * path (onMainTurnEnd).
 */
export function clearWorkingFlags(sid: string): void {
  if (rawState.turnActiveBySession[sid]) {
    const next = { ...rawState.turnActiveBySession };
    delete next[sid];
    rawState.turnActiveBySession = next;
  }
  if (rawState.inFlightBySession[sid]) {
    rawState.inFlightBySession = {
      ...rawState.inFlightBySession,
      [sid]: false,
    };
  }
}

export function onMainTurnEnd(
  sid: string,
  status: "idle" | "aborted",
  turnWasActive: boolean,
): void {
  // Capture before finishPromptLocal drops it — it keys the completion
  // notification's dedup tag so each finished turn alerts once.
  const finishedPromptId = rawState.promptIdBySession[sid];
  // Shared finish cleanup: clears in-flight/prompt-id and drains one
  // queued message. The notification/sound/unread side effects below stay
  // WS-event-only — the snapshot path (handleSessionSnapshot) must not cry
  // wolf when opening a historical session.
  workspaceState!.finishPromptLocal(sid, { turnWasActive });

  // For the session on screen, refresh git status (edits the agent just made)
  // and runtime status (model/context usage may have changed this turn).
  if (sid === rawState.activeSessionId) {
    void workspaceState!.loadGitStatus(sid);
    void refreshSessionStatus(sid);
  } else if (status === "idle") {
    // A background session finished a turn the user hasn't seen — light up its
    // unread dot until they open it. Aborted (cancelled/failed) turns are
    // excluded on purpose: there is no fresh result to read, and counting them
    // is what made the sidebar fill with stale unreads after a refresh.
    rawState.unreadBySession = { ...rawState.unreadBySession, [sid]: true };
    saveUnread({ [sid]: true });
  }

  // Browser notification when the user isn't watching this session.
  // Only real completions notify; aborted turns and turns that ended up
  // blocked on approval/question do not fire the generic "Turn finished" alert.
  const hasPendingApproval =
    (rawState.approvalsBySession[sid] ?? []).length > 0;
  const hasPendingQuestion =
    (rawState.questionsBySession[sid] ?? []).length > 0;
  if (shouldNotifyCompletion(status, hasPendingApproval, hasPendingQuestion)) {
    notification.maybeNotifyCompletion(sid, {
      isUserWatching: isUserWatching(sid),
      sessionTitle: rawState.sessions.find((s) => s.id === sid)?.title ?? "",
      promptId: finishedPromptId,
      onClick: () => {
        void workspaceState!.selectSession(sid);
      },
    });
  }

  // Completion sound — only for real completions (aborted/cancelled turns stay
  // silent). Plays regardless of visibility so it also reaches a backgrounded tab.
  if (status === "idle") {
    sound.maybePlayCompletionSound();
  }
}

export function onQuestionRequested(sid: string, question: AppQuestionRequest): void {
  const first = question.questions[0];
  // Lead with the actionable question text; keep the short header as context
  // when both are present so the desktop notification actually says what is
  // being asked (e.g. "Storage: Which database?").
  const header = first?.header?.trim() ?? "";
  const questionText = first?.question?.trim() ?? "";
  const preview =
    header && questionText
      ? `${header}: ${questionText}`
      : questionText || header;

  // Browser notification when the user isn't watching this session.
  notification.maybeNotifyQuestion({
    isUserWatching: isUserWatching(sid),
    sessionTitle: rawState.sessions.find((s) => s.id === sid)?.title ?? "",
    questionPreview: preview,
    questionId: question.questionId,
    onClick: () => {
      void workspaceState!.selectSession(sid);
    },
  });

  // Attention sound — plays regardless of visibility so it also reaches a
  // backgrounded tab (same as the completion sound).
  sound.maybePlayQuestionSound();
}

export function onApprovalRequested(sid: string, approval: AppApprovalRequest): void {
  // Browser notification when the user isn't watching this session.
  notification.maybeNotifyApproval({
    isUserWatching: isUserWatching(sid),
    sessionTitle: rawState.sessions.find((s) => s.id === sid)?.title ?? "",
    toolName: approval.toolName,
    approvalId: approval.approvalId,
    onClick: () => {
      void workspaceState!.selectSession(sid);
    },
  });

  // Attention sound — plays regardless of visibility so it also reaches a
  // backgrounded tab (same as the completion sound).
  sound.maybePlayApprovalSound();
}

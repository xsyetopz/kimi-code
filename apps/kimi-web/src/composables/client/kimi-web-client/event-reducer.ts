import { reduceAppEvent, type KimiClientState } from "../../../api/daemon/eventReducer";
import type { ThinkingLevel } from "../../../api/types";
import { toAppEvent } from "../../../api/daemon/mappers";
import { rawState, modelProvider } from "./runtime";
import {
  setSessions,
  setActiveSessionId,
  setMessagesBySession,
} from "./session-mutations";

export function applyEvent(
  event: ReturnType<typeof toAppEvent>,
  sessionId: string,
  seq: number,
): void {
  const snapshot: KimiClientState = {
    sessions: rawState.sessions,
    activeSessionId: rawState.activeSessionId,
    messagesBySession: rawState.messagesBySession,
    approvalsBySession: rawState.approvalsBySession,
    planReviewByToolCallId: rawState.planReviewByToolCallId,
    questionsBySession: rawState.questionsBySession,
    tasksBySession: rawState.tasksBySession,
    goalBySession: rawState.goalBySession,
    goalVersionBySession: rawState.goalVersionBySession,
    lastSeqBySession: rawState.lastSeqBySession,
    turnActiveBySession: rawState.turnActiveBySession,
    compactionBySession: rawState.compactionBySession,
    config: rawState.config,
    warnings: rawState.warnings,
  };
  const next = reduceAppEvent(snapshot, event, { sessionId, seq });
  // Assign back to the reactive proxy
  setSessions(next.sessions);
  setActiveSessionId(next.activeSessionId);
  setMessagesBySession(next.messagesBySession);
  rawState.approvalsBySession = next.approvalsBySession;
  rawState.planReviewByToolCallId = next.planReviewByToolCallId;
  rawState.questionsBySession = next.questionsBySession;
  rawState.tasksBySession = next.tasksBySession;
  rawState.goalBySession = next.goalBySession;
  rawState.goalVersionBySession = next.goalVersionBySession;
  rawState.lastSeqBySession = next.lastSeqBySession;
  rawState.turnActiveBySession = next.turnActiveBySession;
  rawState.compactionBySession = next.compactionBySession;
  rawState.config = next.config ?? null;
  rawState.warnings = next.warnings;

  if (event.type === "configChanged") {
    rawState.defaultModel = event.config.defaultModel ?? null;
  }

  if (event.type === "modelCatalogChanged") {
    void modelProvider!.loadModels();
    void modelProvider!.loadProviders();
  }

  // Reflect the agent's live plan/swarm state per session (e.g. it auto-entered
  // plan mode). Applied to the event's own session — not gated on the active
  // session — so a background session keeps its own independent toggle state.
  if (event.type === "sessionUsageUpdated") {
    if (event.swarmMode !== undefined) {
      rawState.swarmModeBySession = {
        ...rawState.swarmModeBySession,
        [event.sessionId]: event.swarmMode,
      };
    }
    if (event.planMode !== undefined) {
      rawState.planModeBySession = {
        ...rawState.planModeBySession,
        [event.sessionId]: event.planMode,
      };
    }
    if (event.thinking !== undefined) {
      rawState.thinkingBySession = {
        ...rawState.thinkingBySession,
        [event.sessionId]: event.thinking as ThinkingLevel,
      };
    }
  }
}

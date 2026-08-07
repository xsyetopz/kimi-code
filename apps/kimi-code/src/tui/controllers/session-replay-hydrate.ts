import type { ResumedAgentState } from "@moonshot-ai/kimi-code-sdk";

import type { TodoItem } from "../components/chrome/todo-panel";
import { isTodoItemShape } from "../utils/event-payload";
import {
  countActiveBackgroundTasks,
  isTerminalBackgroundTask,
  replayBackgroundProjection,
} from "../utils/message-replay";
import type { SessionReplayHost } from "./session-replay";

export function hydrateSessionReplayTodoPanel(
  host: SessionReplayHost,
  agent: ResumedAgentState,
): void {
  const rawTodos = agent.toolStore?.["todo"];
  if (!Array.isArray(rawTodos)) {
    host.streamingUI.setTodoList([]);
    return;
  }

  const todos = rawTodos
    .filter((todo): todo is TodoItem => isTodoItemShape(todo))
    .map((todo) => ({ title: todo.title, status: todo.status }));
  if (todos.length > 0 && todos.every((todo) => todo.status === "done")) {
    host.streamingUI.setTodoList([]);
    return;
  }

  host.streamingUI.setTodoList(todos);
}

/**
 * Push real terminal status into each replayed `Agent` card whose
 * backing background task is already in a terminal state. Runs AFTER
 * `renderRecords` because the tool call components only exist once the
 * replay has mounted them — `hydrateBackgroundState` runs too early to
 * reach them. Without this, terminated bg agents (including ones that
 * reconcile reclassified as `lost`) keep the spawn-success ToolResult's
 * default of `✓ Completed`.
 */
export function applyTerminalBackgroundAgentStatusesOnReplay(
  host: SessionReplayHost,
  agent: ResumedAgentState,
): void {
  for (const info of agent.background) {
    if (info.kind !== "agent") continue;
    if (!isTerminalBackgroundTask(info)) continue;
    const status = info.status;
    if (
      status !== "completed" &&
      status !== "failed" &&
      status !== "timed_out" &&
      status !== "killed" &&
      status !== "lost"
    ) {
      continue;
    }
    host.streamingUI.applyBackgroundTaskTerminalStatus({
      agentId: info.agentId,
      description: info.description,
      status,
    });
  }
}

export function hydrateSessionReplayBackgroundState(
  host: SessionReplayHost,
  agent: ResumedAgentState,
): void {
  const { state, sessionEventHandler } = host;
  const projection = replayBackgroundProjection(agent.background);
  sessionEventHandler.subAgentEventHandler.backgroundAgentMetadata = new Map(
    projection.backgroundAgentMetadata,
  );
  sessionEventHandler.backgroundTasks.clear();
  for (const info of agent.background) {
    sessionEventHandler.backgroundTasks.set(info.taskId, info);
  }
  sessionEventHandler.backgroundTaskTranscriptedTerminal.clear();
  for (const info of agent.background) {
    if (isTerminalBackgroundTask(info)) {
      sessionEventHandler.backgroundTaskTranscriptedTerminal.add(info.taskId);
    }
  }
  state.footer.setBackgroundCounts(
    countActiveBackgroundTasks(sessionEventHandler.backgroundTasks),
  );
  state.ui.requestRender();
}

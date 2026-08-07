/**
 * `AgentTranscriptProjector` — maps one agent's `IEventBus` domain events to
 * L2 transcript operations (`@moonshot-ai/transcript`).
 */

import type { DomainEvent } from "@moonshot-ai/agent-core-v2";
import type { TranscriptOperation, TranscriptUsage } from "@moonshot-ai/transcript";

import { ProjectorMetaPrompts } from "./projectorMetaPrompts";
import { restOf } from "./projectorMappings";
import type { ProjectorLookups, ProjectorPromptSubmittedEvent } from "./projectorTypes";

export * from "./projectorTypes";

export class AgentTranscriptProjector extends ProjectorMetaPrompts {
  constructor(
    readonly agentId: string,
    lookups?: ProjectorLookups,
  ) {
    super(lookups);
  }

  map(
    event: DomainEvent | ProjectorPromptSubmittedEvent,
  ): TranscriptOperation[] {
    switch (event.type) {
      case "plan.revision":
        return this.onPlanRevision(event);
      case "turn.started":
        return this.onTurnStarted(event);
      case "turn.ended":
        return this.onTurnEnded(event);
      case "turn.step.started":
        return this.onStepStarted(event);
      case "turn.step.completed":
        return this.onStepCompleted(event);
      case "turn.step.interrupted":
        return this.onStepFinished(event);
      case "turn.step.retrying":
        return this.onStepRetrying(event);
      case "assistant.delta":
        return this.onTextDelta(event.turnId, "assistant", event.delta);
      case "thinking.delta":
        return this.onTextDelta(event.turnId, "thinking", event.delta);
      case "tool.call.delta":
        return this.onToolCallDelta(event);
      case "tool.progress":
        return this.onToolProgress(event);
      case "tool.result":
        return this.onToolResult(event);
      case "task.started":
      case "task.terminated":
        return this.onTaskLifecycle(event);
      case "task.notified":
        return this.onTaskNotified(event);
      case "shell.started":
        return this.onShellStarted(event);
      case "shell.output":
        return this.onShellOutput(event);
      case "shell.completed":
        return this.onShellCompleted(event);
      case "subagent.spawned":
        return this.onSubagentSpawned(event);
      case "subagent.started":
      case "subagent.completed":
      case "subagent.failed":
      case "subagent.suspended":
        return this.onSubagentRun(event);
      case "goal.updated":
        return this.onGoalUpdated(event);
      case "agent.status.updated":
        return this.onAgentStatusUpdated(event);
      case "agent.activity.updated":
        return this.onAgentActivityUpdated(event);
      case "prompt.submitted":
        return this.onPromptSubmitted(event);
      case "prompt.completed":
        return this.onPromptCompleted(event);
      case "prompt.aborted":
        return this.onPromptAborted(event);
      case "prompt.steered":
        return this.onPromptSteered(event);
      case "hook.result":
        return [this.markerOp("hook", restOf(event))];
      case "skill.activated":
        return [this.markerOp("skill", restOf(event))];
      case "plugin_command.activated":
        return [
          this.markerOp("skill", {
            ...restOf(event),
            variant: "plugin_command",
          }),
        ];
      case "cron.fired":
        return [this.markerOp("cron.fired", restOf(event))];
      case "compaction.started":
      case "compaction.blocked":
      case "compaction.cancelled":
      case "compaction.completed":
        return [
          this.markerOp("compaction", {
            phase: event.type.slice("compaction.".length),
            ...restOf(event),
          }),
        ];
      case "context.spliced":
        return [this.markerOp("undo", restOf(event))];
      case "error":
        return [this.noticeOp("error", event.message, restOf(event))];
      case "warning":
        return [this.noticeOp("warning", event.message, restOf(event))];
      default:
        return [];
    }
  }

  protected takeTurnUsage(turnId: string): TranscriptUsage | undefined {
    const usages = this.stepUsageByTurn.get(turnId);
    this.stepUsageByTurn.delete(turnId);
    if (usages === undefined || usages.length === 0) return undefined;
    let inputOther = 0;
    let output = 0;
    let inputCacheRead = 0;
    let inputCacheCreation = 0;
    for (const usage of usages) {
      inputOther += usage.inputOther;
      output += usage.output;
      inputCacheRead += usage.inputCacheRead;
      inputCacheCreation += usage.inputCacheCreation;
    }
    return {
      inputTokens: inputOther + inputCacheCreation,
      cachedTokens: inputCacheRead,
      outputTokens: output,
    };
  }
}

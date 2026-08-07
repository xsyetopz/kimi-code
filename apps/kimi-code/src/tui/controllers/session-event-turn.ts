import type {
  AssistantDeltaEvent,
  CompactionCancelledEvent,
  CompactionCompletedEvent,
  CompactionStartedEvent,
  CronFiredEvent,
  HookResultEvent,
  ThinkingDeltaEvent,
  ToolCallDeltaEvent,
  ToolCallStartedEvent,
  ToolProgressEvent,
  ToolResultEvent,
  TurnEndedEvent,
  TurnStartedEvent,
  TurnStepCompletedEvent,
  TurnStepInterruptedEvent,
  TurnStepStartedEvent,
} from "@moonshot-ai/kimi-code-sdk";

import {
  argsRecord,
  isTodoItemShape,
  serializeToolResultOutput,
} from "../utils/event-payload";
import { formatHookResultMarkdown } from "../utils/hook-result-format";
import { formatStepDebugTiming } from "#/utils/usage/debug-timing";
import { nextTranscriptId } from "../utils/transcript-id";
import type {
  QueuedMessage,
  ToolCallBlockData,
  ToolResultBlockData,
} from "../types";
import { isPluginMcpToolName, type PluginUpdateNotifier } from "./plugin-update-notifier";
import type { SubAgentEventHandler } from "./subagent-event-handler";
import type { SessionEventGoalHandler } from "./session-event-goal";
import type { SessionEventHost } from "./session-event-handler";

export interface SessionEventTurnHandlerDependencies {
  readonly subAgentEventHandler: SubAgentEventHandler;
  readonly pluginUpdateNotifier: PluginUpdateNotifier;
  readonly goalHandler: SessionEventGoalHandler;
}

export class SessionEventTurnHandler {
  currentTurnHasAssistantText = false;
  private pluginCommandTurns: Map<string, string> = new Map();
  private pluginMcpToolsUsedInTurn: Set<string> = new Set();

  constructor(
    private readonly host: SessionEventHost,
    private readonly deps: SessionEventTurnHandlerDependencies,
  ) {}

  resetRuntimeState(): void {
    this.currentTurnHasAssistantText = false;
    this.pluginCommandTurns.clear();
    this.pluginMcpToolsUsedInTurn.clear();
  }

  handleTurnBegin(event: TurnStartedEvent): void {
    this.currentTurnHasAssistantText = false;
    if (event.origin?.kind === "plugin_command") {
      this.pluginCommandTurns.set(String(event.turnId), event.origin.pluginId);
    }
    this.deps.subAgentEventHandler.clearAgentSwarmProgress();
    this.host.streamingUI.resetToolUi();
    this.host.streamingUI.setStep(0);
    this.host.patchLivePane({
      mode: "waiting",
      pendingApproval: null,
      pendingQuestion: null,
    });
    this.host.setAppState({
      streamingPhase: "waiting",
      streamingStartTime: Date.now(),
    });
  }

  handleCronFired(event: CronFiredEvent): void {
    this.host.streamingUI.flushNow();
    this.host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: "cron",
      turnId: this.host.streamingUI.getTurnContext().turnId,
      renderMode: "plain",
      content: event.prompt,
      cronData: {
        jobId: event.origin.jobId,
        cron: event.origin.cron,
        recurring: event.origin.recurring,
        coalescedCount: event.origin.coalescedCount,
        stale: event.origin.stale,
      },
    });
  }

  handleTurnEnd(
    event: TurnEndedEvent,
    sendQueued: (item: QueuedMessage) => void,
  ): void {
    this.host.streamingUI.flushNow();
    if (event.reason === "cancelled") {
      this.deps.subAgentEventHandler.markActiveAgentSwarmsCancelled();
    }
    if (
      event.reason === "failed" &&
      event.error?.code === "provider.filtered"
    ) {
      this.host.showStatus(
        "Turn stopped: provider safety policy blocked the response.",
        "error",
      );
    }
    if (event.reason === "blocked") {
      this.host.showStatus(
        "Turn stopped: prompt hook blocked the request.",
        "error",
      );
    }
    const todos = this.host.state.todoPanel.getTodos();
    if (todos.length > 0 && todos.every((t) => t.status === "done")) {
      this.host.streamingUI.setTodoList([]);
    }
    this.host.streamingUI.resetToolUi();
    this.host.streamingUI.finalizeTurn(sendQueued);
    this.deps.goalHandler.renderPendingModelBlockedFallback();
    this.currentTurnHasAssistantText = false;
    const reportPluginUsage = event.reason !== "cancelled";
    const pluginCommandPluginId = this.pluginCommandTurns.get(
      String(event.turnId),
    );
    if (pluginCommandPluginId !== undefined) {
      this.pluginCommandTurns.delete(String(event.turnId));
      if (reportPluginUsage) {
        void this.deps.pluginUpdateNotifier.handlePluginCommandCompleted(
          pluginCommandPluginId,
        );
      }
    }
    if (reportPluginUsage) {
      for (const toolName of this.pluginMcpToolsUsedInTurn) {
        void this.deps.pluginUpdateNotifier.handleMcpToolCompleted(toolName);
      }
    }
    this.pluginMcpToolsUsedInTurn.clear();
    this.deps.goalHandler.onTurnEnded();
  }

  handleStepBegin(event: TurnStepStartedEvent): void {
    this.host.streamingUI.flushNow();
    this.host.streamingUI.setStep(event.step);
    this.host.streamingUI.resetToolUi();
    this.host.streamingUI.finalizeLiveTextBuffers("waiting");
    this.host.patchLivePane({
      mode: "waiting",
      pendingApproval: null,
      pendingQuestion: null,
    });
    this.host.setAppState({
      streamingPhase: "waiting",
      streamingStartTime: Date.now(),
    });
  }

  handleStepCompleted(event: TurnStepCompletedEvent): void {
    this.host.streamingUI.flushNow();
    this.maybeShowDebugTiming(event);

    if (event.providerFinishReason === "filtered") {
      this.host.showNotice(
        "Provider safety policy blocked the response.",
        `The model output was filtered (${event.rawFinishReason ?? "content_filter"}).`,
      );
      return;
    }

    if (event.finishReason !== "max_tokens") return;

    const truncatedCount = this.host.streamingUI.markStepTruncated(
      String(event.turnId),
      event.step,
    );

    const title =
      truncatedCount > 0
        ? "Model hit max_tokens — tool call was truncated before it could run."
        : "Model hit max_tokens — no tool call was emitted.";
    const detail = this.isAnthropicSessionActive()
      ? "If this limit is wrong for your model, set `max_output_size` on the model alias in your kimi-code config."
      : undefined;
    this.host.showNotice(title, detail);
  }

  private maybeShowDebugTiming(event: TurnStepCompletedEvent): void {
    if (process.env["KIMI_CODE_DEBUG"] !== "1") return;
    const text = formatStepDebugTiming(event);
    if (text === undefined) return;
    this.host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: "status",
      turnId: String(event.turnId),
      renderMode: "plain",
      content: text,
    });
  }

  private isAnthropicSessionActive(): boolean {
    const { state } = this.host;
    const model = state.appState.availableModels[state.appState.model];
    if (model === undefined) return false;
    if (model.protocol === "anthropic") return true;
    return (
      state.appState.availableProviders[model.provider]?.type === "anthropic"
    );
  }

  handleStepInterrupted(event: TurnStepInterruptedEvent): void {
    this.host.streamingUI.flushNow();
    this.host.streamingUI.resetToolUi();
    this.host.streamingUI.finalizeLiveTextBuffers("idle");
    const reason = event.reason;
    if (reason === "error") return;
    if (reason === "aborted" || reason === undefined || reason === "") {
      this.deps.subAgentEventHandler.markActiveAgentSwarmsCancelled();
      if (event.message === undefined || event.message === "") {
        this.host.showStatus("Interrupted by user", "error");
      } else {
        this.host.showError(event.message);
      }
      return;
    }
    this.host.showError(
      reason === "max_steps"
        ? "reached per-turn step limit (max_steps)"
        : `step interrupted (${reason})`,
    );
  }

  handleThinkingDelta(event: ThinkingDeltaEvent): void {
    const { state, streamingUI } = this.host;
    if (event.delta.trim().length === 0 && !streamingUI.hasThinkingDraft())
      return;
    streamingUI.appendThinkingDelta(event.delta);
    this.host.patchLivePane({ mode: "idle" });
    if (state.appState.streamingPhase !== "thinking") {
      this.host.setAppState({
        streamingPhase: "thinking",
        streamingStartTime: Date.now(),
      });
    }
    streamingUI.scheduleFlush();
  }

  handleAssistantDelta(event: AssistantDeltaEvent): void {
    const { state, streamingUI } = this.host;
    if (streamingUI.hasThinkingDraft()) {
      streamingUI.flushThinkingToTranscript("idle");
    }

    if (event.delta.trim().length > 0) {
      this.currentTurnHasAssistantText = true;
      this.deps.goalHandler.clearPendingModelBlockedFallback();
    }
    streamingUI.appendAssistantDelta(event.delta);

    this.host.patchLivePane({
      mode: "idle",
      pendingApproval: null,
      pendingQuestion: null,
    });
    if (state.appState.streamingPhase !== "composing") {
      this.host.setAppState({
        streamingPhase: "composing",
        streamingStartTime: Date.now(),
      });
    }
    streamingUI.scheduleFlush();
  }

  handleHookResult(event: HookResultEvent): void {
    this.host.streamingUI.flushNow();
    if (this.host.streamingUI.hasThinkingDraft()) {
      this.host.streamingUI.flushThinkingToTranscript("idle");
    }
    this.host.streamingUI.finalizeAssistantStream();
    if (event.content.trim().length > 0) {
      this.currentTurnHasAssistantText = true;
      this.deps.goalHandler.clearPendingModelBlockedFallback();
    }
    this.host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: "assistant",
      turnId: String(event.turnId),
      renderMode: "markdown",
      content: formatHookResultMarkdown(event),
    });
    this.host.patchLivePane({
      mode: "idle",
      pendingApproval: null,
      pendingQuestion: null,
    });
  }

  handleToolCall(event: ToolCallStartedEvent): void {
    const { streamingUI } = this.host;
    streamingUI.flushNow();
    const { turnId, step } = streamingUI.getTurnContext();
    const toolCall: ToolCallBlockData = {
      id: event.toolCallId,
      name: event.name,
      args: argsRecord(event.args),
      description: event.description,
      display: event.display,
      step,
      turnId,
    };
    streamingUI.registerToolCall(toolCall);
    if (event.name === "AgentSwarm") {
      this.deps.subAgentEventHandler.handleAgentSwarmToolCallStarted(
        event.toolCallId,
        toolCall.args,
      );
    }
    this.host.patchLivePane({
      mode: "tool",
      pendingApproval: null,
      pendingQuestion: null,
    });
  }

  handleToolCallDelta(event: ToolCallDeltaEvent): void {
    if (event.toolCallId.length === 0) return;
    const { state, streamingUI } = this.host;
    streamingUI.accumulateToolCallDelta(
      event.toolCallId,
      event.name,
      event.argumentsPart,
    );
    const preview = streamingUI.getStreamingToolCallPreview(event.toolCallId);
    if (
      preview !== undefined &&
      (preview.name === "AgentSwarm" ||
        this.deps.subAgentEventHandler.hasAgentSwarmProgress(event.toolCallId))
    ) {
      this.deps.subAgentEventHandler.handleAgentSwarmToolCallDelta(
        event.toolCallId,
        preview.args,
        {
          streamingArguments: preview.argumentsText,
        },
      );
    }

    this.host.patchLivePane({
      mode: "tool",
      pendingApproval: null,
      pendingQuestion: null,
    });
    if (state.appState.streamingPhase !== "composing") {
      this.host.setAppState({
        streamingPhase: "composing",
        streamingStartTime: Date.now(),
      });
    }
    streamingUI.scheduleFlush();
  }

  handleToolProgress(event: ToolProgressEvent): void {
    const text = event.update.text;
    if (text === undefined || text.length === 0) return;
    const tc = this.host.streamingUI.getToolComponent(event.toolCallId);
    if (tc === undefined) return;
    if (event.update.kind === "status") {
      tc.appendProgress(text);
      return;
    }
    if (event.update.kind === "stdout" || event.update.kind === "stderr") {
      tc.appendLiveOutput(text);
    }
  }

  handleToolResult(event: ToolResultEvent): void {
    const { streamingUI } = this.host;
    streamingUI.flushNow();
    const resultData: ToolResultBlockData = {
      tool_call_id: event.toolCallId,
      output: serializeToolResultOutput(event.output),
      is_error: event.isError,
      synthetic: event.synthetic,
    };
    const matchedCall = streamingUI.completeToolResult(
      event.toolCallId,
      resultData,
    );
    if (matchedCall !== undefined && isPluginMcpToolName(matchedCall.name)) {
      this.pluginMcpToolsUsedInTurn.add(matchedCall.name);
    }
    this.deps.subAgentEventHandler.handleAgentSwarmToolResult(
      event.toolCallId,
      resultData,
      event.isError === true,
    );
    if (
      matchedCall !== undefined &&
      matchedCall.name === "TodoList" &&
      !event.isError
    ) {
      const rawTodos = (matchedCall.args as { todos?: unknown }).todos;
      if (Array.isArray(rawTodos)) {
        const sanitized = rawTodos
          .filter(
            (
              todo,
            ): todo is {
              title: string;
              status: "pending" | "in_progress" | "done";
            } => isTodoItemShape(todo),
          )
          .map((t) => ({ title: t.title, status: t.status }));
        streamingUI.setTodoList(sanitized);
      }
    }
    this.host.patchLivePane({ mode: "waiting" });
  }

  handleCompactionBegin(event: CompactionStartedEvent): void {
    this.host.streamingUI.finalizeLiveTextBuffers("waiting");
    this.host.setAppState({
      isCompacting: true,
      streamingPhase: "waiting",
      streamingStartTime: Date.now(),
    });
    this.host.streamingUI.beginCompaction(event.instruction);
  }

  handleCompactionEnd(
    event: CompactionCompletedEvent,
    sendQueued: (item: QueuedMessage) => void,
  ): void {
    this.host.streamingUI.endCompaction(
      event.result.tokensBefore,
      event.result.tokensAfter,
      event.result.summary,
    );
    this.finishCompaction(sendQueued);
  }

  handleCompactionCancel(
    _event: CompactionCancelledEvent,
    sendQueued: (item: QueuedMessage) => void,
  ): void {
    this.host.streamingUI.cancelCompaction();
    this.finishCompaction(sendQueued);
  }

  private finishCompaction(sendQueued: (item: QueuedMessage) => void): void {
    const hasActiveTurn = this.host.streamingUI.hasActiveTurn();
    if (!hasActiveTurn) {
      const next = this.host.shiftQueuedMessage();
      if (next !== undefined) {
        this.host.state.queuedMessageDispatchPending = true;
      }
      this.host.setAppState({
        isCompacting: false,
        streamingPhase: "idle",
      });
      this.host.resetLivePane();
      if (next !== undefined) {
        setTimeout(() => {
          this.host.state.queuedMessageDispatchPending = false;
          sendQueued(next);
        }, 0);
      }
    } else {
      this.host.setAppState({ isCompacting: false });
    }
  }
}

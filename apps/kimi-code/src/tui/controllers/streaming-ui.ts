import type { Session } from "@moonshot-ai/kimi-code-sdk";

import { AgentGroupComponent } from "../components/messages/agent-group";
import { AssistantMessageComponent } from "../components/messages/assistant-message";
import { CompactionComponent } from "../components/dialogs/compaction";
import { ReadGroupComponent } from "../components/messages/read-group";
import { ThinkingComponent } from "../components/messages/thinking";
import { ToolCallComponent } from "../components/messages/tool-call";
import { STREAMING_UI_FLUSH_MS } from "../constant/streaming";
import { hasDispose } from "../utils/component-capabilities";
import {
  appendStreamingArgsPreview,
  parseStreamingArgs,
} from "../utils/event-payload";
import { notifyTerminalOnce } from "../utils/terminal-notification";
import { nextTranscriptId } from "../utils/transcript-id";
import type { TodoItem } from "../components/chrome/todo-panel";
import type {
  AppState,
  LivePaneState,
  QueuedMessage,
  ToolCallBlockData,
  ToolResultBlockData,
  CompactionTranscriptData,
  TranscriptEntry,
} from "../types";
import type { TUIState } from "../tui-state";
import {
  StreamingUIToolGroups,
  type StreamingUIToolGroupState,
  cleanupStreamingAfterReplay,
  markStreamingStepTruncated,
  type StreamingUIReplayState,
} from "./streaming-ui-tool-groups";
import {
  applyBackgroundTaskTerminalStatus as applySubagentTerminalStatus,
  markSubagentBackgrounded as markSubagentDetached,
} from "./streaming-ui-subagent";

export interface StreamingUIHost {
  state: TUIState;
  session: Session | undefined;
  setAppState(patch: Partial<AppState>): void;
  patchLivePane(patch: Partial<LivePaneState>): void;
  resetLivePane(): void;
  updateActivityPane(): void;
  updateQueueDisplay(): void;
  requireSession(): Session;
  deferUserMessages: boolean;
  shiftQueuedMessage(): QueuedMessage | undefined;
  pushTranscriptEntry(entry: TranscriptEntry): void;
  mergeCurrentTurnSteps(): void;
  mergeCompletedTurnAssistants(): void;
  requestTerminalRender(): void;
  syncToolCallTranscriptEntry(
    toolCallId: string,
    data: ToolCallBlockData,
  ): void;
  syncCompactionTranscriptEntry(
    entryId: string,
    data: CompactionTranscriptData,
  ): void;
  syncAgentGroupTranscriptEntry(
    entryId: string,
    data: import("../projections/tool-call/agent-group").AgentGroupViewState,
    memberToolCallIds: readonly string[],
  ): void;
  syncReadGroupTranscriptEntry(
    entryId: string,
    data: import("../projections/tool-call/read-group").ReadGroupViewState,
    memberToolCallIds: readonly string[],
  ): void;
}

export class StreamingUIController {
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private lastFlushAt: number | undefined;
  private pendingAssistantFlush = false;
  private pendingThinkingFlush = false;
  readonly pendingToolCallFlushIds = new Set<string>();

  // Streaming runtime state

  private _currentTurnId: string | undefined = undefined;
  private _currentStep = 0;
  private _assistantDraft = "";
  private _thinkingDraft = "";
  private _streamingBlock: {
    component: AssistantMessageComponent;
    entry: TranscriptEntry;
  } | null = null;
  private _activeThinkingComponent: ThinkingComponent | undefined = undefined;
  private _activeCompactionBlock: CompactionComponent | undefined = undefined;
  private _activeCompactionEntryId: string | undefined = undefined;
  private _activeToolCalls = new Map<string, ToolCallBlockData>();
  private _streamingToolCallArguments = new Map<
    string,
    { name?: string; argumentsText: string; startedAtMs: number }
  >();
  private _pendingToolComponents = new Map<string, ToolCallComponent>();
  private _pendingAgentGroup: {
    readonly turnId: string | undefined;
    readonly step: number;
    solo?: ToolCallComponent;
    group?: AgentGroupComponent;
  } | null = null;
  private _pendingReadGroup: {
    readonly turnId: string | undefined;
    readonly step: number;
    solo?: ToolCallComponent;
    group?: ReadGroupComponent;
  } | null = null;
  private _agentGroupInkEntryId: string | undefined = undefined;
  private _readGroupInkEntryId: string | undefined = undefined;
  private readonly toolGroups: StreamingUIToolGroups;
  private readonly replayState: StreamingUIReplayState;

  constructor(private readonly host: StreamingUIHost) {
    const groupState: StreamingUIToolGroupState = {
      getStep: () => this._currentStep,
      getTurnId: () => this._currentTurnId,
      getThinkingDraft: () => this._thinkingDraft,
      hasStreamingBlock: () => this._streamingBlock !== null,
      getPendingAgentGroup: () => this._pendingAgentGroup,
      setPendingAgentGroup: (value) => {
        this._pendingAgentGroup = value;
      },
      getPendingReadGroup: () => this._pendingReadGroup,
      setPendingReadGroup: (value) => {
        this._pendingReadGroup = value;
      },
      getAgentGroupInkEntryId: () => this._agentGroupInkEntryId,
      setAgentGroupInkEntryId: (value) => {
        this._agentGroupInkEntryId = value;
      },
      getReadGroupInkEntryId: () => this._readGroupInkEntryId,
      setReadGroupInkEntryId: (value) => {
        this._readGroupInkEntryId = value;
      },
      getActiveToolCall: (id) => this._activeToolCalls.get(id),
      setActiveToolCall: (id, toolCall) => {
        this._activeToolCalls.set(id, toolCall);
      },
      getStreamingToolCallArguments: (id) =>
        this._streamingToolCallArguments.get(id),
      getPendingToolComponent: (id) => this._pendingToolComponents.get(id),
      finalizeLiveTextBuffers: (nextMode) => this.finalizeLiveTextBuffers(nextMode),
      onToolCallStart: (toolCall) => this.onToolCallStart(toolCall),
    };
    this.toolGroups = new StreamingUIToolGroups(this.host, groupState);
    this.replayState = {
      host: this.host,
      activeToolCalls: this._activeToolCalls,
      pendingToolComponents: this._pendingToolComponents,
      pendingToolCallFlushIds: this.pendingToolCallFlushIds,
      streamingToolCallArguments: this._streamingToolCallArguments,
      setPendingAgentGroup: (value) => {
        this._pendingAgentGroup = value;
      },
      setPendingReadGroup: (value) => {
        this._pendingReadGroup = value;
      },
      setTurnId: (value) => {
        this._currentTurnId = value;
      },
      setStep: (value) => {
        this._currentStep = value;
      },
    };
  }

  // Turn context — read/write accessors

  getTurnContext(): { turnId: string | undefined; step: number } {
    return { turnId: this._currentTurnId, step: this._currentStep };
  }

  setTurnId(turnId: string | undefined): void {
    this._currentTurnId = turnId;
  }

  setStep(step: number): void {
    this._currentStep = step;
  }

  hasActiveTurn(): boolean {
    return this._currentTurnId !== undefined;
  }

  // Text streaming accessors

  appendThinkingDelta(delta: string): void {
    this._thinkingDraft += delta;
    this.pendingThinkingFlush = true;
  }

  appendAssistantDelta(delta: string): void {
    if (this._streamingBlock === null) {
      this.onStreamingTextStart();
    }
    this._assistantDraft += delta;
    this.pendingAssistantFlush = true;
  }

  hasThinkingDraft(): boolean {
    return this._thinkingDraft.length > 0;
  }

  hasActiveThinkingComponent(): boolean {
    return this._activeThinkingComponent !== undefined;
  }

  hasStreamingBlock(): boolean {
    return this._streamingBlock !== null;
  }

  getStreamingBlockComponent(): AssistantMessageComponent | undefined {
    return this._streamingBlock?.component;
  }

  clearAssistantDraft(): void {
    this._assistantDraft = "";
  }

  // Tool call state accessors

  getActiveToolCall(id: string): ToolCallBlockData | undefined {
    return this._activeToolCalls.get(id);
  }

  hasActiveToolCall(id: string): boolean {
    return this._activeToolCalls.has(id);
  }

  setActiveToolCall(id: string, toolCall: ToolCallBlockData): void {
    this._activeToolCalls.set(id, toolCall);
  }

  removeActiveToolCall(id: string): void {
    this._activeToolCalls.delete(id);
  }

  getToolComponent(id: string): ToolCallComponent | undefined {
    return this._pendingToolComponents.get(id);
  }

  removeToolComponent(id: string): void {
    this._pendingToolComponents.delete(id);
  }

  hasPendingAgentGroup(): boolean {
    return this._pendingAgentGroup !== null;
  }

  hasPendingReadGroup(): boolean {
    return this._pendingReadGroup !== null;
  }

  removeToolComponentIfInactive(toolCallId: string): void {
    if (!this._activeToolCalls.has(toolCallId)) {
      this._pendingToolComponents.delete(toolCallId);
    }
  }

  /**
   * Push the actual terminal status of a background agent task into the
   * matching `Agent` tool call component so its snapshot phase no longer
   * trusts the spawn-success ToolResult (which would otherwise label every
   * terminated bg agent — including `lost` ones — as `✓ Completed`).
   *
   * Resolution policy: an `args.agentId` is treated as authoritative — we
   * either find a card whose `getSubagentAgentId()` returns the same id
   * (in-memory metadata for live foreground, parsed from the spawn-success
   * `agent_id: ...` line for live backgrounded and replayed cards) or we
   * skip. We deliberately do NOT fall back to description match when
   * `agentId` is provided, because:
   *   - On resume, `applyTerminalBackgroundAgentStatuses` iterates every
   *     persisted terminal task, including ones whose tool calls fell
   *     outside the `REPLAY_TURN_LIMIT` window. A description fallback
   *     would let an old `lost` task stamp its status onto an unrelated
   *     recent Agent card that happens to share `args.description`.
   *   - During a live spawn / terminate race, the same card can briefly
   *     appear in both `_pendingToolComponents` and `transcriptContainer`,
   *     so a description match could double-visit the same component and
   *     mark itself ambiguous. agentId match short-circuits on the first
   *     hit and is immune.
   *
   * Description fallback is kept as a best-effort path only when
   * `agentId` is unknown — that is, on resume of pre-PR sessions whose
   * disk records pre-date `agent_id` persistence.
   *
   * Search scope includes both in-flight components and already-mounted
   * cards (some live in `transcriptContainer` standalone, others are
   * borrowed by an `AgentGroupComponent` and reachable only via
   * `getToolComponents()`).
   *
   * Returns true iff a component was found and updated.
   */
  applyBackgroundTaskTerminalStatus(args: {
    agentId?: string | undefined;
    description: string;
    status: "completed" | "failed" | "timed_out" | "killed" | "lost";
    errorText?: string | undefined;
  }): boolean {
    return applySubagentTerminalStatus(
      this.host,
      this._pendingToolComponents,
      args,
    );
  }

  markSubagentBackgrounded(agentId: string | undefined): boolean {
    return markSubagentDetached(
      this.host,
      this._pendingToolComponents,
      agentId,
    );
  }

  registerToolCall(toolCall: ToolCallBlockData): boolean {
    const existing = this._activeToolCalls.get(toolCall.id);
    this._activeToolCalls.set(toolCall.id, toolCall);
    this.pendingToolCallFlushIds.delete(toolCall.id);
    this._streamingToolCallArguments.delete(toolCall.id);
    const existingComponent = this._pendingToolComponents.get(toolCall.id);
    if (existingComponent !== undefined) {
      existingComponent.updateToolCall(toolCall);
    } else if (existing === undefined) {
      this.finalizeLiveTextBuffers("tool");
      if (toolCall.name !== "Agent" && toolCall.name !== "AgentSwarm") {
        this.onToolCallStart(toolCall);
      }
    }
    return existing === undefined;
  }

  accumulateToolCallDelta(
    id: string,
    eventName: string | undefined,
    argumentsPart: string | null | undefined,
  ): void {
    const existing = this._streamingToolCallArguments.get(id);
    const argumentsText = appendStreamingArgsPreview(
      existing?.argumentsText,
      argumentsPart,
    );
    const name =
      eventName ??
      existing?.name ??
      this._activeToolCalls.get(id)?.name ??
      "Tool";
    const startedAtMs = existing?.startedAtMs ?? Date.now();
    this._streamingToolCallArguments.set(id, {
      name,
      argumentsText,
      startedAtMs,
    });
    this.pendingToolCallFlushIds.add(id);
  }

  getStreamingToolCallPreview(
    id: string,
  ):
    | {
        name: string;
        args: Record<string, unknown>;
        argumentsText: string;
        startedAtMs: number;
      }
    | undefined {
    const streaming = this._streamingToolCallArguments.get(id);
    if (streaming === undefined) return undefined;
    return {
      name: streaming.name ?? this._activeToolCalls.get(id)?.name ?? "Tool",
      args: parseStreamingArgs(streaming.argumentsText),
      argumentsText: streaming.argumentsText,
      startedAtMs: streaming.startedAtMs,
    };
  }

  completeToolResult(
    toolCallId: string,
    result: ToolResultBlockData,
  ): ToolCallBlockData | undefined {
    const matchedCall = this._activeToolCalls.get(toolCallId);
    if (matchedCall !== undefined) {
      this.onToolCallEnd(toolCallId, result);
    }
    this._activeToolCalls.delete(toolCallId);
    this._streamingToolCallArguments.delete(toolCallId);
    return matchedCall;
  }

  markStepTruncated(turnId: string, step: number): number {
    return markStreamingStepTruncated(this.replayState, turnId, step);
  }

  cleanupAfterReplay(completedToolCallIds: Set<string>): void {
    cleanupStreamingAfterReplay(this.replayState, completedToolCallIds);
  }

  // Dispose helpers
  disposeActiveThinkingComponent(): void {
    if (this._activeThinkingComponent !== undefined) {
      this._activeThinkingComponent.dispose();
      this._activeThinkingComponent = undefined;
    }
  }

  disposeAndClearPendingToolComponents(): void {
    for (const component of this._pendingToolComponents.values()) {
      if (hasDispose(component)) component.dispose();
    }
    this._pendingToolComponents.clear();
  }

  disposeActiveCompactionBlock(): void {
    if (this._activeCompactionBlock !== undefined) {
      this._activeCompactionBlock.dispose();
      this._activeCompactionBlock = undefined;
    }
  }

  // Flush control
  hasPending(): boolean {
    return (
      this.pendingAssistantFlush ||
      this.pendingThinkingFlush ||
      this.pendingToolCallFlushIds.size > 0
    );
  }

  clearFlushTimer(): void {
    if (this.flushTimer === undefined) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }

  private clearFlushTimerIfIdle(): void {
    if (this.hasPending()) return;
    this.clearFlushTimer();
  }

  discardPending(): void {
    this.clearFlushTimer();
    this.pendingAssistantFlush = false;
    this.pendingThinkingFlush = false;
    this.pendingToolCallFlushIds.clear();
  }

  scheduleFlush(): void {
    if (!this.hasPending()) return;
    if (this.flushTimer !== undefined) return;
    const delay =
      this.lastFlushAt === undefined
        ? 0
        : Math.max(0, STREAMING_UI_FLUSH_MS - (Date.now() - this.lastFlushAt));
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, delay);
  }

  flushNow(): void {
    this.clearFlushTimer();
    this.flush();
  }

  private flush(): void {
    if (!this.hasPending()) return;
    this.lastFlushAt = Date.now();
    const shouldFlushThinking = this.pendingThinkingFlush;
    const shouldFlushAssistant = this.pendingAssistantFlush;
    const toolCallIds = [...this.pendingToolCallFlushIds];
    this.pendingThinkingFlush = false;
    this.pendingAssistantFlush = false;
    this.pendingToolCallFlushIds.clear();

    if (shouldFlushThinking && this._thinkingDraft.length > 0) {
      this.onThinkingUpdate(this._thinkingDraft);
    }
    if (shouldFlushAssistant) {
      this.onStreamingTextUpdate(this._assistantDraft);
    }
    for (const id of toolCallIds) {
      this.toolGroups.flushToolCallPreview(id);
    }
  }

  markAssistantDirty(): void {
    this.pendingAssistantFlush = true;
  }

  markThinkingDirty(): void {
    this.pendingThinkingFlush = true;
  }

  // Text streaming

  flushThinkingToTranscript(nextMode: LivePaneState["mode"] = "idle"): void {
    this.flushNow();
    this._thinkingDraft = "";
    this.onThinkingEnd();
    this.host.patchLivePane({ mode: nextMode });
  }

  finalizeAssistantStream(): void {
    this.flushNow();
    if (this._streamingBlock !== null) {
      this.onStreamingTextEnd();
    }
    this._assistantDraft = "";
    this.host.updateActivityPane();
    this.host.requestTerminalRender();
  }

  resetLiveText(): void {
    this.pendingAssistantFlush = false;
    this.pendingThinkingFlush = false;
    this.clearFlushTimerIfIdle();
    this._assistantDraft = "";
    this._streamingBlock = null;
    this._thinkingDraft = "";
    this.disposeActiveThinkingComponent();
  }

  resetToolUi(): void {
    this.pendingToolCallFlushIds.clear();
    this.clearFlushTimerIfIdle();
    this._streamingToolCallArguments.clear();
    this.disposeAndClearPendingToolComponents();
    this._pendingAgentGroup = null;
    this._pendingReadGroup = null;
    this.resetToolCallState();
  }

  resetToolCallState(): void {
    this._activeToolCalls.clear();
  }

  finalizeLiveTextBuffers(nextMode: LivePaneState["mode"] = "idle"): void {
    this.flushThinkingToTranscript(nextMode);
    this.finalizeAssistantStream();
  }

  finalizeTurn(sendQueued: (item: QueuedMessage) => void): void {
    const { state } = this.host;
    if (state.appState.streamingPhase === "idle") return;
    this.host.deferUserMessages = false;
    const completedTurnKey =
      this._currentTurnId ??
      `local:${String(state.appState.streamingStartTime)}`;
    this.finalizeLiveTextBuffers("idle");
    // The finished turn keeps only its conclusion-bearing tail; intermediate
    // chatter folds into the step summary.
    this.host.mergeCompletedTurnAssistants();
    this.resetToolCallState();
    this._currentTurnId = undefined;

    const next = this.host.shiftQueuedMessage();
    if (next !== undefined) {
      // The message is out of the queue but not yet sent. Mark the dispatch
      // pending *before* setAppState — that call synchronously retries
      // queued-goal promotion, which would otherwise see an empty queue and an
      // idle phase and start a goal ahead of this message.
      state.queuedMessageDispatchPending = true;
      this.host.setAppState({ streamingPhase: "idle" });
      this.host.resetLivePane();
      setTimeout(() => {
        state.queuedMessageDispatchPending = false;
        sendQueued(next);
      }, 0);
      return;
    }

    this.host.setAppState({ streamingPhase: "idle" });
    this.host.resetLivePane();
    notifyTerminalOnce(state, `turn-complete:${completedTurnKey}`, {
      title: "Kimi Code task complete",
      body: state.appState.sessionTitle ?? undefined,
    });
  }

  // Live render hooks

  onStreamingTextStart(): void {
    const { state } = this.host;
    this._pendingAgentGroup = null;
    this._pendingReadGroup = null;
    const entry = {
      id: nextTranscriptId(),
      kind: "assistant" as const,
      turnId: this._currentTurnId,
      renderMode: "markdown" as const,
      content: "",
      modelText: true,
    };
    const component = new AssistantMessageComponent();
    this._streamingBlock = { component, entry };
    this.host.pushTranscriptEntry(entry);
    state.transcriptContainer.addChild(component);
    this.host.requestTerminalRender();
  }

  onStreamingTextUpdate(fullText: string): void {
    const block = this._streamingBlock;
    if (block !== null) {
      block.entry.content = fullText;
      block.component.updateContent(fullText, { transient: true });
      this.host.requestTerminalRender();
    }
  }

  onStreamingTextEnd(): void {
    const block = this._streamingBlock;
    if (block !== null) {
      block.component.updateContent(block.entry.content, { transient: false });
    }
    this._streamingBlock = null;
  }

  onThinkingUpdate(fullText: string): void {
    // Skip thinking that carries nothing visible — empty (e.g. encrypted
    // reasoning) or whitespace-only (a model occasionally streams a single
    // space as thinking). Session replay funnels through here as well, so a
    // stored whitespace-only think part never becomes a bare bullet line.
    if (
      fullText.trim().length === 0 &&
      this._activeThinkingComponent === undefined
    )
      return;
    const { state } = this.host;
    if (this._activeThinkingComponent === undefined) {
      this._pendingAgentGroup = null;
      this._pendingReadGroup = null;
      this._activeThinkingComponent = new ThinkingComponent(
        fullText,
        true,
        "live",
        state.ui,
      );
      if (state.toolOutputExpanded)
        this._activeThinkingComponent.setExpanded(true);
      state.transcriptContainer.addChild(this._activeThinkingComponent);
    } else {
      this._activeThinkingComponent.setText(fullText);
    }
    this.host.requestTerminalRender();
  }

  onThinkingEnd(): void {
    if (this._activeThinkingComponent === undefined) return;
    this._activeThinkingComponent.finalize();
    this._activeThinkingComponent = undefined;
    this.host.requestTerminalRender();
    this.host.mergeCurrentTurnSteps();
  }

  onToolCallStart(toolCall: ToolCallBlockData): void {
    if (toolCall.name === "AskUserQuestion") return;

    const { state } = this.host;
    const tc = new ToolCallComponent(
      toolCall,
      undefined,
      state.ui,
      state.appState.workDir,
    );
    if (state.toolOutputExpanded) tc.setExpanded(true);
    this._pendingToolComponents.set(toolCall.id, tc);
    this.toolGroups.attachInkToolCallMirror(tc);

    if (toolCall.name !== "Agent") this._pendingAgentGroup = null;
    if (toolCall.name !== "Read") this._pendingReadGroup = null;

    let handled = this.toolGroups.tryAttachAgentToolCall(toolCall, tc);
    if (!handled) handled = this.toolGroups.tryAttachReadToolCall(toolCall, tc);
    if (!handled) {
      state.transcriptContainer.addChild(tc);
      this.host.requestTerminalRender();
    }

    if (
      toolCall.name === "ExitPlanMode" &&
      typeof toolCall.args["plan"] !== "string"
    ) {
      const session = this.host.requireSession();
      void (async () => {
        try {
          const plan = await session.getPlan();
          tc.setPlanInfo(
            plan === null ? {} : { plan: plan.content, path: plan.path },
          );
        } catch {
          tc.setPlanInfo({});
        }
      })();
    }
  }

  onToolCallEnd(toolCallId: string, result: ToolResultBlockData): void {
    const { state } = this.host;
    const matchedCall = this._activeToolCalls.get(toolCallId);
    const tc = this._pendingToolComponents.get(toolCallId);
    if (tc) {
      tc.setResult(result);
      this._pendingToolComponents.delete(toolCallId);
      this.host.requestTerminalRender();
      this.host.mergeCurrentTurnSteps();
      return;
    }

    if (matchedCall?.name === "AskUserQuestion") {
      const completed = new ToolCallComponent(
        matchedCall,
        result,
        state.ui,
        state.appState.workDir,
      );
      if (state.toolOutputExpanded) completed.setExpanded(true);
      this.toolGroups.attachInkToolCallMirror(completed);
      state.transcriptContainer.addChild(completed);
      this.host.requestTerminalRender();
    }
    this.host.mergeCurrentTurnSteps();
  }

  setTodoList(todos: readonly TodoItem[]): void {
    const { state } = this.host;
    state.todoPanel.setTodos(todos);
    state.todoPanelContainer.clear();
    if (!state.todoPanel.isEmpty()) {
      state.todoPanelContainer.addChild(state.todoPanel);
    }
    this.host.requestTerminalRender();
  }

  beginCompaction(instruction?: string): void {
    const { state } = this.host;
    if (this._activeCompactionBlock !== undefined) {
      this._activeCompactionBlock.markDone();
      this._activeCompactionBlock = undefined;
      this._activeCompactionEntryId = undefined;
    }
    const entryId = nextTranscriptId();
    const mirrorCompactionToInk = (): void => {
      if (this._activeCompactionEntryId === undefined) return;
      if (this._activeCompactionBlock === undefined) return;
      this.host.syncCompactionTranscriptEntry(
        this._activeCompactionEntryId,
        this._activeCompactionBlock.captureCompactionTranscriptData(),
      );
    };
    const block = new CompactionComponent(
      state.ui,
      instruction,
      undefined,
      mirrorCompactionToInk,
    );
    this._activeCompactionBlock = block;
    this._activeCompactionEntryId = entryId;
    state.transcriptContainer.addChild(block);
    if (state.toolOutputExpanded) {
      block.setExpanded(true);
    }
    this.host.pushTranscriptEntry({
      id: entryId,
      kind: "status",
      renderMode: "plain",
      content: "",
      compactionData: block.captureCompactionTranscriptData(),
    });
    mirrorCompactionToInk();
    this.host.requestTerminalRender();
  }

  endCompaction(
    tokensBefore?: number,
    tokensAfter?: number,
    summary?: string,
  ): void {
    const block = this._activeCompactionBlock;
    if (block === undefined) return;
    block.markDone(tokensBefore, tokensAfter, summary);
    this._activeCompactionBlock = undefined;
    this._activeCompactionEntryId = undefined;
    this.host.requestTerminalRender();
  }

  cancelCompaction(): void {
    const block = this._activeCompactionBlock;
    if (block === undefined) return;
    block.markCanceled();
    this._activeCompactionBlock = undefined;
    this._activeCompactionEntryId = undefined;
    this.host.requestTerminalRender();
  }
}

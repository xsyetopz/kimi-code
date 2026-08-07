import { AgentGroupComponent } from "../components/messages/agent-group";
import { ReadGroupComponent } from "../components/messages/read-group";
import { ToolCallComponent } from "../components/messages/tool-call";
import {
  appendStreamingArgsPreview,
  parseStreamingArgs,
} from "../utils/event-payload";
import { nextTranscriptId } from "../utils/transcript-id";
import type { ToolCallBlockData } from "../types";
import type { StreamingUIHost } from "./streaming-ui";

type PendingAgentGroup = {
  readonly turnId: string | undefined;
  readonly step: number;
  solo?: ToolCallComponent;
  group?: AgentGroupComponent;
} | null;

type PendingReadGroup = {
  readonly turnId: string | undefined;
  readonly step: number;
  solo?: ToolCallComponent;
  group?: ReadGroupComponent;
} | null;

export interface StreamingUIToolGroupState {
  getStep(): number;
  getTurnId(): string | undefined;
  getThinkingDraft(): string;
  hasStreamingBlock(): boolean;
  getPendingAgentGroup(): PendingAgentGroup;
  setPendingAgentGroup(value: PendingAgentGroup): void;
  getPendingReadGroup(): PendingReadGroup;
  setPendingReadGroup(value: PendingReadGroup): void;
  getAgentGroupInkEntryId(): string | undefined;
  setAgentGroupInkEntryId(value: string | undefined): void;
  getReadGroupInkEntryId(): string | undefined;
  setReadGroupInkEntryId(value: string | undefined): void;
  getActiveToolCall(id: string): ToolCallBlockData | undefined;
  setActiveToolCall(id: string, toolCall: ToolCallBlockData): void;
  getStreamingToolCallArguments(
    id: string,
  ): { name?: string; argumentsText: string; startedAtMs: number } | undefined;
  getPendingToolComponent(id: string): ToolCallComponent | undefined;
  finalizeLiveTextBuffers(nextMode: "idle" | "tool"): void;
  onToolCallStart(toolCall: ToolCallBlockData): void;
}

export class StreamingUIToolGroups {
  constructor(
    private readonly host: StreamingUIHost,
    private readonly state: StreamingUIToolGroupState,
  ) {}

  attachInkToolCallMirror(tc: ToolCallComponent): void {
    tc.setProjectionListener(() => {
      this.mirrorToolCallToInk(tc);
    });
    this.mirrorToolCallToInk(tc);
  }

  mirrorToolCallToInk(tc: ToolCallComponent): void {
    const agentGroup = this.findActiveAgentGroupFor(tc.toolCallView.id);
    if (agentGroup !== undefined) {
      this.mirrorAgentGroupToInk(agentGroup);
      return;
    }
    const readGroup = this.findActiveReadGroupFor(tc.toolCallView.id);
    if (readGroup !== undefined) {
      this.mirrorReadGroupToInk(readGroup);
      return;
    }
    const data = tc.captureToolCallProjection();
    this.host.syncToolCallTranscriptEntry(data.id, data);
  }

  flushToolCallPreview(id: string): void {
    const streaming = this.state.getStreamingToolCallArguments(id);
    if (streaming === undefined) return;
    const toolCall: ToolCallBlockData = {
      id,
      name: streaming.name ?? this.state.getActiveToolCall(id)?.name ?? "Tool",
      args: parseStreamingArgs(streaming.argumentsText),
      streamingArguments: streaming.argumentsText,
      streamingStartedAtMs: streaming.startedAtMs,
      step: this.state.getStep(),
      turnId: this.state.getTurnId(),
    };
    this.state.setActiveToolCall(id, toolCall);

    if (this.state.getThinkingDraft().length > 0 || this.state.hasStreamingBlock()) {
      this.state.finalizeLiveTextBuffers("tool");
    }

    const existingComponent = this.state.getPendingToolComponent(id);
    if (existingComponent !== undefined) {
      existingComponent.updateToolCall(toolCall);
    } else if (toolCall.name !== "Agent" && toolCall.name !== "AgentSwarm") {
      this.state.onToolCallStart(toolCall);
    }
  }

  tryAttachAgentToolCall(
    toolCall: ToolCallBlockData,
    tc: ToolCallComponent,
  ): boolean {
    const { state } = this.host;
    if (toolCall.name !== "Agent") {
      this.state.setPendingAgentGroup(null);
      return false;
    }

    const step = toolCall.step ?? this.state.getStep();
    const turnId = toolCall.turnId ?? this.state.getTurnId();
    const pending = this.state.getPendingAgentGroup();

    if (
      pending !== null &&
      (pending.step !== step || pending.turnId !== turnId)
    ) {
      this.state.setPendingAgentGroup(null);
      this.state.setAgentGroupInkEntryId(undefined);
    }

    const cur = this.state.getPendingAgentGroup();
    if (cur === null) {
      this.state.setPendingAgentGroup({ step, turnId, solo: tc });
      state.transcriptContainer.addChild(tc);
      this.host.requestTerminalRender();
      return true;
    }

    if (cur.group !== undefined) {
      cur.group.attach(toolCall.id, tc);
      this.mirrorAgentGroupToInk(cur.group);
      return true;
    }

    const solo = cur.solo;
    if (solo === undefined) {
      this.state.setPendingAgentGroup({ step, turnId, solo: tc });
      state.transcriptContainer.addChild(tc);
      this.host.requestTerminalRender();
      return true;
    }
    const group = this.upgradeSoloAgentToGroup(solo);
    group.attach(toolCall.id, tc);
    this.state.setPendingAgentGroup({ step, turnId, group });
    this.mirrorAgentGroupToInk(group);
    this.host.requestTerminalRender();
    return true;
  }

  tryAttachReadToolCall(
    toolCall: ToolCallBlockData,
    tc: ToolCallComponent,
  ): boolean {
    const { state } = this.host;
    if (toolCall.name !== "Read") {
      this.state.setPendingReadGroup(null);
      return false;
    }

    const step = toolCall.step ?? this.state.getStep();
    const turnId = toolCall.turnId ?? this.state.getTurnId();
    const pending = this.state.getPendingReadGroup();

    if (
      pending !== null &&
      (pending.step !== step || pending.turnId !== turnId)
    ) {
      this.state.setPendingReadGroup(null);
      this.state.setReadGroupInkEntryId(undefined);
    }

    const cur = this.state.getPendingReadGroup();
    if (cur === null) {
      this.state.setPendingReadGroup({ step, turnId, solo: tc });
      state.transcriptContainer.addChild(tc);
      this.host.requestTerminalRender();
      return true;
    }

    if (cur.group !== undefined) {
      cur.group.attach(toolCall.id, tc);
      this.mirrorReadGroupToInk(cur.group);
      return true;
    }

    const solo = cur.solo;
    if (solo === undefined) {
      this.state.setPendingReadGroup({ step, turnId, solo: tc });
      state.transcriptContainer.addChild(tc);
      this.host.requestTerminalRender();
      return true;
    }
    const group = this.upgradeSoloReadToGroup(solo);
    group.attach(toolCall.id, tc);
    this.state.setPendingReadGroup({ step, turnId, group });
    this.mirrorReadGroupToInk(group);
    this.host.requestTerminalRender();
    return true;
  }

  private findActiveAgentGroupFor(
    toolCallId: string,
  ): AgentGroupComponent | undefined {
    const group = this.state.getPendingAgentGroup()?.group;
    if (group === undefined) return undefined;
    return group.containsToolCall(toolCallId) ? group : undefined;
  }

  private findActiveReadGroupFor(
    toolCallId: string,
  ): ReadGroupComponent | undefined {
    const group = this.state.getPendingReadGroup()?.group;
    if (group === undefined) return undefined;
    return group.containsToolCall(toolCallId) ? group : undefined;
  }

  private wireInkAgentGroupMirror(group: AgentGroupComponent): void {
    if (this.state.getAgentGroupInkEntryId() === undefined) {
      this.state.setAgentGroupInkEntryId(nextTranscriptId());
    }
    group.setInkMirrorListener(() => {
      this.mirrorAgentGroupToInk(group);
    });
  }

  private mirrorAgentGroupToInk(group: AgentGroupComponent): void {
    const entryId = this.state.getAgentGroupInkEntryId();
    if (entryId === undefined) return;
    this.host.syncAgentGroupTranscriptEntry(
      entryId,
      group.captureAgentGroupViewState(),
      group.getToolCallIds(),
    );
  }

  private wireInkReadGroupMirror(group: ReadGroupComponent): void {
    if (this.state.getReadGroupInkEntryId() === undefined) {
      this.state.setReadGroupInkEntryId(nextTranscriptId());
    }
    group.setInkMirrorListener(() => {
      this.mirrorReadGroupToInk(group);
    });
  }

  private mirrorReadGroupToInk(group: ReadGroupComponent): void {
    const entryId = this.state.getReadGroupInkEntryId();
    if (entryId === undefined) return;
    this.host.syncReadGroupTranscriptEntry(
      entryId,
      group.captureReadGroupViewState(),
      group.getToolCallIds(),
    );
  }

  private upgradeSoloAgentToGroup(
    solo: ToolCallComponent,
  ): AgentGroupComponent {
    const { state } = this.host;
    const group = new AgentGroupComponent(state.ui);
    const children = state.transcriptContainer.children;
    const idx = children.indexOf(solo);
    if (idx >= 0) {
      children[idx] = group;
    } else {
      state.transcriptContainer.addChild(group);
    }
    group.attach(solo.toolCallView.id, solo);
    this.wireInkAgentGroupMirror(group);
    return group;
  }

  private upgradeSoloReadToGroup(solo: ToolCallComponent): ReadGroupComponent {
    const { state } = this.host;
    const group = new ReadGroupComponent(state.ui);
    const children = state.transcriptContainer.children;
    const idx = children.indexOf(solo);
    if (idx >= 0) {
      children[idx] = group;
    } else {
      state.transcriptContainer.addChild(group);
    }
    group.attach(solo.toolCallView.id, solo);
    this.wireInkReadGroupMirror(group);
    return group;
  }
}

export interface StreamingUIReplayState {
  readonly host: StreamingUIHost;
  activeToolCalls: Map<string, ToolCallBlockData>;
  pendingToolComponents: Map<string, ToolCallComponent>;
  pendingToolCallFlushIds: Set<string>;
  streamingToolCallArguments: Map<
    string,
    { name?: string; argumentsText: string; startedAtMs: number }
  >;
  setPendingAgentGroup(value: PendingAgentGroup): void;
  setPendingReadGroup(value: PendingReadGroup): void;
  setTurnId(value: string | undefined): void;
  setStep(value: number): void;
}

export function markStreamingStepTruncated(
  state: StreamingUIReplayState,
  turnId: string,
  step: number,
): number {
  let count = 0;
  for (const toolCall of state.activeToolCalls.values()) {
    if (toolCall.result !== undefined) continue;
    if (toolCall.streamingArguments === undefined) continue;
    if (toolCall.turnId !== turnId) continue;
    if (toolCall.step !== step) continue;
    toolCall.truncated = true;
    const component = state.pendingToolComponents.get(toolCall.id);
    if (component !== undefined) {
      component.updateToolCall(toolCall);
    }
    count += 1;
  }
  state.streamingToolCallArguments.clear();
  return count;
}

export function cleanupStreamingAfterReplay(
  state: StreamingUIReplayState,
  completedToolCallIds: Set<string>,
): void {
  state.activeToolCalls.clear();
  for (const toolCallId of completedToolCallIds) {
    state.pendingToolComponents.delete(toolCallId);
  }
  state.setPendingAgentGroup(null);
  state.setPendingReadGroup(null);
  state.setTurnId(undefined);
  state.setStep(0);
  state.streamingToolCallArguments.clear();
  state.pendingToolCallFlushIds.clear();
  state.host.requestTerminalRender();
}

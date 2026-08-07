import type { Component } from "@moonshot-ai/kimi-tui";
import {
  BRAILLE_SPINNER_FRAMES,
  BRAILLE_SPINNER_INTERVAL_MS,
} from "#/tui/constant/rendering";
import { currentTheme } from "#/tui/theme";
import type { ToolCallBlockData, ToolResultBlockData } from "#/tui/types";
import type { TokenUsage } from "@moonshot-ai/kimi-code-sdk";
import {
  appendStreamingArgsPreview,
  parseStreamingArgs,
} from "#/tui/utils/event-payload";
import { formatTokenCount } from "#/utils/usage/usage-format";
import { extractKeyArgument } from "#/tui/projections/tool-call/key-argument";
import {
  deriveSubagentPhase,
  projectSingleSubagentHeader,
} from "#/tui/projections/tool-call/subagent";
import type { SubagentCardViewState, SubagentPhase } from "#/tui/types";

const MAX_SUB_TOOL_CALLS_SHOWN = 4;
const MAX_LIVE_OUTPUT_CHARS = 50_000;

type SubagentTextKind = "thinking" | "text";

interface FinishedSubCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly output: string;
  readonly isError: boolean;
}

interface OngoingSubCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly streamingArguments?: string | undefined;
}

interface SubToolActivity {
  readonly id: string;
  name: string;
  args: Record<string, unknown>;
  phase: "ongoing" | "done" | "failed";
  output?: string;
  readonly orderSeq: number;
}

/**
 * Immutable subagent state snapshot. `AgentGroupComponent` reads one-time
 * views via `ToolCallComponent.getSubagentSnapshot()` and renders its own
 * branch lines; `onSnapshotChange` notifies it when state changes.
 */
export interface ToolCallSubagentSnapshot {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly toolCallDescription: string;
  readonly agentName: string | undefined;
  readonly model?: string;
  readonly phase: SubagentPhase | undefined;
  readonly toolCount: number;
  readonly elapsedSeconds: number | undefined;
  readonly tokens: number;
  readonly isError: boolean;
  readonly errorText: string | undefined;
  readonly latestActivity: string | undefined;
}

export interface ToolCallSubagentGroupedView {
  readonly phaseChip: string;
  readonly agentName: string | undefined;
  readonly agentId: string;
  readonly hiddenSubCallCount: number;
  readonly finishedSubCalls: readonly {
    readonly name: string;
    readonly args: Record<string, unknown>;
    readonly isError: boolean;
  }[];
  readonly ongoingSubCalls: readonly {
    readonly name: string;
    readonly args: Record<string, unknown>;
  }[];
  readonly subagentText: string;
  readonly subagentPhase: SubagentPhase | undefined;
  readonly subagentResultSummary: string | undefined;
  readonly subagentError: string | undefined;
}

export interface ToolCallSubagentHost {
  readonly toolCall: ToolCallBlockData;
  readonly result: ToolResultBlockData | undefined;
  readonly workspaceDir: string | undefined;
  setHeaderText(text: string): void;
  addBodyChild(child: Component): void;
  rebuildContent(): void;
  notifySnapshotChange(): void;
  requestRender(): void;
}

function backgroundFailureMessage(
  status: "completed" | "failed" | "timed_out" | "killed" | "lost" | undefined,
): string | undefined {
  switch (status) {
    case "lost":
      return "Background agent lost (session restarted before completion)";
    case "killed":
      return "Background agent killed";
    case "timed_out":
      return "Background agent timed out";
    case "failed":
      return "Background agent failed";
    case "completed":
    case undefined:
      return undefined;
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function formatSubagentContextTokens(
  contextTokens: number | undefined,
): string | undefined {
  if (contextTokens === undefined || contextTokens <= 0) return undefined;
  return `${formatTokenCount(contextTokens)} tok`;
}

function usageInputTotal(usage: TokenUsage): number {
  return (
    (usage.inputOther ?? 0) +
    (usage.inputCacheRead ?? 0) +
    (usage.inputCacheCreation ?? 0)
  );
}

function usageTotal(usage: TokenUsage | undefined): number {
  if (usage === undefined) return 0;
  return usageInputTotal(usage) + usage.output;
}

function formatSubagentTokens(
  usage: TokenUsage | undefined,
): string | undefined {
  const total = usageTotal(usage);
  if (total <= 0) return undefined;
  return `${formatTokenCount(total)} tok`;
}

/** Subagent card state and events for {@link ToolCallComponent}. */
export class ToolCallSubagentFacet {
  private subagentAgentId: string | undefined;
  private subagentAgentName: string | undefined;
  private readonly ongoingSubCalls = new Map<string, OngoingSubCall>();
  private readonly finishedSubCalls: FinishedSubCall[] = [];
  private readonly subToolActivities = new Map<string, SubToolActivity>();
  private subToolOrderSeq = 0;
  private hiddenSubCallCount = 0;
  private subagentText = "";
  private subagentThinkingText = "";
  private lastSubagentStreamKind: SubagentTextKind = "text";
  private subagentPhase: SubagentPhase | undefined;
  private detachedFromForeground = false;
  private backgroundTaskTerminalPhase: "done" | "failed" | undefined;
  private subagentContextTokens: number | undefined;
  private subagentUsage: TokenUsage | undefined;
  private subagentModel: string | undefined;
  private subagentResultSummary: string | undefined;
  private subagentError: string | undefined;
  private subagentElapsedTimer: ReturnType<typeof setInterval> | undefined;
  private subagentStartedAtMs: number | undefined;
  private subagentEndedAtMs: number | undefined;
  private subagentSpinnerFrame = 0;

  constructor(private readonly host: ToolCallSubagentHost) {}

  applyReplay(subagent: ToolCallBlockData["subagent"]): void {
    if (subagent === undefined) return;
    this.subagentAgentId = subagent.id;
    this.subagentAgentName = subagent.name;
    this.subagentText = subagent.text ?? "";
    for (const call of subagent.toolCalls ?? []) {
      if (call.result === undefined) {
        this.ongoingSubCalls.set(call.id, { name: call.name, args: call.args });
        this.upsertSubToolActivity(call.id, call.name, call.args, "ongoing");
        continue;
      }
      this.finishedSubCalls.push({
        name: call.name,
        args: call.args,
        output: call.result.output,
        isError: call.result.is_error ?? false,
      });
      this.upsertSubToolActivity(
        call.id,
        call.name,
        call.args,
        call.result.is_error === true ? "failed" : "done",
        call.result.output,
      );
    }
    while (this.finishedSubCalls.length > MAX_SUB_TOOL_CALLS_SHOWN) {
      this.finishedSubCalls.shift();
      this.hiddenSubCallCount += 1;
    }
  }

  setMeta(agentId: string, agentName?: string): void {
    if (
      this.subagentAgentId === agentId &&
      this.subagentAgentName === agentName
    ) {
      return;
    }
    this.subagentAgentId = agentId;
    this.subagentAgentName = agentName;
    this.host.setHeaderText(this.buildHeader());
    this.host.rebuildContent();
    this.host.notifySnapshotChange();
    this.host.requestRender();
  }

  getSnapshot(): ToolCallSubagentSnapshot {
    const finished = this.finishedSubCalls.length + this.hiddenSubCallCount;
    const contextTokens = this.subagentContextTokens;
    const tokens =
      contextTokens && contextTokens > 0
        ? contextTokens
        : this.subagentUsage === undefined
          ? 0
          : usageTotal(this.subagentUsage);
    const derivedPhase = this.getDerivedPhase();
    const errorText =
      this.subagentError ??
      (derivedPhase === "failed" ? this.host.result?.output : undefined);
    return {
      toolCallId: this.host.toolCall.id,
      toolName: this.host.toolCall.name,
      toolCallDescription:
        str(this.host.toolCall.args["description"]) ||
        str(this.host.toolCall.description),
      agentName: this.subagentAgentName,
      model: this.subagentModel,
      phase: derivedPhase,
      toolCount: finished,
      elapsedSeconds: this.getElapsedSeconds(),
      tokens,
      isError: derivedPhase === "failed",
      errorText,
      latestActivity: computeLatestActivity(
        this.ongoingSubCalls,
        this.finishedSubCalls,
        this.getCombinedText(),
        this.host.workspaceDir,
      ),
    };
  }

  captureCardState(): SubagentCardViewState {
    const toolActivities = [...this.subToolActivities.values()]
      .sort((a, b) => a.orderSeq - b.orderSeq)
      .map(({ name, args, phase, output }) => ({
        name,
        args,
        phase,
        ...(output !== undefined ? { output } : {}),
      }));
    return {
      phase: this.subagentPhase,
      agentName: this.subagentAgentName,
      model: this.subagentModel,
      spinnerFrame: this.subagentSpinnerFrame,
      toolActivities,
      subagentText: this.subagentText,
      subagentThinkingText: this.subagentThinkingText,
      lastStreamKind: this.lastSubagentStreamKind,
      subagentError: this.subagentError,
      contextTokens: this.subagentContextTokens,
      usageTokens:
        this.subagentUsage === undefined
          ? undefined
          : usageTotal(this.subagentUsage),
      elapsedSeconds: this.getElapsedSeconds(),
      detachedFromForeground: this.detachedFromForeground,
      backgroundTerminalPhase: this.backgroundTaskTerminalPhase,
    };
  }

  isSingleSubagentView(): boolean {
    return this.host.toolCall.name === "Agent" && this.hasState();
  }

  buildHeader(): string {
    if (this.isSingleSubagentView()) {
      return projectSingleSubagentHeader({
        toolCall: this.host.toolCall,
        result: this.host.result,
        card: this.captureCardState(),
      });
    }
    return "";
  }

  hasVisibleBlock(): boolean {
    return this.hasState();
  }

  getGroupedBlockView(): ToolCallSubagentGroupedView | undefined {
    if (!this.hasVisibleBlock() || this.isSingleSubagentView())
      return undefined;
    return {
      phaseChip: this.formatPhaseChip(),
      agentName: this.subagentAgentName,
      agentId: this.formatAgentId(),
      hiddenSubCallCount: this.hiddenSubCallCount,
      finishedSubCalls: this.finishedSubCalls,
      ongoingSubCalls: [...this.ongoingSubCalls.values()],
      subagentText: this.subagentText,
      subagentPhase: this.subagentPhase,
      subagentResultSummary: this.subagentResultSummary,
      subagentError: this.subagentError,
    };
  }

  syncElapsedTimer(): void {
    const phase = this.getDerivedPhase();
    const shouldTick =
      this.isSingleSubagentView() &&
      this.subagentStartedAtMs !== undefined &&
      (phase === "queued" || phase === "spawning" || phase === "running");
    if (!shouldTick) {
      this.stopElapsedTimer();
      return;
    }
    if (this.subagentElapsedTimer !== undefined) return;
    this.subagentElapsedTimer = setInterval(() => {
      const latestPhase = this.getDerivedPhase();
      if (
        latestPhase !== "queued" &&
        latestPhase !== "spawning" &&
        latestPhase !== "running"
      ) {
        this.stopElapsedTimer();
        return;
      }
      this.subagentSpinnerFrame =
        (this.subagentSpinnerFrame + 1) % BRAILLE_SPINNER_FRAMES.length;
      this.host.setHeaderText(this.buildHeader());
      this.host.notifySnapshotChange();
      this.host.requestRender();
    }, BRAILLE_SPINNER_INTERVAL_MS);
  }

  stopElapsedTimer(): void {
    if (this.subagentElapsedTimer === undefined) return;
    clearInterval(this.subagentElapsedTimer);
    this.subagentElapsedTimer = undefined;
  }

  finalizeElapsedIfNeeded(): void {
    if (
      this.host.toolCall.name === "Agent" &&
      this.subagentStartedAtMs !== undefined &&
      this.subagentEndedAtMs === undefined
    ) {
      this.subagentEndedAtMs = Date.now();
    }
  }

  onSpawned(meta: {
    agentId: string;
    agentName?: string | undefined;
    runInBackground: boolean;
  }): void {
    this.subagentAgentId = meta.agentId;
    this.subagentAgentName = meta.agentName;
    this.subagentPhase = meta.runInBackground ? "backgrounded" : "queued";
    this.subagentStartedAtMs = Date.now();
    this.subagentEndedAtMs = undefined;
    this.syncElapsedTimer();
    this.host.setHeaderText(this.buildHeader());
    this.host.rebuildContent();
    this.host.notifySnapshotChange();
    this.host.requestRender();
  }

  onStarted(meta: {
    agentId: string;
    agentName?: string | undefined;
    runInBackground: boolean;
  }): void {
    this.subagentAgentId = meta.agentId;
    this.subagentAgentName = meta.agentName;
    if (
      !meta.runInBackground &&
      (this.subagentPhase === undefined || this.subagentPhase === "queued")
    ) {
      this.subagentPhase = "running";
    }
    this.syncElapsedTimer();
    this.host.setHeaderText(this.buildHeader());
    this.host.rebuildContent();
    this.host.notifySnapshotChange();
    this.host.requestRender();
  }

  onCompleted(payload: {
    contextTokens?: number | undefined;
    usage?: TokenUsage | undefined;
    resultSummary: string;
  }): void {
    this.subagentPhase = "done";
    this.subagentEndedAtMs ??= Date.now();
    if (payload.contextTokens !== undefined && payload.contextTokens > 0) {
      this.subagentContextTokens = payload.contextTokens;
    }
    this.subagentUsage = payload.usage;
    this.subagentResultSummary =
      payload.resultSummary.length > 0 ? payload.resultSummary : undefined;
    if (
      this.subagentText.trim().length === 0 &&
      this.subagentResultSummary !== undefined
    ) {
      this.subagentText = this.subagentResultSummary;
    }
    this.syncElapsedTimer();
    this.host.setHeaderText(this.buildHeader());
    this.host.rebuildContent();
    this.host.notifySnapshotChange();
    this.host.requestRender();
  }

  updateMetrics(payload: {
    contextTokens?: number | undefined;
    usage?: TokenUsage | undefined;
    modelDisplay?: string | undefined;
  }): void {
    if (payload.contextTokens !== undefined && payload.contextTokens > 0) {
      this.subagentContextTokens = payload.contextTokens;
    }
    if (payload.usage !== undefined) {
      this.subagentUsage = payload.usage;
    }
    if (payload.modelDisplay !== undefined) {
      this.subagentModel = payload.modelDisplay;
    }
    this.host.setHeaderText(this.buildHeader());
    this.host.notifySnapshotChange();
    this.host.requestRender();
  }

  onFailed(payload: { error: string }): void {
    this.subagentPhase = "failed";
    this.subagentEndedAtMs ??= Date.now();
    this.subagentError = payload.error;
    this.syncElapsedTimer();
    this.host.setHeaderText(this.buildHeader());
    this.host.rebuildContent();
    this.host.notifySnapshotChange();
    this.host.requestRender();
  }

  setBackgroundTaskTerminalStatus(
    status: "completed" | "failed" | "timed_out" | "killed" | "lost",
    options: { errorText?: string | undefined } = {},
  ): void {
    const phase: "done" | "failed" = status === "completed" ? "done" : "failed";
    const { errorText } = options;
    const phaseUnchanged = this.backgroundTaskTerminalPhase === phase;
    let errorChanged = false;
    if (phase === "failed") {
      if (errorText !== undefined && this.subagentError !== errorText) {
        this.subagentError = errorText;
        errorChanged = true;
      } else if (this.subagentError === undefined) {
        const generic = backgroundFailureMessage(status);
        if (generic !== undefined) {
          this.subagentError = generic;
          errorChanged = true;
        }
      }
    }
    if (phaseUnchanged && !errorChanged) return;
    this.backgroundTaskTerminalPhase = phase;
    this.subagentEndedAtMs ??= Date.now();
    this.syncElapsedTimer();
    this.host.setHeaderText(this.buildHeader());
    this.host.rebuildContent();
    this.host.notifySnapshotChange();
  }

  markBackgrounded(): void {
    if (this.detachedFromForeground) return;
    this.detachedFromForeground = true;
    this.subagentPhase = "backgrounded";
    this.host.setHeaderText(this.buildHeader());
    this.host.rebuildContent();
    this.host.notifySnapshotChange();
    this.host.requestRender();
  }

  getAgentId(): string | undefined {
    if (this.subagentAgentId !== undefined) return this.subagentAgentId;
    if (this.host.toolCall.name !== "Agent" || this.host.result === undefined) {
      return undefined;
    }
    const match = this.host.result.output.match(
      /^agent_id:\s*(agent-[A-Za-z0-9_-]+)/m,
    );
    return match?.[1];
  }

  getAgentToolDescription(): string | undefined {
    if (this.host.toolCall.name !== "Agent") return undefined;
    const desc = this.host.toolCall.args["description"];
    return typeof desc === "string" ? desc : undefined;
  }

  appendText(text: string, kind: SubagentTextKind = "text"): void {
    this.lastSubagentStreamKind = kind;
    if (kind === "thinking") {
      this.subagentThinkingText += text;
    } else {
      this.subagentText += text;
    }
    if (
      this.subagentPhase === undefined ||
      this.subagentPhase === "queued" ||
      this.subagentPhase === "spawning"
    ) {
      this.subagentPhase = "running";
    }
    this.host.setHeaderText(this.buildHeader());
    this.host.rebuildContent();
    this.host.notifySnapshotChange();
    this.host.requestRender();
  }

  appendSubToolCall(call: {
    id: string;
    name: string;
    args: Record<string, unknown>;
  }): void {
    const existing = this.ongoingSubCalls.get(call.id);
    this.ongoingSubCalls.set(call.id, {
      name: call.name,
      args: call.args,
      ...(existing?.streamingArguments !== undefined
        ? { streamingArguments: existing.streamingArguments }
        : {}),
    });
    this.upsertSubToolActivity(call.id, call.name, call.args, "ongoing");
    this.promoteToRunningIfNeeded();
    this.afterSubToolChange();
  }

  appendSubToolCallDelta(delta: {
    id: string;
    name?: string | undefined;
    argumentsPart: string | null;
  }): void {
    const existing = this.ongoingSubCalls.get(delta.id);
    const nextArgsText = appendStreamingArgsPreview(
      existing?.streamingArguments,
      delta.argumentsPart,
    );
    const parsed = parseStreamingArgs(nextArgsText);
    this.ongoingSubCalls.set(delta.id, {
      name: delta.name ?? existing?.name ?? "Tool",
      args: parsed,
      streamingArguments: nextArgsText,
    });
    this.upsertSubToolActivity(
      delta.id,
      delta.name ?? existing?.name ?? "Tool",
      parsed,
      "ongoing",
    );
    this.promoteToRunningIfNeeded();
    this.afterSubToolChange();
  }

  appendSubToolLiveOutput(id: string, text: string): void {
    if (text.length === 0) return;
    const activity = this.subToolActivities.get(id);
    const ongoing = this.ongoingSubCalls.get(id);
    if (activity === undefined && ongoing === undefined) return;
    const name = activity?.name ?? ongoing?.name ?? "Tool";
    const args = activity?.args ?? ongoing?.args ?? {};
    const existingOutput = activity?.output ?? "";
    let output = existingOutput + text;
    if (output.length > MAX_LIVE_OUTPUT_CHARS) {
      output = `[...truncated]\n${output.slice(output.length - MAX_LIVE_OUTPUT_CHARS)}`;
    }
    this.upsertSubToolActivity(
      id,
      name,
      args,
      activity?.phase ?? "ongoing",
      output,
    );
    this.host.rebuildContent();
    this.host.notifySnapshotChange();
    this.host.requestRender();
  }

  finishSubToolCall(result: {
    tool_call_id: string;
    output: string;
    is_error?: boolean | undefined;
  }): void {
    const ongoing = this.ongoingSubCalls.get(result.tool_call_id);
    if (ongoing === undefined) return;
    this.ongoingSubCalls.delete(result.tool_call_id);
    this.finishedSubCalls.push({
      name: ongoing.name,
      args: ongoing.args,
      output: result.output,
      isError: result.is_error ?? false,
    });
    this.upsertSubToolActivity(
      result.tool_call_id,
      ongoing.name,
      ongoing.args,
      result.is_error === true ? "failed" : "done",
      result.output,
    );
    while (this.finishedSubCalls.length > MAX_SUB_TOOL_CALLS_SHOWN) {
      this.finishedSubCalls.shift();
      this.hiddenSubCallCount += 1;
    }
    this.afterSubToolChange();
  }

  private afterSubToolChange(): void {
    this.host.setHeaderText(this.buildHeader());
    this.host.rebuildContent();
    this.host.notifySnapshotChange();
    this.host.requestRender();
  }

  private promoteToRunningIfNeeded(): void {
    if (
      this.subagentPhase === undefined ||
      this.subagentPhase === "queued" ||
      this.subagentPhase === "spawning"
    ) {
      this.subagentPhase = "running";
    }
  }

  private upsertSubToolActivity(
    id: string,
    name: string,
    args: Record<string, unknown>,
    phase: SubToolActivity["phase"],
    output?: string,
  ): void {
    const existing = this.subToolActivities.get(id);
    if (existing !== undefined) {
      existing.name = name;
      existing.args = args;
      existing.phase = phase;
      if (output !== undefined) existing.output = output;
      return;
    }
    this.subToolActivities.set(id, {
      id,
      name,
      args,
      phase,
      ...(output !== undefined ? { output } : {}),
      orderSeq: ++this.subToolOrderSeq,
    });
  }

  private getCombinedText(): string {
    return [this.subagentThinkingText, this.subagentText]
      .filter((s) => s.length > 0)
      .join("\n");
  }

  private formatPhaseChip(): string {
    if (this.subagentPhase === undefined) return "";
    const parts: string[] = [];
    switch (this.subagentPhase) {
      case "queued":
        parts.push("○ queued");
        break;
      case "spawning":
        parts.push("↻ starting…");
        break;
      case "running":
        parts.push("↻ running");
        break;
      case "done": {
        parts.push(currentTheme.fg("success", "✓ done"));
        const toolCount =
          this.finishedSubCalls.length + this.hiddenSubCallCount;
        if (toolCount > 0) {
          parts.push(`${String(toolCount)} tool${toolCount > 1 ? "s" : ""}`);
        }
        const tokens =
          formatSubagentContextTokens(this.subagentContextTokens) ??
          formatSubagentTokens(this.subagentUsage);
        if (tokens !== undefined) parts.push(tokens);
        break;
      }
      case "failed":
        parts.push(currentTheme.fg("error", "✗ failed"));
        break;
      case "backgrounded":
        parts.push("◐ backgrounded");
        break;
    }
    return parts.length > 0 ? currentTheme.dim(` · ${parts.join(" · ")}`) : "";
  }

  private formatAgentId(): string {
    const id = this.subagentAgentId ?? "";
    return id.length > 10 ? id.slice(0, 10) + "…" : id;
  }

  private hasState(): boolean {
    return (
      this.subagentAgentId !== undefined ||
      this.ongoingSubCalls.size > 0 ||
      this.finishedSubCalls.length > 0 ||
      this.subToolActivities.size > 0 ||
      this.subagentText.length > 0 ||
      this.subagentThinkingText.length > 0 ||
      this.subagentPhase !== undefined ||
      this.backgroundTaskTerminalPhase !== undefined
    );
  }

  private getDerivedPhase(): SubagentPhase | undefined {
    return deriveSubagentPhase({
      card: this.captureCardState(),
      result: this.host.result,
    });
  }

  private getElapsedSeconds(): number | undefined {
    if (this.subagentStartedAtMs === undefined) return undefined;
    const end = this.subagentEndedAtMs ?? Date.now();
    return Math.max(0, Math.floor((end - this.subagentStartedAtMs) / 1000));
  }
}

function computeLatestActivity(
  ongoing: ReadonlyMap<string, OngoingSubCall>,
  finished: readonly FinishedSubCall[],
  text: string,
  workspaceDir?: string,
): string | undefined {
  if (ongoing.size > 0) {
    const lastOngoing = [...ongoing.values()].at(-1);
    if (lastOngoing !== undefined) {
      return formatActivityLine(
        "Using",
        lastOngoing.name,
        lastOngoing.args,
        workspaceDir,
      );
    }
  }
  if (finished.length > 0) {
    const last = finished.at(-1);
    if (last !== undefined) {
      return formatActivityLine("Used", last.name, last.args, workspaceDir);
    }
  }
  if (text.length > 0) {
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line !== undefined && line.trim().length > 0) {
        return line.trim();
      }
    }
  }
  return undefined;
}

function formatActivityLine(
  verb: string,
  toolName: string,
  args: Record<string, unknown>,
  workspaceDir?: string,
): string {
  const keyArg = extractKeyArgument(toolName, args, workspaceDir);
  return keyArg ? `${verb} ${toolName} (${keyArg})` : `${verb} ${toolName}`;
}

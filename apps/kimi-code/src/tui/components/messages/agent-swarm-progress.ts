import type { Component } from "@moonshot-ai/kimi-tui";

import { currentTheme } from "#/tui/theme";
import type { ColorPalette } from "#/tui/theme/colors";
import type { AgentSwarmProgressViewState } from "#/tui/types";

import {
  agentSwarmDescriptionFromArgs,
  agentSwarmFailureTextFromOutput,
  agentSwarmItemsFromArgs,
  agentSwarmPartialItemsCountFromArguments,
  agentSwarmPartialItemsFromArguments,
  agentSwarmResultSummaryFromOutput,
  normalizeFailureText,
  type AgentSwarmResultSummary,
} from "#/tui/components/messages/agent-swarm-progress-parse";
import {
  agentSwarmGridHeightForTerminalRows,
  calculateAgentSwarmGridLayout,
  type AgentSwarmGridLayoutInput,
} from "#/tui/components/messages/agent-swarm-progress-layout";
import {
  renderAgentSwarmProgressLines,
  type AgentSwarmGridLayout,
} from "#/tui/components/messages/agent-swarm-progress-render";
import {
  applyAgentSwarmProgressViewState,
  applyAgentSwarmResult,
  cancelMember,
  captureAgentSwarmProgressState,
  completeMember,
  createAgentSwarmProgressCoreState,
  failMember,
  findMemberByAgentId,
  findMemberForSubagent,
  hasAnimatedMembers,
  hasSubagentExecutionStarted,
  isTerminalPhase,
  MAX_LATEST_MODEL_CHARS,
  promoteToRunning,
  TERMINAL_CLEAR_KEYS,
  type AgentSwarmProgressCoreState,
  clearMemberState,
  updateAgentSwarmArgs,
} from "#/tui/components/messages/agent-swarm-progress-state";

const FRAME_INTERVAL_MS = 80;

export interface AgentSwarmProgressOptions {
  readonly description: string;
  readonly requestRender?: () => void;
  readonly availableGridHeight?: () => number | undefined;
}

export interface RenderAgentSwarmProgressViewOptions {
  readonly availableGridHeight?: () => number | undefined;
}

export class AgentSwarmProgressComponent implements Component {
  private readonly core: AgentSwarmProgressCoreState;
  private readonly requestRender: (() => void) | undefined;
  private readonly availableGridHeight: (() => number | undefined) | undefined;
  private activitySpinnerText: (() => string) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private projectionListener: (() => void) | undefined;

  constructor(options: AgentSwarmProgressOptions) {
    this.core = createAgentSwarmProgressCoreState(options.description);
    this.requestRender = options.requestRender;
    this.availableGridHeight = options.availableGridHeight;
  }

  /** Live palette, read on each render so a theme switch recolors the panel. */
  private get colors(): ColorPalette {
    return currentTheme.palette;
  }

  dispose(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  invalidate(): void {}

  /** Ink transcript mirror — called whenever projection-relevant state changes. */
  setProjectionListener(listener: (() => void) | undefined): void {
    this.projectionListener = listener;
  }

  captureAgentSwarmProgressState(): AgentSwarmProgressViewState {
    return captureAgentSwarmProgressState(
      this.core,
      this.activitySpinnerText?.() ?? "",
    );
  }

  /** Rehydrate a detached snapshot for Ink projection or replay rendering. */
  applyViewState(state: AgentSwarmProgressViewState): void {
    applyAgentSwarmProgressViewState(this.core, state, this.colors);
  }

  setActivitySpinnerText(provider: (() => string) | undefined): void {
    if (!this.core.toolCallActive) return;
    this.activitySpinnerText = provider;
  }

  /**
   * Show the bound model once in the header. Every swarm member binds to the
   * same model, so the first child status update wins and later ones (e.g.
   * from resumed agents that kept a different binding) do not churn it.
   */
  setModelDisplay(modelDisplay: string): void {
    if (this.core.modelDisplay.length > 0 || modelDisplay.length === 0) return;
    this.core.modelDisplay = modelDisplay;
  }

  markToolCallEnded(): void {
    this.core.toolCallActive = false;
    this.activitySpinnerText = undefined;
  }

  isToolCallActive(): boolean {
    return this.core.toolCallActive;
  }

  isRequestStreaming(): boolean {
    return !this.core.inputComplete;
  }

  updateArgs(
    args: Record<string, unknown>,
    options: { readonly streamingArguments?: string | undefined } = {},
  ): void {
    updateAgentSwarmArgs(this.core, args, options.streamingArguments);
  }

  markInputComplete(): void {
    if (!this.core.inputComplete) {
      this.core.inputComplete = true;
      for (const member of this.core.members) {
        if (member.phase === "pending") member.phase = "queued";
      }
    }
    this.startAnimationIfNeeded();
  }

  registerSubagent(input: {
    readonly agentId: string;
    readonly swarmIndex?: number;
    readonly description?: string | undefined;
  }): void {
    const member = findMemberForSubagent(
      this.core,
      input.agentId,
      input.swarmIndex,
    );
    if (member === undefined) return;
    member.agentId = input.agentId;
    if (member.phase === "pending") member.phase = "queued";
    this.startAnimationIfNeeded();
  }

  markStarted(agentId: string): void {
    const member = findMemberByAgentId(this.core, agentId);
    if (member === undefined) return;
    const nowMs = Date.now();
    this.core.progressEstimator.markStarted(member.id, nowMs);
    member.ticks = Math.max(member.ticks, 1);
    promoteToRunning(this.core, member, nowMs);
    this.startAnimationIfNeeded();
  }

  recordToolCall(input: {
    readonly agentId: string;
    readonly toolCallId: string;
  }): void {
    const member = findMemberByAgentId(this.core, input.agentId);
    if (member === undefined) return;
    const result = this.core.progressEstimator.recordToolCall({
      memberKey: member.id,
      toolCallId: input.toolCallId,
      nowMs: Date.now(),
    });
    if (!result.accepted) return;
    member.ticks = result.rawTicks;
    promoteToRunning(this.core, member);
    this.startAnimationIfNeeded();
  }

  appendModelDelta(input: {
    readonly agentId: string;
    readonly delta: string;
  }): void {
    const member = findMemberByAgentId(this.core, input.agentId);
    if (member === undefined || input.delta.length === 0) return;
    member.latestModelText = `${member.latestModelText}${input.delta}`.slice(
      -MAX_LATEST_MODEL_CHARS,
    );
    promoteToRunning(this.core, member, Date.now(), true);
  }

  markCompleted(agentId: string, completedText?: string): void {
    const member = findMemberByAgentId(this.core, agentId);
    if (
      member === undefined ||
      member.phase === "failed" ||
      member.phase === "cancelled"
    )
      return;
    completeMember(this.core, member, Date.now(), completedText);
    this.startAnimationIfNeeded();
  }

  markSuspended(input: {
    readonly agentId: string;
    readonly reason: string;
    readonly swarmIndex?: number;
    readonly description?: string | undefined;
  }): void {
    const member =
      findMemberByAgentId(this.core, input.agentId) ??
      findMemberForSubagent(this.core, input.agentId, input.swarmIndex);
    if (
      member === undefined ||
      member.phase === "completed" ||
      member.phase === "cancelled"
    )
      return;
    member.agentId = input.agentId;
    this.core.progressEstimator.markQueued(member.id, Date.now());
    member.phase = "suspended";
    clearMemberState(member, ...TERMINAL_CLEAR_KEYS);
    this.startAnimationIfNeeded();
  }

  markFailed(agentId: string, failureText?: string): void {
    const member = findMemberByAgentId(this.core, agentId);
    if (member === undefined) return;
    failMember(this.core, member, Date.now(), failureText);
    this.startAnimationIfNeeded();
  }

  markSwarmFailed(failureText?: string): void {
    this.core.failed = true;
    this.core.aborted = false;
    const nowMs = Date.now();
    const normalizedFailureText = normalizeFailureText(failureText);
    if (
      normalizedFailureText !== undefined &&
      !hasSubagentExecutionStarted(this.core)
    ) {
      this.core.swarmFailureText = normalizedFailureText;
      for (const member of this.core.members) {
        if (isTerminalPhase(member.phase)) continue;
        failMember(this.core, member, nowMs, undefined);
      }
    } else {
      this.core.swarmFailureText = undefined;
      for (const member of this.core.members) {
        if (isTerminalPhase(member.phase)) continue;
        failMember(this.core, member, nowMs, failureText);
      }
    }
    this.startAnimationIfNeeded();
  }

  markCancelled(agentId: string): void {
    const member = findMemberByAgentId(this.core, agentId);
    if (member === undefined) return;
    cancelMember(this.core, member, Date.now(), this.colors);
  }

  markActiveCancelled(): void {
    this.core.aborted = true;
    const nowMs = Date.now();
    for (const member of this.core.members) {
      if (isTerminalPhase(member.phase)) continue;
      cancelMember(this.core, member, nowMs, this.colors);
    }
    this.startAnimationIfNeeded();
  }

  applyResult(output: string): boolean {
    const applied = applyAgentSwarmResult(this.core, output, this.colors);
    if (applied) this.startAnimationIfNeeded();
    return applied;
  }

  render(width: number): string[] {
    const lines = renderAgentSwarmProgressLines(
      {
        state: this.core,
        colors: this.colors,
        activitySpinnerText: this.activitySpinnerText,
        availableGridHeight: this.availableGridHeight,
      },
      width,
    );
    this.startAnimationIfNeeded();
    return lines;
  }

  private startAnimationIfNeeded(): void {
    if (this.requestRender === undefined || this.timer !== undefined) return;
    if (!hasAnimatedMembers(this.core)) return;
    const requestRender = this.requestRender;
    this.timer = setInterval(() => {
      requestRender();
      if (!hasAnimatedMembers(this.core)) this.dispose();
    }, FRAME_INTERVAL_MS);
    if (typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
  }
}

/** Render a captured swarm snapshot with the same layout as the live pi-tui card. */
export function renderAgentSwarmProgressView(
  state: AgentSwarmProgressViewState,
  width: number,
  options: RenderAgentSwarmProgressViewOptions = {},
): string[] {
  const component = new AgentSwarmProgressComponent({
    description: state.description,
    availableGridHeight: options.availableGridHeight,
  });
  component.applyViewState(state);
  return component.render(width);
}

export {
  agentSwarmDescriptionFromArgs,
  agentSwarmFailureTextFromOutput,
  agentSwarmGridHeightForTerminalRows,
  agentSwarmItemsFromArgs,
  agentSwarmPartialItemsCountFromArguments,
  agentSwarmPartialItemsFromArguments,
  agentSwarmResultSummaryFromOutput,
  calculateAgentSwarmGridLayout,
  type AgentSwarmGridLayout,
  type AgentSwarmGridLayoutInput,
  type AgentSwarmResultSummary,
};

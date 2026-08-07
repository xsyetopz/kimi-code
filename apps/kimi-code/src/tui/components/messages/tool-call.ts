/**
 * Renders a tool call entry in the transcript.
 * Supports expand/collapse via Ctrl+O.
 */

import { Container, Spacer, Text } from "@moonshot-ai/kimi-tui";
import type { Component, TUI } from "@moonshot-ai/kimi-tui";
import { RESULT_PREVIEW_LINES } from "#/tui/constant/rendering";
import { currentTheme } from "#/tui/theme";
import { createMarkdownTheme } from "#/tui/theme/kimi-tui-theme";
import type { TokenUsage } from "@moonshot-ai/kimi-code-sdk";
import type { ToolCallBlockData, ToolResultBlockData } from "#/tui/types";
import { isRenderCacheEnabled } from "#/tui/utils/render-cache";
import {
  APPROVED_PLAN_MARKER,
  AUTO_APPROVED_PLAN_MARKER,
} from "#/tui/projections/tool-call/exit-plan-mode";
import {
  extractKeyArgument,
  makeWorkspaceRelativePath,
} from "#/tui/projections/tool-call/key-argument";
import { projectToolCallHeader } from "#/tui/projections/tool-call/header";
import { projectSingleSubagentBodyLines } from "#/tui/projections/tool-call/subagent";
import type { SubagentCardViewState } from "#/tui/types";

import { ShellExecutionComponent } from "./shell-execution";
import { countNonEmptyLines } from "./tool-renderers/chip";
import {
  ToolCallResultFacet,
  type ToolCallResultHost,
} from "./tool-call-result";
import {
  ToolCallSubagentFacet,
  type ToolCallSubagentGroupedView,
  type ToolCallSubagentHost,
  type ToolCallSubagentSnapshot,
} from "./tool-call-subagent";

export type { ToolCallSubagentSnapshot } from "./tool-call-subagent";

const STREAMING_PROGRESS_INTERVAL_MS = 1000;
const PROGRESS_URL_RE = /https?:\/\/\S+/g;
const MAX_LIVE_OUTPUT_CHARS = 50_000;

/** Delay before a long-running foreground Bash/Agent card advertises Ctrl+B. */
const DETACH_HINT_DELAY_MS = 10_000;
const DETACH_HINT_TEXT = "Press Ctrl+B to run in background";

/**
 * Immutable Read tool state snapshot. `ReadGroupComponent` reads one-time
 * views via `ToolCallComponent.getReadSnapshot()` and sums lines for the group
 * header. `lines` is 0 while pending or failed, and the non-empty result line
 * count when done, matching the single-card chip.
 */
export interface ToolCallReadSnapshot {
  readonly toolCallId: string;
  readonly filePath: string | undefined;
  readonly phase: "pending" | "done" | "failed";
  readonly lines: number;
}

export class ToolCallComponent extends Container {
  private expanded = false;
  private toolCall: ToolCallBlockData;
  private readonly markdownTheme = createMarkdownTheme();
  private result: ToolResultBlockData | undefined;
  private ui: TUI | undefined;
  private planPath: string | undefined;
  private currentPlan: string | undefined;
  private headerText: Text;
  private callPreviewEndIndex = 0;

  private progressLines: string[] = [];
  private static readonly MAX_PROGRESS_LINES = 24;
  private liveOutput = "";

  private detachHintTimer: ReturnType<typeof setTimeout> | undefined;
  private detachHintVisible = false;

  private onSnapshotChange: (() => void) | undefined;
  private projectionListener: (() => void) | undefined;

  private streamingProgressTimer: ReturnType<typeof setInterval> | undefined;

  private readonly subagent = new ToolCallSubagentFacet(
    createToolCallSubagentHost(this),
  );
  private readonly resultFacet = new ToolCallResultFacet(
    createToolCallResultHost(this),
    APPROVED_PLAN_MARKER,
    AUTO_APPROVED_PLAN_MARKER,
  );

  constructor(
    toolCall: ToolCallBlockData,
    result: ToolResultBlockData | undefined,
    ui?: TUI,
    readonly workspaceDir?: string,
  ) {
    super();
    this.toolCall = toolCall;
    this.result = result;
    this.ui = ui;
    this.subagent.applyReplay(toolCall.subagent);

    this.addChild(new Spacer(1));
    this.headerText = new Text(this.buildHeader(), 0, 0);
    this.addChild(this.headerText);
    this.buildCallPreview();
    this.callPreviewEndIndex = this.children.length;
    this.buildProgressBlock();
    this.buildLiveOutputBlock();
    this.resultFacet.buildContent();
    this.buildSubagentBlock();
    this.syncStreamingProgressTimer();
    this.subagent.syncElapsedTimer();
    this.startDetachHintTimer();
  }

  get toolCallView(): Readonly<ToolCallBlockData> {
    return this.toolCall;
  }

  get resultView(): ToolResultBlockData | undefined {
    return this.result;
  }

  get expandedView(): boolean {
    return this.expanded;
  }

  get currentPlanView(): string | undefined {
    return this.currentPlan;
  }

  get planPathView(): string | undefined {
    return this.planPath;
  }

  get markdownThemeView() {
    return this.markdownTheme;
  }

  private renderCache:
    | {
        width: number;
        lines: string[];
        childRefs: Component[];
        childLines: string[][];
      }
    | undefined;

  override render(width: number): string[] {
    const cache = this.renderCache;
    const cacheValid =
      isRenderCacheEnabled() &&
      cache !== undefined &&
      cache.width === width &&
      cache.childRefs.length === this.children.length;

    const childRefs: Component[] = [];
    const childLines: string[][] = [];
    let allReused = cacheValid;

    let i = 0;
    for (const child of this.children) {
      const lines = child.render(width);
      childRefs.push(child);
      childLines.push(lines);
      if (
        cacheValid &&
        (cache.childRefs[i] !== child || cache.childLines[i] !== lines)
      ) {
        allReused = false;
      }
      i++;
    }

    if (allReused) {
      return cache!.lines;
    }

    const out: string[] = [];
    for (const lines of childLines) {
      for (const line of lines) out.push(line);
    }
    if (isRenderCacheEnabled()) {
      this.renderCache = { width, lines: out, childRefs, childLines };
    }
    return out;
  }

  override invalidate(): void {
    this.renderCache = undefined;
    this.headerText.setText(this.buildHeader());
    this.rebuildBody();
    super.invalidate();
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    this.rebuildBody();
  }

  setResult(result: ToolResultBlockData): void {
    this.result = result;
    this.progressLines = [];
    this.liveOutput = "";
    this.detachHintVisible = false;
    this.stopDetachHintTimer();
    this.subagent.finalizeElapsedIfNeeded();
    this.syncStreamingProgressTimer();
    this.subagent.syncElapsedTimer();
    this.headerText.setText(this.buildHeader());
    this.rebuildBody();
    this.notifySnapshotChange();
  }

  updateToolCall(toolCall: ToolCallBlockData): void {
    this.toolCall = toolCall;
    this.syncStreamingProgressTimer();
    this.headerText.setText(this.buildHeader());
    this.rebuildBody();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  appendProgress(text: string): void {
    if (this.result !== undefined) return;
    for (const line of text.split("\n")) {
      this.progressLines.push(line);
    }
    while (this.progressLines.length > ToolCallComponent.MAX_PROGRESS_LINES) {
      this.progressLines.shift();
    }
    this.rebuildBody();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  appendLiveOutput(text: string): void {
    if (this.result !== undefined || text.length === 0) return;
    this.liveOutput += text;
    if (this.liveOutput.length > MAX_LIVE_OUTPUT_CHARS) {
      this.liveOutput = `[...truncated]\n${this.liveOutput.slice(
        this.liveOutput.length - MAX_LIVE_OUTPUT_CHARS,
      )}`;
    }
    this.rebuildContent();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  dispose(): void {
    this.stopStreamingProgressTimer();
    this.subagent.stopElapsedTimer();
    this.stopDetachHintTimer();
  }

  setPlanInfo(info: { plan?: string; path?: string }): void {
    if (this.toolCall.name !== "ExitPlanMode") return;
    let changed = false;
    if (
      info.plan !== undefined &&
      info.plan.length > 0 &&
      this.currentPlan !== info.plan
    ) {
      this.currentPlan = info.plan;
      changed = true;
    }
    if (
      info.path !== undefined &&
      info.path.length > 0 &&
      this.planPath !== info.path
    ) {
      this.planPath = info.path;
      changed = true;
    }
    if (!changed) return;
    this.rebuildBody();
    this.ui?.requestRender();
  }

  setSnapshotListener(cb: (() => void) | undefined): void {
    this.onSnapshotChange = cb;
    if (cb !== undefined) cb();
  }

  getSubagentSnapshot(): ToolCallSubagentSnapshot {
    return this.subagent.getSnapshot();
  }

  getReadSnapshot(): ToolCallReadSnapshot {
    const args = this.toolCall.args;
    const filePathRaw = args["file_path"] ?? args["path"];
    const filePath =
      typeof filePathRaw === "string"
        ? makeWorkspaceRelativePath(filePathRaw, this.workspaceDir)
        : undefined;
    if (this.result === undefined) {
      return {
        toolCallId: this.toolCall.id,
        filePath,
        phase: "pending",
        lines: 0,
      };
    }
    if (this.result.is_error === true) {
      return {
        toolCallId: this.toolCall.id,
        filePath,
        phase: "failed",
        lines: 0,
      };
    }
    return {
      toolCallId: this.toolCall.id,
      filePath,
      phase: "done",
      lines: countNonEmptyLines(this.result.output),
    };
  }

  setProjectionListener(listener: (() => void) | undefined): void {
    this.projectionListener = listener;
  }

  captureSubagentCardState(): SubagentCardViewState {
    return this.subagent.captureCardState();
  }

  captureToolCallProjection(): ToolCallBlockData {
    const projection: ToolCallBlockData = {
      ...this.toolCall,
      result: this.result,
    };
    if (!this.isSingleSubagentView()) return projection;
    return {
      ...projection,
      subagentCard: this.captureSubagentCardState(),
    };
  }

  setSubagentMeta(agentId: string, agentName?: string): void {
    this.subagent.setMeta(agentId, agentName);
  }

  onSubagentSpawned(meta: {
    agentId: string;
    agentName?: string | undefined;
    runInBackground: boolean;
  }): void {
    this.subagent.onSpawned(meta);
  }

  onSubagentStarted(meta: {
    agentId: string;
    agentName?: string | undefined;
    runInBackground: boolean;
  }): void {
    this.subagent.onStarted(meta);
  }

  onSubagentCompleted(payload: {
    contextTokens?: number | undefined;
    usage?: TokenUsage | undefined;
    resultSummary: string;
  }): void {
    this.subagent.onCompleted(payload);
  }

  updateSubagentMetrics(payload: {
    contextTokens?: number | undefined;
    usage?: TokenUsage | undefined;
    modelDisplay?: string | undefined;
  }): void {
    this.subagent.updateMetrics(payload);
    this.invalidate();
  }

  onSubagentFailed(payload: { error: string }): void {
    this.subagent.onFailed(payload);
  }

  setBackgroundTaskTerminalStatus(
    status: "completed" | "failed" | "timed_out" | "killed" | "lost",
    options: { errorText?: string | undefined } = {},
  ): void {
    this.subagent.setBackgroundTaskTerminalStatus(status, options);
  }

  markBackgrounded(): void {
    this.subagent.markBackgrounded();
  }

  getSubagentAgentId(): string | undefined {
    return this.subagent.getAgentId();
  }

  getAgentToolDescription(): string | undefined {
    return this.subagent.getAgentToolDescription();
  }

  appendSubagentText(text: string, kind: "thinking" | "text" = "text"): void {
    this.subagent.appendText(text, kind);
  }

  appendSubToolCall(call: {
    id: string;
    name: string;
    args: Record<string, unknown>;
  }): void {
    this.subagent.appendSubToolCall(call);
  }

  appendSubToolCallDelta(delta: {
    id: string;
    name?: string | undefined;
    argumentsPart: string | null;
  }): void {
    this.subagent.appendSubToolCallDelta(delta);
  }

  appendSubToolLiveOutput(id: string, text: string): void {
    this.subagent.appendSubToolLiveOutput(id, text);
  }

  finishSubToolCall(result: {
    tool_call_id: string;
    output: string;
    is_error?: boolean | undefined;
  }): void {
    this.subagent.finishSubToolCall(result);
  }

  isSingleSubagentView(): boolean {
    return this.subagent.isSingleSubagentView();
  }

  setHeaderText(text: string): void {
    this.headerText.setText(text);
  }

  addBodyChild(child: Component): void {
    this.addChild(child);
  }

  addPreviewLines(lines: readonly string[]): void {
    for (const line of lines) {
      this.addChild(new Text(line, 0, 0));
    }
  }

  rebuildContent(): void {
    while (this.children.length > this.callPreviewEndIndex) {
      this.children.pop();
    }
    this.buildProgressBlock();
    this.buildDetachHintBlock();
    this.buildLiveOutputBlock();
    this.resultFacet.buildContent();
    this.buildSubagentBlock();
  }

  private buildSubagentBlock(): void {
    if (!this.subagent.hasVisibleBlock()) return;
    if (this.isSingleSubagentView()) {
      this.addBodyChild(
        new SubagentProjectedBodyComponent(
          () => this.captureSubagentCardState(),
          () => this.result,
          this.workspaceDir,
        ),
      );
      return;
    }
    const view = this.subagent.getGroupedBlockView();
    if (view === undefined) return;
    renderGroupedSubagentBlock(view, this.workspaceDir, (child) => {
      this.addChild(child);
    });
  }

  notifySnapshotChange(): void {
    this.onSnapshotChange?.();
    this.projectionListener?.();
  }

  requestRender(): void {
    this.ui?.requestRender();
  }

  private buildHeader(): string {
    if (this.isSingleSubagentView()) {
      return this.subagent.buildHeader();
    }
    return projectToolCallHeader({
      toolCall: this.toolCall,
      result: this.result,
      workspaceDir: this.workspaceDir,
    });
  }

  private rebuildBody(): void {
    while (this.children.length > 2) {
      this.children.pop();
    }
    this.buildCallPreview();
    this.callPreviewEndIndex = this.children.length;
    this.buildProgressBlock();
    this.buildDetachHintBlock();
    this.buildLiveOutputBlock();
    this.resultFacet.buildContent();
    this.buildSubagentBlock();
  }

  private buildCallPreview(): void {
    this.resultFacet.buildCallPreview();
  }

  private isStreamingEditPreview(): boolean {
    return (
      this.toolCall.name === "Edit" &&
      this.result === undefined &&
      this.toolCall.streamingArguments !== undefined
    );
  }

  private syncStreamingProgressTimer(): void {
    if (!this.isStreamingEditPreview()) {
      this.stopStreamingProgressTimer();
      return;
    }
    if (this.ui === undefined || this.streamingProgressTimer !== undefined) {
      return;
    }
    this.streamingProgressTimer = setInterval(() => {
      if (!this.isStreamingEditPreview()) {
        this.stopStreamingProgressTimer();
        return;
      }
      this.rebuildBody();
      this.ui?.requestRender();
    }, STREAMING_PROGRESS_INTERVAL_MS);
  }

  private stopStreamingProgressTimer(): void {
    if (this.streamingProgressTimer === undefined) return;
    clearInterval(this.streamingProgressTimer);
    this.streamingProgressTimer = undefined;
  }

  private isDetachHintEligible(): boolean {
    return this.toolCall.name === "Bash" || this.toolCall.name === "Agent";
  }

  private startDetachHintTimer(): void {
    if (!this.isDetachHintEligible()) return;
    if (this.result !== undefined) return;
    if (this.ui === undefined) return;
    if (this.toolCall.name === "Agent") {
      if (this.detachHintVisible) return;
      this.detachHintVisible = true;
      this.rebuildBody();
      this.ui?.requestRender();
      return;
    }
    if (this.detachHintTimer !== undefined) return;
    this.detachHintTimer = setTimeout(() => {
      this.detachHintTimer = undefined;
      if (this.result !== undefined) return;
      this.detachHintVisible = true;
      this.rebuildBody();
      this.ui?.requestRender();
    }, DETACH_HINT_DELAY_MS);
  }

  private stopDetachHintTimer(): void {
    if (this.detachHintTimer === undefined) return;
    clearTimeout(this.detachHintTimer);
    this.detachHintTimer = undefined;
  }

  private buildDetachHintBlock(): void {
    if (!this.detachHintVisible) return;
    if (this.result !== undefined) return;
    this.addChild(new Text(currentTheme.dim(DETACH_HINT_TEXT), 2, 0));
  }

  private buildProgressBlock(): void {
    if (this.progressLines.length === 0) return;
    if (this.result !== undefined) return;
    for (const raw of this.progressLines) {
      if (raw.length === 0) {
        this.addChild(new Text("", 2, 0));
        continue;
      }
      PROGRESS_URL_RE.lastIndex = 0;
      const styled = PROGRESS_URL_RE.test(raw)
        ? raw.replace(PROGRESS_URL_RE, (url) => {
            const visible = currentTheme.underlineFg("warning", url);
            return `\u001B]8;;${url}\u001B\\${visible}\u001B]8;;\u001B\\`;
          })
        : currentTheme.dim(raw);
      PROGRESS_URL_RE.lastIndex = 0;
      this.addChild(new Text(styled, 2, 0));
    }
  }

  private buildLiveOutputBlock(): void {
    if (this.result !== undefined) return;
    if (this.liveOutput.length === 0) return;
    this.addChild(
      new ShellExecutionComponent({
        result: {
          tool_call_id: this.toolCall.id,
          output: this.liveOutput,
          is_error: false,
        },
        expanded: this.expanded,
        resultPreviewLines: RESULT_PREVIEW_LINES,
        tailOutput: true,
        expandHint: false,
      }),
    );
  }
}

function createToolCallSubagentHost(
  component: ToolCallComponent,
): ToolCallSubagentHost {
  return {
    get toolCall() {
      return component.toolCallView;
    },
    get result() {
      return component.resultView;
    },
    get workspaceDir() {
      return component.workspaceDir;
    },
    setHeaderText: (text) => component.setHeaderText(text),
    addBodyChild: (child) => component.addBodyChild(child),
    rebuildContent: () => component.rebuildContent(),
    notifySnapshotChange: () => component.notifySnapshotChange(),
    requestRender: () => component.requestRender(),
  };
}

function createToolCallResultHost(
  component: ToolCallComponent,
): ToolCallResultHost {
  return {
    get toolCall() {
      return component.toolCallView;
    },
    get result() {
      return component.resultView;
    },
    get expanded() {
      return component.expandedView;
    },
    get markdownTheme() {
      return component.markdownThemeView;
    },
    get currentPlan() {
      return component.currentPlanView;
    },
    get planPath() {
      return component.planPathView;
    },
    isSingleSubagentView: () => component.isSingleSubagentView(),
    addBodyChild: (child) => component.addBodyChild(child),
    addPreviewLines: (lines) => component.addPreviewLines(lines),
  };
}

class SubagentProjectedBodyComponent implements Component {
  constructor(
    private readonly getCard: () => SubagentCardViewState,
    private readonly getResult: () => ToolResultBlockData | undefined,
    private readonly workspaceDir?: string,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    return projectSingleSubagentBodyLines({
      card: this.getCard(),
      result: this.getResult(),
      workspaceDir: this.workspaceDir,
      width,
    });
  }
}

function renderGroupedSubagentBlock(
  view: ToolCallSubagentGroupedView,
  workspaceDir: string | undefined,
  addChild: (child: Component) => void,
): void {
  const headerLabel =
    view.agentName !== undefined
      ? `subagent ${view.agentName} (${view.agentId})`
      : `subagent (${view.agentId})`;
  addChild(
    new Text(
      `  ${currentTheme.dim(`↳ ${headerLabel}`)}${view.phaseChip}`,
      0,
      0,
    ),
  );

  if (view.hiddenSubCallCount > 0) {
    const suffix = view.hiddenSubCallCount > 1 ? "s" : "";
    addChild(
      new Text(
        currentTheme.italic(
          currentTheme.dim(
            `    ${String(view.hiddenSubCallCount)} more tool call${suffix} ...`,
          ),
        ),
        0,
        0,
      ),
    );
  }

  for (const sub of view.finishedSubCalls) {
    const mark = sub.isError
      ? currentTheme.fg("error", "✗")
      : currentTheme.fg("success", "•");
    const keyArg = extractKeyArgument(sub.name, sub.args, workspaceDir);
    const nameCol = currentTheme.fg("primary", sub.name);
    const argCol = keyArg ? currentTheme.dim(` (${keyArg})`) : "";
    addChild(new Text(`    ${mark} Used ${nameCol}${argCol}`, 0, 0));
  }

  for (const call of view.ongoingSubCalls) {
    const keyArg = extractKeyArgument(call.name, call.args, workspaceDir);
    const nameCol = currentTheme.fg("primary", call.name);
    const argCol = keyArg ? currentTheme.dim(` (${keyArg})`) : "";
    addChild(
      new Text(`    ${currentTheme.dim("…")} Using ${nameCol}${argCol}`, 0, 0),
    );
  }

  if (view.subagentText.length > 0) {
    const tailLines = view.subagentText.split("\n").slice(-3);
    for (const line of tailLines) {
      addChild(new Text(`    ${currentTheme.dim(line)}`, 0, 0));
    }
  }

  if (
    view.subagentPhase === "done" &&
    view.subagentResultSummary !== undefined
  ) {
    const summaryLines = view.subagentResultSummary.split("\n").slice(0, 2);
    for (const line of summaryLines) {
      addChild(new Text(`    ${currentTheme.dim("└")} ${line}`, 0, 0));
    }
  }

  if (view.subagentPhase === "failed" && view.subagentError !== undefined) {
    const errLines = view.subagentError.split("\n");
    for (const line of errLines) {
      addChild(new Text(`    ${currentTheme.fg("error", "└")} ${line}`, 0, 0));
    }
  }
}

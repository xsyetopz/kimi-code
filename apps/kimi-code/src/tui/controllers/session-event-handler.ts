import type { Component, Focusable } from "@moonshot-ai/kimi-tui";
import type {
  AgentStatusUpdatedEvent,
  BackgroundTaskInfo,
  BackgroundTaskStartedEvent,
  BackgroundTaskTerminatedEvent,
  ErrorEvent,
  Event,
  PluginCommandActivatedEvent,
  Session,
  SessionMetaUpdatedEvent,
  SkillActivatedEvent,
  WarningEvent,
} from "@moonshot-ai/kimi-code-sdk";

import { MoonLoader } from "../components/chrome/moon-loader";
import { StatusMessageComponent } from "../components/messages/status-message";
import {
  SwarmModeMarkerComponent,
  type SwarmModeMarkerState,
} from "../components/messages/swarm-markers";
import {
  OAUTH_LOGIN_REQUIRED_CODE,
  OAUTH_LOGIN_REQUIRED_STARTUP_NOTICE,
} from "../constant/kimi-tui";
import { formatErrorPayload, stringValue } from "../utils/event-payload";
import { formatBackgroundTaskTranscript } from "../utils/background-task-status";
import { McpOAuthAuthorizationUrlOpener } from "../utils/mcp-oauth";
import {
  formatMcpStartupStatusSummary,
  mcpServerStatusKey,
  type McpServerStatusSnapshot,
  selectMcpStartupStatusRows,
} from "../utils/mcp-server-status";
import { openUrl } from "#/utils/open-url";
import { currentTheme } from "#/tui/theme";
import type { ColorToken } from "#/tui/theme";
import { errorReportHintLine } from "../constant/feedback";
import { nextTranscriptId } from "../utils/transcript-id";
import type { BtwPanelController } from "./btw-panel";
import { PluginUpdateNotifier } from "./plugin-update-notifier";
import type { StreamingUIController } from "./streaming-ui";
import type { TasksBrowserController } from "./tasks-browser";
import { SubAgentEventHandler } from "./subagent-event-handler";
import type {
  AppState,
  LivePaneState,
  QueuedMessage,
  ToolCallBlockData,
  TranscriptEntry,
} from "../types";
import type { TUIState } from "../tui-state";
import { SessionEventGoalHandler } from "./session-event-goal";
import { SessionEventTurnHandler } from "./session-event-turn";

export interface SessionEventHost {
  state: TUIState;
  session: Session | undefined;
  aborted: boolean;
  sessionEventUnsubscribe: (() => void) | undefined;
  readonly streamingUI: StreamingUIController;

  requireSession(): Session;
  setAppState(patch: Partial<AppState>): void;
  patchLivePane(patch: Partial<LivePaneState>): void;
  resetLivePane(): void;
  showError(msg: string): void;
  showStatus(msg: string, color?: ColorToken): void;
  showNotice(title: string, detail?: string): void;
  updateActivityPane(): void;
  track(event: string, props?: Record<string, unknown>): void;
  mountEditorReplacement(panel: Component & Focusable): void;
  restoreEditor(): void;
  restoreInputText(text: string): void;
  appendTranscriptEntry(entry: TranscriptEntry): void;
  syncToolCallTranscriptEntry(
    toolCallId: string,
    data: ToolCallBlockData,
  ): void;
  removeToolCallTranscriptEntry(toolCallId: string): void;
  handleShellOutput(event: {
    commandId: string;
    update: { kind: string; text?: string };
  }): void;
  handleShellStarted(event: { commandId: string; taskId: string }): void;
  sendNormalUserInput(text: string): void;
  updateTerminalTitle(): void;
  sendQueuedMessage(session: Session, item: QueuedMessage): void;
  shiftQueuedMessage(): QueuedMessage | undefined;
  readonly btwPanelController: BtwPanelController;
  readonly tasksBrowserController: TasksBrowserController;
}

export class SessionEventHandler {
  readonly subAgentEventHandler: SubAgentEventHandler;
  readonly turnHandler: SessionEventTurnHandler;
  readonly goalHandler: SessionEventGoalHandler;
  private readonly pluginUpdateNotifier: PluginUpdateNotifier;

  constructor(
    private readonly host: SessionEventHost,
    pluginUpdateNotifier?: PluginUpdateNotifier,
  ) {
    this.subAgentEventHandler = new SubAgentEventHandler(host, {
      backgroundTasks: this.backgroundTasks,
      backgroundTaskTranscriptedTerminal:
        this.backgroundTaskTranscriptedTerminal,
      syncBackgroundAgentBadge: () => {
        this.syncBackgroundTaskBadge();
      },
    });
    this.pluginUpdateNotifier =
      pluginUpdateNotifier ??
      new PluginUpdateNotifier({
        getSession: () => this.host.session,
        workDir: host.state.appState.workDir,
        notify: (message) => {
          this.host.showStatus(message, "warning");
        },
      });
    this.goalHandler = new SessionEventGoalHandler(host, {
      getCurrentTurnHasAssistantText: () =>
        this.turnHandler.currentTurnHasAssistantText,
    });
    this.turnHandler = new SessionEventTurnHandler(host, {
      subAgentEventHandler: this.subAgentEventHandler,
      pluginUpdateNotifier: this.pluginUpdateNotifier,
      goalHandler: this.goalHandler,
    });
  }

  backgroundTasks: Map<string, BackgroundTaskInfo> = new Map();
  backgroundTaskTranscriptedTerminal: Set<string> = new Set();

  renderedSkillActivationIds: Set<string> = new Set();
  renderedPluginCommandActivationIds: Set<string> = new Set();
  renderedMcpServerStatusKeys: Map<string, string> = new Map();
  mcpServerStatusSpinners: Map<string, MoonLoader> = new Map();
  mcpServers: Map<string, McpServerStatusSnapshot> = new Map();

  resetRuntimeState(): void {
    this.backgroundTasks.clear();
    this.backgroundTaskTranscriptedTerminal.clear();
    this.subAgentEventHandler.resetRuntimeState();
    this.turnHandler.resetRuntimeState();
    this.goalHandler.resetRuntimeState();
    this.renderedSkillActivationIds.clear();
    this.renderedPluginCommandActivationIds.clear();
    this.renderedMcpServerStatusKeys.clear();
    this.mcpServers.clear();
    this.stopAllMcpServerStatusSpinners();
  }

  clearAgentSwarmProgress(): void {
    this.subAgentEventHandler.clearAgentSwarmProgress();
  }

  hasActiveAgentSwarmToolCall(): boolean {
    return this.subAgentEventHandler.hasActiveAgentSwarmToolCall();
  }

  syncAgentSwarmActivitySpinner(spinner: MoonLoader | undefined): void {
    this.subAgentEventHandler.syncAgentSwarmActivitySpinner(spinner);
  }

  startSubscription(): void {
    const { host } = this;
    const session = host.requireSession();
    const sendQueued = (item: QueuedMessage): void => {
      host.sendQueuedMessage(session, item);
    };
    host.sessionEventUnsubscribe?.();
    const mcpOAuthOpener = new McpOAuthAuthorizationUrlOpener(openUrl);
    const { sessionId } = host.state.appState;
    host.sessionEventUnsubscribe = session.onEvent((event) => {
      if (host.aborted) return;
      if (event.sessionId !== sessionId) return;
      if (event.type === "tool.progress") {
        mcpOAuthOpener.handleToolProgress(event);
      }
      this.handleEvent(event, sendQueued);
    });
    void this.syncMcpServerStatusSnapshot(session);
  }

  async syncMcpServerStatusSnapshot(session: Session): Promise<void> {
    const { host } = this;
    let servers: readonly McpServerStatusSnapshot[];
    try {
      servers = await session.listMcpServers();
    } catch (error) {
      if (host.session !== session || host.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      host.showError(`Failed to sync MCP server status: ${message}`);
      return;
    }
    if (
      host.session !== session ||
      host.state.appState.sessionId !== session.id
    )
      return;

    const visible = selectMcpStartupStatusRows(servers);
    const visibleNames = new Set(visible.map((server) => server.name));
    for (const server of visible) {
      if (this.renderedMcpServerStatusKeys.has(server.name)) continue;
      this.renderMcpServerStatus(server);
    }

    this.mcpServers.clear();
    for (const server of servers) {
      this.mcpServers.set(server.name, server);
    }
    const hidden: McpServerStatusSnapshot[] = [];
    for (const server of servers) {
      if (visibleNames.has(server.name)) continue;
      if (this.renderedMcpServerStatusKeys.has(server.name)) continue;
      this.renderedMcpServerStatusKeys.set(
        server.name,
        mcpServerStatusKey(server),
      );
      hidden.push(server);
    }
    const summary = formatMcpStartupStatusSummary(servers);
    host.setAppState({ mcpServersSummary: summary || null });
  }

  handleEvent(event: Event, sendQueued: (item: QueuedMessage) => void): void {
    if (this.subAgentEventHandler.routeChildAgentEvent(event)) return;

    if ("turnId" in event && event.turnId !== undefined) {
      this.host.streamingUI.setTurnId(String(event.turnId));
    }

    switch (event.type) {
      case "turn.started":
        this.turnHandler.handleTurnBegin(event);
        break;
      case "turn.ended":
        this.turnHandler.handleTurnEnd(event, sendQueued);
        break;
      case "turn.step.started":
        this.turnHandler.handleStepBegin(event);
        break;
      case "turn.step.interrupted":
        this.turnHandler.handleStepInterrupted(event);
        break;
      case "turn.step.completed":
        this.turnHandler.handleStepCompleted(event);
        break;
      case "turn.step.retrying":
        break;
      case "tool.progress":
        this.turnHandler.handleToolProgress(event);
        break;
      case "shell.output":
        this.host.handleShellOutput(event);
        break;
      case "shell.started":
        this.host.handleShellStarted(event);
        break;
      case "assistant.delta":
        this.turnHandler.handleAssistantDelta(event);
        break;
      case "hook.result":
        this.turnHandler.handleHookResult(event);
        break;
      case "thinking.delta":
        this.turnHandler.handleThinkingDelta(event);
        break;
      case "tool.call.started":
        this.turnHandler.handleToolCall(event);
        break;
      case "tool.call.delta":
        this.turnHandler.handleToolCallDelta(event);
        break;
      case "tool.result":
        this.turnHandler.handleToolResult(event);
        break;
      case "agent.status.updated":
        this.handleStatusUpdate(event);
        break;
      case "session.meta.updated":
        this.handleSessionMetaChanged(event);
        break;
      case "goal.updated":
        this.goalHandler.handleGoalUpdated(event);
        break;
      case "skill.activated":
        this.handleSkillActivated(event);
        break;
      case "plugin_command.activated":
        this.handlePluginCommandActivated(event);
        break;
      case "error":
        this.handleSessionError(event);
        break;
      case "warning":
        this.handleSessionWarning(event);
        break;
      case "compaction.started":
        this.turnHandler.handleCompactionBegin(event);
        break;
      case "compaction.completed":
        this.turnHandler.handleCompactionEnd(event, sendQueued);
        break;
      case "compaction.blocked":
        break;
      case "compaction.cancelled":
        this.turnHandler.handleCompactionCancel(event, sendQueued);
        break;
      case "subagent.spawned":
      case "subagent.started":
      case "subagent.suspended":
      case "subagent.completed":
      case "subagent.failed":
      case "subagent.pool.updated":
        this.subAgentEventHandler.handleLifecycleEvent(event);
        break;
      case "background.task.started":
      case "background.task.terminated":
        this.handleBackgroundTaskEvent(event);
        break;
      case "cron.fired":
        this.turnHandler.handleCronFired(event);
        break;
      case "mcp.server.status":
        this.renderMcpServerStatus(event.server);
        break;
      case "tool.list.updated":
        break;
      default:
        break;
    }
  }

  stopAllMcpServerStatusSpinners(): void {
    for (const spinner of this.mcpServerStatusSpinners.values()) {
      spinner.stop();
    }
    this.mcpServerStatusSpinners.clear();
  }

  requestQueuedGoalPromotion(): void {
    this.goalHandler.requestQueuedGoalPromotion();
  }

  retryQueuedGoalPromotion(): void {
    this.goalHandler.retryQueuedGoalPromotion();
  }

  private handleStatusUpdate(event: AgentStatusUpdatedEvent): void {
    const shouldRenderSwarmEnded =
      event.swarmMode === false &&
      this.host.state.appState.swarmMode &&
      this.host.state.swarmModeEntry === "task";
    const patch: Partial<AppState> = {};
    if (event.contextUsage !== undefined)
      patch.contextUsage = event.contextUsage;
    if (event.contextTokens !== undefined)
      patch.contextTokens = event.contextTokens;
    if (event.maxContextTokens !== undefined)
      patch.maxContextTokens = event.maxContextTokens;
    if (event.planMode !== undefined) patch.planMode = event.planMode;
    if (event.swarmMode !== undefined) patch.swarmMode = event.swarmMode;
    if (event.permission !== undefined) {
      patch.permissionMode = event.permission;
    }
    if (event.model !== undefined) patch.model = event.model;
    if (event.thinkingEffort !== undefined)
      patch.thinkingEffort = event.thinkingEffort;
    if (Object.keys(patch).length > 0) this.host.setAppState(patch);
    if (event.swarmMode === false) {
      this.host.state.swarmModeEntry = undefined;
      if (shouldRenderSwarmEnded) {
        this.renderSwarmModeMarker("ended");
      }
    }
  }

  private renderSwarmModeMarker(state: SwarmModeMarkerState): void {
    this.host.state.transcriptContainer.addChild(
      new SwarmModeMarkerComponent(state),
    );
    this.host.state.ui.requestRender();
  }

  private handleSessionMetaChanged(event: SessionMetaUpdatedEvent): void {
    const title = event.title ?? stringValue(event.patch?.["title"]);
    if (title !== undefined) {
      this.host.setAppState({ sessionTitle: title });
      this.host.updateTerminalTitle();
    }
  }

  private handleSessionError(event: ErrorEvent): void {
    this.host.streamingUI.flushNow();
    this.host.streamingUI.resetToolUi();
    this.host.streamingUI.finalizeLiveTextBuffers("idle");
    if (event.code === OAUTH_LOGIN_REQUIRED_CODE) {
      this.host.showError(OAUTH_LOGIN_REQUIRED_STARTUP_NOTICE);
      return;
    }
    this.host.showError(formatErrorPayload(event));
    const sessionId = this.host.state.appState.sessionId;
    if (sessionId.length > 0) {
      this.host.showStatus(errorReportHintLine());
    }
  }

  private handleSessionWarning(event: WarningEvent): void {
    this.host.showStatus(`Warning: ${event.message}`, "warning");
  }

  private renderMcpServerStatus(server: McpServerStatusSnapshot): void {
    const key = mcpServerStatusKey(server);
    if (this.renderedMcpServerStatusKeys.get(server.name) === key) return;
    this.renderedMcpServerStatusKeys.set(server.name, key);
    this.mcpServers.set(server.name, server);
    const summary = formatMcpStartupStatusSummary([
      ...this.mcpServers.values(),
    ]);
    this.host.setAppState({ mcpServersSummary: summary || null });

    switch (server.status) {
      case "connected": {
        const toolStr = `${server.toolCount} tool${server.toolCount === 1 ? "" : "s"}`;
        const message = `MCP server "${server.name}" connected · ${toolStr} (${server.transport})`;
        this.finalizeMcpServerStatusRow(server.name, message, "success");
        return;
      }
      case "failed": {
        const message = `MCP server "${server.name}" failed${server.error !== undefined ? `: ${server.error}` : ""}`;
        this.finalizeMcpServerStatusRow(server.name, message, "error");
        return;
      }
      case "needs-auth": {
        const message = `MCP server "${server.name}" needs OAuth — run /mcp-config login ${server.name}`;
        this.finalizeMcpServerStatusRow(server.name, message, "warning");
        return;
      }
      case "disabled":
        this.finalizeMcpServerStatusRow(
          server.name,
          `MCP server "${server.name}" disabled`,
          "textMuted",
        );
        return;
      case "pending":
        this.showMcpServerStatusSpinner(server.name);
        return;
    }
  }

  private showMcpServerStatusSpinner(name: string): void {
    const { state } = this.host;
    const label = `MCP server "${name}" connecting…`;
    const existing = this.mcpServerStatusSpinners.get(name);
    if (existing !== undefined) {
      existing.setLabel(label);
      return;
    }
    const tint = (s: string): string => currentTheme.fg("textMuted", s);
    const spinner = new MoonLoader(state.ui, "braille", tint, label);
    state.transcriptContainer.addChild(spinner);
    this.mcpServerStatusSpinners.set(name, spinner);
    state.ui.requestRender();
  }

  private finalizeMcpServerStatusRow(
    name: string,
    message: string,
    color: ColorToken,
  ): void {
    const { state } = this.host;
    const spinner = this.mcpServerStatusSpinners.get(name);
    if (spinner === undefined) {
      this.host.showStatus(message, color);
      return;
    }
    spinner.stop();
    const status = new StatusMessageComponent(message, color);
    const children = state.transcriptContainer.children;
    const idx = children.indexOf(spinner);
    if (idx >= 0) {
      children[idx] = status;
    } else {
      state.transcriptContainer.addChild(status);
    }
    this.mcpServerStatusSpinners.delete(name);
    state.ui.requestRender();
  }

  private handleSkillActivated(event: SkillActivatedEvent): void {
    if (this.renderedSkillActivationIds.has(event.activationId)) return;
    this.renderedSkillActivationIds.add(event.activationId);
    this.host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: "skill_activation",
      turnId: undefined,
      renderMode: "plain",
      content: `Activated skill: ${event.skillName}`,
      skillActivationId: event.activationId,
      skillName: event.skillName,
      skillArgs: event.skillArgs,
      skillTrigger: event.trigger,
    });
  }

  private handlePluginCommandActivated(
    event: PluginCommandActivatedEvent,
  ): void {
    if (this.renderedPluginCommandActivationIds.has(event.activationId)) return;
    this.renderedPluginCommandActivationIds.add(event.activationId);
    this.host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: "plugin_command",
      turnId: undefined,
      renderMode: "plain",
      content: `/${event.pluginId}:${event.commandName}`,
      pluginCommandData: {
        activationId: event.activationId,
        pluginId: event.pluginId,
        commandName: event.commandName,
        args: event.commandArgs,
        trigger: event.trigger,
      },
    });
  }

  private handleBackgroundTaskEvent(
    event: BackgroundTaskStartedEvent | BackgroundTaskTerminatedEvent,
  ): void {
    const { state } = this.host;
    const { info } = event;
    const previous = this.backgroundTasks.get(info.taskId);
    this.backgroundTasks.set(info.taskId, info);

    const viewer = state.tasksBrowser?.viewer;
    if (viewer !== undefined && viewer.taskId === info.taskId) {
      void this.host.tasksBrowserController.refreshOutputViewer({
        silent: true,
      });
    }

    const isTerminal =
      info.status === "completed" ||
      info.status === "failed" ||
      info.status === "timed_out" ||
      info.status === "killed" ||
      info.status === "lost";

    if (event.type === "background.task.started") {
      if (info.kind === "agent") {
        this.host.streamingUI.markSubagentBackgrounded(info.agentId);
        this.syncBackgroundTaskBadge();
        this.host.tasksBrowserController.repaint();
        return;
      }
      this.appendBackgroundTaskEntry(info);
      this.syncBackgroundTaskBadge();
      this.host.tasksBrowserController.repaint();
      return;
    }

    if (event.type === "background.task.terminated" && isTerminal) {
      if (info.kind === "agent") {
        this.host.streamingUI.applyBackgroundTaskTerminalStatus({
          agentId: info.agentId,
          description: info.description,
          status: info.status,
        });
      }
      if (!this.backgroundTaskTranscriptedTerminal.has(info.taskId)) {
        if (info.kind === "process" || info.kind === "question") {
          this.appendBackgroundTaskEntry(info);
        }
        this.backgroundTaskTranscriptedTerminal.add(info.taskId);
      }
      this.syncBackgroundTaskBadge();
      this.host.tasksBrowserController.repaint();
      return;
    }

    if (previous?.status !== info.status) {
      this.syncBackgroundTaskBadge();
    }
    this.host.tasksBrowserController.repaint();
  }

  private appendBackgroundTaskEntry(info: BackgroundTaskInfo): void {
    const status = formatBackgroundTaskTranscript(info);
    const entry: TranscriptEntry = {
      id: nextTranscriptId(),
      kind: "status",
      turnId: this.host.streamingUI.getTurnContext().turnId,
      renderMode: "plain",
      content: status.headline,
      detail: status.detail,
      backgroundAgentStatus: status,
    };
    this.host.appendTranscriptEntry(entry);
  }

  private syncBackgroundTaskBadge(): void {
    const { state } = this.host;
    let bashTasks = 0;
    let agentTasks = 0;
    for (const info of this.backgroundTasks.values()) {
      if (
        info.status === "completed" ||
        info.status === "failed" ||
        info.status === "timed_out" ||
        info.status === "killed" ||
        info.status === "lost"
      ) {
        continue;
      }
      if (info.kind === "agent") {
        agentTasks += 1;
      } else {
        bashTasks += 1;
      }
    }
    state.footer.setBackgroundCounts({ bashTasks, agentTasks });
    state.ui.requestRender();
  }
}

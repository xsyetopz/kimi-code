import type {
  BackgroundTaskInfo,
  KimiHarness,
  Session,
} from "@moonshot-ai/kimi-code-sdk";
import { Spacer } from "@moonshot-ai/kimi-tui";

import {
  ActivityPaneComponent,
  type ActivityPaneMode,
} from "#/tui/components/panes/activity-pane";
import { QueuePaneComponent } from "#/tui/components/panes/queue-pane";
import {
  MoonLoader,
  type SpinnerStyle,
} from "#/tui/components/chrome/moon-loader";
import { ShellRunComponent } from "#/tui/components/messages/shell-run";
import { NO_ACTIVE_SESSION_MESSAGE } from "#/tui/constant/kimi-tui";
import { TRANSCRIPT_EXPAND_TURNS } from "#/tui/utils/transcript-window";
import {
  currentTheme,
  getBuiltInPalette,
  getColorPalette,
  isBuiltInTheme,
  type ResolvedTheme,
  type ThemeName,
} from "#/tui/theme";
import { resolveTerminalActivityMode } from "#/tui/renderer/terminal-view-state";
import { formatErrorMessage } from "#/tui/utils/event-payload";
import { pickForegroundTasks } from "#/tui/utils/foreground-task";
import { installTerminalThemeTracking } from "#/tui/utils/terminal-theme";
import { isExpandable } from "#/tui/utils/component-capabilities";
import type { AppState } from "../types";
import type { TUIState } from "../tui-state";
import type { TranscriptEntry } from "../types";
import type { SessionEventHandler } from "./session-event-handler";
import type { TranscriptCoordinator } from "./transcript-coordinator";

/** How long the one-shot "moved to background" footer hint stays visible. */
const DETACH_HINT_DISPLAY_MS = 4_000;

type EffectiveActivityPaneMode = ActivityPaneMode | "idle" | "session";

export interface ShellOutputStreamEntry {
  readonly entry: TranscriptEntry;
  readonly component: ShellRunComponent;
  readonly taskId?: string;
}

export interface PresentationStateHost {
  readonly state: TUIState;
  readonly session: Session | undefined;
  readonly harness: KimiHarness;
  readonly deferUserMessages: boolean;
  readonly sessionEventHandler: SessionEventHandler;
  readonly transcriptCoordinator: TranscriptCoordinator;
  readonly shellOutputStreams: Map<string, ShellOutputStreamEntry>;

  updateInkRenderer(): void;
  showError(msg: string): void;
  setAppState(patch: Partial<AppState>): void;
}

export class PresentationStateController {
  private lastActivityMode: string | undefined;
  private detachHintClearTimer: ReturnType<typeof setTimeout> | undefined;
  private terminalThemeTrackingDispose: (() => void) | undefined;

  constructor(private readonly host: PresentationStateHost) {}

  /** Loading tip text for the terminal view snapshot (Ink / kimi-tui). */
  getActivityTip(): string | undefined {
    return undefined;
  }

  /** Stop spinners, theme tracking, and pending footer hints during shutdown. */
  dispose(): void {
    this.stopActivitySpinner();
    this.stopTerminalThemeTracking();
    if (this.detachHintClearTimer !== undefined) {
      clearTimeout(this.detachHintClearTimer);
      this.detachHintClearTimer = undefined;
    }
  }

  updateActivityPane(): void {
    const effectiveMode = this.resolveActivityPaneMode();
    this.syncTerminalProgress(this.shouldShowTerminalProgress(effectiveMode));
    const placeSpinnerInAgentSwarm =
      this.shouldPlaceActivitySpinnerInAgentSwarm(effectiveMode);
    const activityModeKey = `${effectiveMode}:${placeSpinnerInAgentSwarm ? "swarm" : "pane"}`;

    if (
      activityModeKey === this.lastActivityMode &&
      (effectiveMode === "waiting" ||
        effectiveMode === "thinking" ||
        effectiveMode === "tool")
    ) {
      if (placeSpinnerInAgentSwarm) {
        this.syncAgentSwarmActivitySpinner(
          this.host.state.activitySpinner?.instance,
        );
      }
      this.host.updateInkRenderer();
      return;
    }

    this.lastActivityMode = activityModeKey;
    this.host.state.activityContainer.clear();

    switch (effectiveMode) {
      case "hidden":
        this.stopActivitySpinner();
        this.syncAgentSwarmActivitySpinner(undefined);
        this.host.state.ui.requestRender();
        this.host.updateInkRenderer();
        return;
      case "waiting": {
        const spinner = this.ensureActivitySpinner("moon");
        this.syncAgentSwarmActivitySpinner(
          placeSpinnerInAgentSwarm ? spinner : undefined,
        );
        if (placeSpinnerInAgentSwarm) break;
        this.host.state.activityContainer.addChild(
          new ActivityPaneComponent({
            mode: "waiting",
            spinner,
            tip: undefined,
          }),
        );
        break;
      }
      case "thinking": {
        this.stopActivitySpinner();
        this.syncAgentSwarmActivitySpinner(undefined);
        break;
      }
      case "composing": {
        const spinner = this.ensureActivitySpinner(
          "braille",
          "working...",
          (s) => currentTheme.fg("primary", s),
        );
        this.syncAgentSwarmActivitySpinner(undefined);
        this.host.state.activityContainer.addChild(
          new ActivityPaneComponent({
            mode: "composing",
            spinner,
            tip: undefined,
          }),
        );
        break;
      }
      case "tool": {
        const spinner = this.ensureActivitySpinner("moon");
        this.syncAgentSwarmActivitySpinner(
          placeSpinnerInAgentSwarm ? spinner : undefined,
        );
        if (placeSpinnerInAgentSwarm) break;
        this.host.state.activityContainer.addChild(
          new ActivityPaneComponent({
            mode: "tool",
            spinner,
            tip: undefined,
          }),
        );
        break;
      }
      case "idle":
      case "session": {
        this.stopActivitySpinner();
        this.syncAgentSwarmActivitySpinner(undefined);
        // Keep a placeholder row so the activity area does not fully shrink
        // when the spinner is removed at the end of streaming; combined with
        // kimi-tui's clamp, this avoids a destructive full redraw (viewport jump).
        this.host.state.activityContainer.addChild(new Spacer(1));
        break;
      }
    }
    this.host.state.ui.requestRender();
    this.host.updateInkRenderer();
  }

  updateQueueDisplay(): void {
    this.host.state.queueContainer.clear();
    const queued = this.host.state.queuedMessages;
    if (queued.length === 0) {
      this.host.updateInkRenderer();
      return;
    }

    this.host.state.queueContainer.addChild(
      new QueuePaneComponent({
        messages: queued,
        isCompacting: this.host.state.appState.isCompacting,
        isStreaming: this.host.state.appState.streamingPhase !== "idle",
        canSteerImmediately: !this.host.deferUserMessages,
      }),
    );
    this.host.updateInkRenderer();
  }

  refreshTerminalThemeTracking(): void {
    this.stopTerminalThemeTracking();
    if (
      !isBuiltInTheme(this.host.state.appState.theme) ||
      this.host.state.appState.theme !== "auto"
    )
      return;

    this.terminalThemeTrackingDispose = installTerminalThemeTracking(
      this.host.state,
      (resolved) => {
        void this.applyResolvedAutoTheme(resolved);
      },
    );
  }

  toggleToolOutputExpansion(): void {
    this.host.state.toolOutputExpanded = !this.host.state.toolOutputExpanded;
    const children = this.host.state.transcriptContainer.children;

    // A component is expandable only if it sits at or after the start of the
    // (totalTurns - expandTurns)-th turn — i.e. it belongs to one of the most
    // recent `expandTurns` turns. Position-based so it also covers streaming
    // components that have no entry in the metadata map.
    const boundaries: number[] = [];
    for (let i = 0; i < children.length; i++) {
      if (
        this.host.transcriptCoordinator.isTurnBoundaryComponent(children[i]!)
      )
        boundaries.push(i);
    }
    const expandCutoff =
      TRANSCRIPT_EXPAND_TURNS <= 0
        ? children.length
        : boundaries.length > TRANSCRIPT_EXPAND_TURNS
          ? boundaries[boundaries.length - TRANSCRIPT_EXPAND_TURNS]!
          : 0;

    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      if (!isExpandable(child)) continue;
      child.setExpanded(this.host.state.toolOutputExpanded && i >= expandCutoff);
    }
    // Differential render only — no destructive full redraw on expand/collapse.
    // (When the expanded region reaches above the viewport, the engine's own
    // fallback may still do a full render; that path is not forced from here.)
    this.host.state.ui.requestRender();
  }

  toggleTodoPanelExpansion(): void {
    this.host.state.todoPanel.toggleExpanded();
    this.host.state.ui.requestRender();
  }

  updateEditorBorderHighlight(text?: string): void {
    const trimmed = (text ?? this.host.state.editor.getText()).trimStart();
    const isBash = this.host.state.appState.inputMode === "bash";
    const highlighted =
      this.host.state.appState.planMode || isBash || trimmed.startsWith("/");
    this.host.state.editor.borderHighlighted = highlighted;
    // Shell mode gets its own hue; plan-mode and slash context stay primary.
    const borderToken = isBash
      ? "shellMode"
      : highlighted
        ? "primary"
        : "border";
    this.host.state.editor.borderColor = (s: string) =>
      currentTheme.fg(borderToken, s);
    this.host.state.ui.requestRender();
  }

  async applyTheme(
    themeName: ThemeName,
    resolved?: ResolvedTheme,
  ): Promise<void> {
    const palette = await getColorPalette(
      themeName === "auto" ? (resolved ?? "dark") : themeName,
    );
    currentTheme.setPalette(palette);
    this.host.setAppState({ theme: themeName });
    this.updateEditorBorderHighlight();
    // Force every historical message to re-render so Markdown/Text caches
    // (which hold old ANSI colour codes) are cleared.
    this.host.state.transcriptContainer.invalidate();
    this.host.state.ui.requestRender(true);
  }

  async detachCurrentForegroundTask(): Promise<void> {
    // A running `!` shell command takes priority over agent foreground tasks.
    if (this.host.shellOutputStreams.size > 0) {
      await this.detachRunningShellCommand();
      return;
    }

    const session = this.host.session;
    if (session === undefined) {
      this.host.showError(NO_ACTIVE_SESSION_MESSAGE);
      return;
    }

    let tasks: readonly BackgroundTaskInfo[];
    try {
      // activeOnly defaults to true; foreground running tasks are non-terminal
      // and therefore included. We filter to `detached === false` ourselves.
      tasks = await session.listBackgroundTasks();
    } catch (error) {
      this.host.showError(`Failed to list tasks: ${formatErrorMessage(error)}`);
      return;
    }

    const targets = pickForegroundTasks(tasks);
    if (targets.length === 0) {
      this.showDetachHint("No foreground task running.");
      return;
    }

    let detached = 0;
    let alreadyFinished = 0;
    for (const target of targets) {
      try {
        const info = await session.detachBackgroundTask(target.taskId);
        if (info === undefined) alreadyFinished++;
        else detached++;
      } catch (error) {
        this.host.showError(
          `Failed to detach ${target.taskId}: ${formatErrorMessage(error)}`,
        );
      }
    }

    let hint: string;
    if (detached === 0 && alreadyFinished > 0) {
      hint =
        alreadyFinished === 1
          ? "Task already finished."
          : "Tasks already finished.";
    } else if (detached === targets.length) {
      hint =
        detached === 1
          ? "Moved 1 task to background."
          : `Moved ${detached} tasks to background.`;
    } else {
      hint = `Moved ${detached} of ${targets.length} tasks to background.`;
    }
    if (detached > 0) hint = `${hint} /tasks to view.`;
    this.showDetachHint(hint);
  }

  private resolveActivityPaneMode(): EffectiveActivityPaneMode {
    return resolveTerminalActivityMode(this.host.state);
  }

  private async detachRunningShellCommand(): Promise<void> {
    // Only one `!` command runs at a time (input is queued while busy).
    const next = this.host.shellOutputStreams.entries().next();
    if (next.done) {
      this.showDetachHint("No shell command running.");
      return;
    }
    const [commandId, stream] = next.value;
    if (stream.taskId === undefined) {
      this.showDetachHint("Command is still starting — try again.");
      return;
    }
    const session = this.host.session;
    if (session === undefined) return;
    try {
      const info = await session.detachBackgroundTask(stream.taskId);
      if (info === undefined) {
        this.showDetachHint("Command already finished.");
        return;
      }
    } catch (error) {
      this.host.showError(
        `Failed to move to background: ${formatErrorMessage(error)}`,
      );
      return;
    }
    // Finalize the card as backgrounded and drop the stream so the eventual
    // runShellCommand resolution (which carries background metadata) is a no-op
    // instead of overwriting this view.
    stream.component.finishBackgrounded();
    stream.entry.content = "Moved to background.";
    this.host.shellOutputStreams.delete(commandId);
    // The backgrounded command's notification turn (started by agent-core via
    // appendSystemReminderAndNotify) owns the streaming phase and drains the
    // queue when it completes, so we intentionally leave both untouched here.
    this.showDetachHint("Moved to background. /tasks to view.");
  }

  /** Show a one-shot footer hint that auto-clears after DETACH_HINT_DISPLAY_MS. */
  private showDetachHint(hint: string): void {
    if (this.detachHintClearTimer !== undefined) {
      clearTimeout(this.detachHintClearTimer);
      this.detachHintClearTimer = undefined;
    }
    this.host.state.footer.setTransientHint(hint);
    this.detachHintClearTimer = setTimeout(() => {
      this.detachHintClearTimer = undefined;
      // Don't clobber a newer transient hint (e.g. the exit-confirmation
      // prompt) that took over while this timer was pending.
      if (this.host.state.footer.getTransientHint() !== hint) return;
      this.host.state.footer.setTransientHint(null);
      this.host.state.ui.requestRender();
    }, DETACH_HINT_DISPLAY_MS);
    this.host.state.ui.requestRender();
  }

  private stopTerminalThemeTracking(): void {
    this.terminalThemeTrackingDispose?.();
    this.terminalThemeTrackingDispose = undefined;
  }

  private async applyResolvedAutoTheme(resolved: ResolvedTheme): Promise<void> {
    if (this.host.state.appState.theme !== "auto") return;
    const palette = getBuiltInPalette(resolved);
    if (currentTheme.palette === palette) return;
    currentTheme.setPalette(palette);
    this.updateEditorBorderHighlight();
    // Repaint already-rendered transcript entries (status/markdown caches hold
    // old ANSI codes), matching applyTheme()'s behaviour.
    this.host.state.transcriptContainer.invalidate();
    this.host.state.ui.requestRender(true);
  }

  private shouldShowTerminalProgress(
    effectiveMode: EffectiveActivityPaneMode,
  ): boolean {
    if (this.host.state.appState.isCompacting) return true;
    return (
      effectiveMode === "waiting" ||
      effectiveMode === "thinking" ||
      effectiveMode === "composing" ||
      effectiveMode === "tool"
    );
  }

  private shouldPlaceActivitySpinnerInAgentSwarm(
    effectiveMode: EffectiveActivityPaneMode,
  ): boolean {
    return (
      this.host.sessionEventHandler.hasActiveAgentSwarmToolCall() &&
      (effectiveMode === "waiting" || effectiveMode === "tool")
    );
  }

  private syncAgentSwarmActivitySpinner(spinner: MoonLoader | undefined): void {
    this.host.sessionEventHandler.syncAgentSwarmActivitySpinner(spinner);
  }

  private syncTerminalProgress(active: boolean): void {
    if (!this.host.state.terminalState.supportsProgress) return;
    if (this.host.state.terminalState.progressActive === active) return;
    this.host.state.terminal.setProgress(active);
    this.host.state.terminalState.progressActive = active;
  }

  private ensureActivitySpinner(
    style: SpinnerStyle,
    label = "",
    colorFn?: (s: string) => string,
  ): MoonLoader {
    if (this.host.state.activitySpinner?.style !== style) {
      this.stopActivitySpinner();
    }

    if (this.host.state.activitySpinner === null) {
      const instance = new MoonLoader(this.host.state.ui, style, colorFn, label);
      this.host.state.activitySpinner = { instance, style };
      return instance;
    }

    this.host.state.activitySpinner.instance.setLabel(label);
    if (colorFn !== undefined) {
      this.host.state.activitySpinner.instance.setColorFn(colorFn);
    }
    return this.host.state.activitySpinner.instance;
  }

  private stopActivitySpinner(): void {
    if (this.host.state.activitySpinner !== null) {
      this.host.state.activitySpinner.instance.stop();
      this.host.state.activitySpinner = null;
    }
  }
}

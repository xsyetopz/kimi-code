import type { BackgroundTaskInfo, Session } from "@moonshot-ai/kimi-code-sdk";

import { combineStartupNotice } from "#/tui/utils/startup";
import { hasPatchChanges } from "#/tui/utils/object-patch";
import type { TUIState } from "../tui-state";
import {
  INITIAL_LIVE_PANE,
  type AppState,
  type LivePaneState,
  type TranscriptEntry,
} from "../types";
import type { SessionEventHandler } from "./session-event-handler";

function sameStringArrays(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Controllers extracted from `KimiTUI` — the coordinator should shrink to a
 * composition root (wiring, delegation, lifecycle) rather than accumulating
 * state-mutation and accessor logic inline.
 */
export const KIMI_TUI_DELEGATED_CONTROLLERS = [
  "presentation-state",
  "session-orchestration",
  "transcript-coordinator",
  "ink-dialogs",
  "tui-accessors",
  "slash-setup",
  "startup-panels",
  "message-queue",
  "prompt-input",
  "tui-lifecycle",
] as const;

/** Soft line budget for `kimi-tui.ts` once controller delegation is complete. */
export const KIMI_TUI_COMPOSITION_ROOT_LINE_BUDGET = 1_800;

/** Method names owned by {@link TuiAccessorsController} (for architecture guards). */
export const TUI_ACCESSOR_METHODS = [
  "setStartupReady",
  "pushTranscriptEntry",
  "setExternalEditorRunning",
  "setTasksBrowser",
  "appendStartupNotice",
  "backgroundTasks",
  "getCurrentSessionId",
  "hasSessionContent",
  "getStartupMcpMs",
  "setAppState",
  "patchLivePane",
  "resetLivePane",
] as const;

export function isKimiTuiDelegatedController(
  name: string,
): name is (typeof KIMI_TUI_DELEGATED_CONTROLLERS)[number] {
  return (KIMI_TUI_DELEGATED_CONTROLLERS as readonly string[]).includes(name);
}

export interface TuiAccessorsHost {
  readonly state: TUIState;
  readonly session: Session | undefined;
  readonly sessionEventHandler: SessionEventHandler;
  startupNotice: string | undefined;

  updateInkRenderer(): void;
  updateEditorBorderHighlight(text?: string): void;
  updateActivityPane(): void;
  updateQueueDisplay(): void;
  setupAutocomplete(): void;
}

export class TuiAccessorsController {
  constructor(private readonly host: TuiAccessorsHost) {}

  setStartupReady(): void {
    this.host.state.startupState = "ready";
    this.host.updateInkRenderer();
  }

  pushTranscriptEntry(entry: TranscriptEntry): void {
    this.host.state.transcriptEntries.push(entry);
    this.host.updateInkRenderer();
  }

  setExternalEditorRunning(running: boolean): void {
    this.host.state.externalEditorRunning = running;
    this.host.updateInkRenderer();
  }

  setTasksBrowser(value: TUIState["tasksBrowser"]): void {
    this.host.state.tasksBrowser = value;
  }

  appendStartupNotice(extra: string): void {
    this.host.startupNotice = combineStartupNotice(this.host.startupNotice, extra);
  }

  get backgroundTasks(): ReadonlyMap<string, BackgroundTaskInfo> {
    return this.host.sessionEventHandler.backgroundTasks;
  }

  getCurrentSessionId(): string {
    return this.host.state.appState.sessionId;
  }

  hasSessionContent(): boolean {
    return this.host.state.transcriptEntries.length > 0;
  }

  async getStartupMcpMs(): Promise<number> {
    const session = this.host.session;
    if (session === undefined) return 0;
    try {
      const metrics = await session.getMcpStartupMetrics();
      return metrics.durationMs;
    } catch {
      return 0;
    }
  }

  setAppState(patch: Partial<AppState>): void {
    if (!hasPatchChanges(this.host.state.appState, patch)) return;
    const additionalDirsChanged =
      "additionalDirs" in patch &&
      !sameStringArrays(
        this.host.state.appState.additionalDirs,
        patch.additionalDirs ?? [],
      );
    const busyChanged = "streamingPhase" in patch || "isCompacting" in patch;
    Object.assign(this.host.state.appState, patch);
    if ("planMode" in patch) this.host.updateEditorBorderHighlight();
    this.host.state.footer.setState(this.host.state.appState);
    this.host.updateActivityPane();
    if (busyChanged) {
      this.host.updateQueueDisplay();
      this.host.sessionEventHandler.retryQueuedGoalPromotion();
    }
    if (additionalDirsChanged) this.host.setupAutocomplete();
    this.host.state.ui.requestRender();
    this.host.updateInkRenderer();
  }

  patchLivePane(patch: Partial<LivePaneState>): void {
    if (!hasPatchChanges(this.host.state.livePane, patch)) return;
    Object.assign(this.host.state.livePane, patch);
    this.host.updateActivityPane();
    this.host.state.ui.requestRender();
    this.host.updateInkRenderer();
  }

  resetLivePane(): void {
    this.host.state.livePane = { ...INITIAL_LIVE_PANE };
    this.host.updateActivityPane();
    this.host.state.ui.requestRender();
    this.host.updateInkRenderer();
  }
}

/**
 * AgentGroupComponent renders 2+ Agent tool calls from the same step as one group.
 *
 * Design:
 * - State container: each child Agent keeps its real state in its
 *   `ToolCallComponent` (subagent meta, phase, sub-tool calls, tokens, text).
 *   AgentGroup only stores references and does not copy state. Event handlers
 *   still route through `state.pendingToolComponents.get(parent_tool_call_id)`.
 * - Subscription: `attach` registers a snapshot listener on each child so the
 *   group can refresh when child state changes.
 * - Throttling: normal changes are coalesced into one render every 200ms.
 *   Phase transitions (spawning -> running -> done/failed) flush immediately.
 * - Mounting: `KimiTUI` attaches the group to the transcript at the
 *   right time; the group handles `invalidate` plus `ui.requestRender`.
 * - Ungrouping is not implemented. Once formed, a group stays grouped.
 */

import type { TUI } from "@moonshot-ai/kimi-tui";
import { Container, Spacer, Text } from "@moonshot-ai/kimi-tui";

import {
  type AgentGroupViewState,
  projectAgentGroupLines,
  shouldShowAgentGroupDetachHint,
} from "#/tui/projections/tool-call/agent-group";
import type { ToolCallSubagentSnapshot } from "./tool-call";

import type { ToolCallComponent } from "./tool-call";

const THROTTLE_MS = 200;

interface AgentEntry {
  readonly toolCallId: string;
  readonly tc: ToolCallComponent;
}

export class AgentGroupComponent extends Container {
  private readonly entries: AgentEntry[] = [];
  private readonly headerText: Text;
  private readonly bodyContainer: Container;
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushPhases = new Map<
    string,
    ToolCallSubagentSnapshot["phase"]
  >();
  private _invalidating = false;
  private onInkMirror: (() => void) | undefined;

  constructor(private readonly ui: TUI | undefined) {
    super();
    this.addChild(new Spacer(1));
    this.headerText = new Text("", 0, 0);
    this.addChild(this.headerText);
    this.bodyContainer = new Container();
    this.addChild(this.bodyContainer);
  }

  size(): number {
    return this.entries.length;
  }

  getToolCallIds(): readonly string[] {
    return this.entries.map((entry) => entry.toolCallId);
  }

  containsToolCall(toolCallId: string): boolean {
    return this.entries.some((entry) => entry.toolCallId === toolCallId);
  }

  /**
   * Exposes the borrowed tool call components so external code (e.g.
   * routing background task terminal events back to the corresponding
   * Agent card) can reach them — the group renders the tcs' snapshots
   * but never mounts the tcs as Container children, so a plain tree
   * walk of `transcriptContainer` cannot discover them.
   */
  getToolComponents(): readonly ToolCallComponent[] {
    return this.entries.map((entry) => entry.tc);
  }

  setInkMirrorListener(listener: (() => void) | undefined): void {
    this.onInkMirror = listener;
  }

  captureAgentGroupViewState(): AgentGroupViewState {
    const agents = this.entries.map((entry) => entry.tc.getSubagentSnapshot());
    return {
      agents,
      showDetachHint: shouldShowAgentGroupDetachHint(agents),
    };
  }

  /**
   * Borrows a standalone `ToolCallComponent` into the group as a hidden state
   * container. Snapshot changes trigger throttled refreshes. Re-attaching the
   * same toolCallId is a no-op.
   */
  attach(toolCallId: string, tc: ToolCallComponent): void {
    if (this.entries.some((entry) => entry.toolCallId === toolCallId)) return;
    this.entries.push({ toolCallId, tc });
    tc.setSnapshotListener(() => {
      this.scheduleRender();
    });
    this.flushRender();
  }

  /**
   * Schedules a repaint. Real phase transitions force an immediate refresh;
   * other changes such as latestActivity, tokens, or toolCount are throttled.
   */
  private scheduleRender(): void {
    if (this.detectPhaseTransition()) {
      this.flushRender();
      return;
    }
    if (this.throttleTimer !== null) return;
    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = null;
      this.flushRender();
    }, THROTTLE_MS);
  }

  /**
   * Compares each child's current phase with the phase captured at the last
   * flush. Any change is treated as a phase transition.
   */
  private detectPhaseTransition(): boolean {
    let changed = false;
    for (const entry of this.entries) {
      const phase = entry.tc.getSubagentSnapshot().phase;
      if (this.lastFlushPhases.get(entry.toolCallId) !== phase) {
        changed = true;
        break;
      }
    }
    return changed;
  }

  private flushRender(): void {
    if (this.throttleTimer !== null) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }

    const state = this.captureAgentGroupViewState();
    const lines = projectAgentGroupLines(state);
    this.headerText.setText(lines[1] ?? "");
    this.bodyContainer.clear();
    for (let index = 2; index < lines.length; index += 1) {
      this.bodyContainer.addChild(new Text(lines[index] ?? "", 0, 0));
    }

    this.lastFlushPhases.clear();
    this.entries.forEach((entry, index) => {
      const snapshot = state.agents[index];
      if (snapshot !== undefined) {
        this.lastFlushPhases.set(entry.toolCallId, snapshot.phase);
      }
    });

    this.onInkMirror?.();
    this.invalidate();
    this.ui?.requestRender();
  }

  /** Releases throttle timers so destroyed components cannot refresh later. */
  override invalidate(): void {
    if (this._invalidating) {
      super.invalidate();
      return;
    }
    this._invalidating = true;
    this.flushRender();
    this._invalidating = false;
  }

  dispose(): void {
    if (this.throttleTimer !== null) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    for (const entry of this.entries) {
      entry.tc.setSnapshotListener(undefined);
    }
  }
}

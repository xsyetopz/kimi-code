/**
 * ReadGroupComponent renders 2+ Read tool calls from the same step as one group.
 *
 * It follows the same structure as `AgentGroupComponent`, with a smaller
 * surface:
 * - one summary header and a tree body listing each file path and status;
 * - permanently grouped, while the body remains visible;
 * - 200ms throttling, matching AgentGroup;
 * - state stays in each `ToolCallComponent`; the group only reads snapshots.
 *
 * Header forms:
 *   pending > 0: Reading {N} files
 *   all done:    Read {N} files · {L} lines
 *   some failed: append · {F} failed
 *   all failed:  Read {N} files · failed
 *
 * Body lines follow AgentGroup's branch style:
 *   src/main.ts · 51 lines
 *   src/cli.ts · reading
 *   src/missing.ts · failed
 */

import type { TUI } from "@moonshot-ai/kimi-tui";
import { Container, Spacer, Text } from "@moonshot-ai/kimi-tui";

import {
  type ReadGroupViewState,
  projectReadGroupLines,
} from "#/tui/projections/tool-call/read-group";

import type { ToolCallComponent, ToolCallReadSnapshot } from "./tool-call";

const THROTTLE_MS = 200;

interface ReadEntry {
  readonly toolCallId: string;
  readonly tc: ToolCallComponent;
}

export class ReadGroupComponent extends Container {
  private readonly entries: ReadEntry[] = [];
  private readonly headerText: Text;
  private readonly bodyContainer: Container;
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushPhases = new Map<string, ToolCallReadSnapshot["phase"]>();
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

  setInkMirrorListener(listener: (() => void) | undefined): void {
    this.onInkMirror = listener;
  }

  captureReadGroupViewState(): ReadGroupViewState {
    return {
      reads: this.entries.map((entry) => entry.tc.getReadSnapshot()),
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
   * The pending -> done/failed transition is the important visible change, so
   * it refreshes immediately. Other changes are throttled.
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

  private detectPhaseTransition(): boolean {
    for (const entry of this.entries) {
      const phase = entry.tc.getReadSnapshot().phase;
      if (this.lastFlushPhases.get(entry.toolCallId) !== phase) return true;
    }
    return false;
  }

  private flushRender(): void {
    if (this.throttleTimer !== null) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }

    const state = this.captureReadGroupViewState();
    const lines = projectReadGroupLines(state);
    this.headerText.setText(lines[1] ?? "");
    this.bodyContainer.clear();
    for (let index = 2; index < lines.length; index += 1) {
      this.bodyContainer.addChild(new Text(lines[index] ?? "", 0, 0));
    }

    this.lastFlushPhases.clear();
    this.entries.forEach((entry, index) => {
      const snapshot = state.reads[index];
      if (snapshot !== undefined) {
        this.lastFlushPhases.set(entry.toolCallId, snapshot.phase);
      }
    });

    this.onInkMirror?.();
    this.invalidate();
    this.ui?.requestRender();
  }

  override invalidate(): void {
    if (this._invalidating) {
      super.invalidate();
      return;
    }
    this._invalidating = true;
    this.flushRender();
    this._invalidating = false;
  }

  /** Releases throttle timers so destroyed components cannot refresh later. */
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

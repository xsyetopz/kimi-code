import { isKeyRelease, matchesKey } from "../keys.ts";
import {
  isOsc11BackgroundColorResponse,
  parseOsc11BackgroundColor,
  parseTerminalColorSchemeReport,
} from "../terminal-colors.ts";
import { getCapabilities, setCellDimensions } from "../terminal-image.ts";
import type { TUI } from "./tui-class.ts";

export function queryCellSize(this: TUI): void {
  // Only query if terminal supports images (cell size is only used for image rendering)
  if (!getCapabilities().images) {
    return;
  }
  // Query terminal for cell size in pixels: CSI 16 t
  // Response format: CSI 6 ; height ; width t
  this.terminal.write("\x1b[16t");
}

export function handleInput(this: TUI, data: string): void {
  if (this.consumeOsc11BackgroundResponse(data)) {
    return;
  }
  if (this.consumeTerminalColorSchemeReport(data)) {
    return;
  }

  if (this.inputListeners.size > 0) {
    let current = data;
    for (const listener of this.inputListeners) {
      const result = listener(current);
      if (result?.consume) {
        return;
      }
      if (result?.data !== undefined) {
        current = result.data;
      }
    }
    if (current.length === 0) {
      return;
    }
    data = current;
  }

  // Consume terminal cell size responses without blocking unrelated input.
  if (this.consumeCellSizeResponse(data)) {
    return;
  }

  // Global debug key handler (Shift+Ctrl+D)
  if (matchesKey(data, "shift+ctrl+d") && this.onDebug) {
    this.onDebug();
    return;
  }

  // If focused component is an overlay, verify it's still visible
  // (visibility can change due to terminal resize or visible() callback)
  const focusedOverlay = this.overlayStack.find(
    (o) => o.component === this.focusedComponent,
  );
  if (focusedOverlay && !this.isOverlayVisible(focusedOverlay)) {
    // Focused overlay is no longer visible, redirect to topmost visible overlay
    const topVisible = this.getTopmostVisibleOverlay();
    if (topVisible) {
      this.setFocus(topVisible.component);
    } else {
      this.setFocusInternal({
        component: focusedOverlay.preFocus,
        overlayFocusRestore: "preserve",
      });
    }
  }

  const focusIsOverlay = this.overlayStack.some(
    (o) => o.component === this.focusedComponent,
  );
  if (!focusIsOverlay) {
    const restoreState = this.getVisibleOverlayFocusRestore();
    if (restoreState.status === "eligible") {
      this.setFocus(restoreState.overlay.component);
    } else if (
      restoreState.status === "blocked" &&
      restoreState.blockedBy !== this.focusedComponent
    ) {
      if (restoreState.resume.status === "restore-overlay") {
        this.setFocus(restoreState.overlay.component);
      } else {
        this.clearOverlayFocusRestore();
        this.setFocus(restoreState.resume.target);
      }
    }
  }

  // Pass input to focused component (including Ctrl+C)
  // The focused component can decide how to handle Ctrl+C
  if (this.focusedComponent?.handleInput) {
    // Filter out key release events unless component opts in
    if (isKeyRelease(data) && !this.focusedComponent.wantsKeyRelease) {
      return;
    }
    this.focusedComponent.handleInput(data);
    this.requestRender();
  }
}

export function consumeOsc11BackgroundResponse(
  this: TUI,
  data: string,
): boolean {
  if (this.pendingOsc11BackgroundReplies <= 0) {
    return false;
  }

  if (!isOsc11BackgroundColorResponse(data)) {
    return false;
  }

  const rgb = parseOsc11BackgroundColor(data);
  this.pendingOsc11BackgroundReplies -= 1;
  const query = this.pendingOsc11BackgroundQueries.shift();
  if (query && !query.settled) {
    query.settled = true;
    if (query.timer) {
      clearTimeout(query.timer);
      query.timer = undefined;
    }
    query.resolve?.(rgb);
    query.resolve = undefined;
  }
  return true;
}

export function consumeTerminalColorSchemeReport(
  this: TUI,
  data: string,
): boolean {
  const scheme = parseTerminalColorSchemeReport(data);
  if (!scheme) {
    return false;
  }

  for (const listener of this.terminalColorSchemeListeners) {
    listener(scheme);
  }
  return true;
}

export function consumeCellSizeResponse(this: TUI, data: string): boolean {
  // Response format: ESC [ 6 ; height ; width t
  const match = data.match(/^\x1b\[6;(\d+);(\d+)t$/u);
  if (!match) {
    return false;
  }

  const heightPx = Number.parseInt(match[1]!, 10);
  const widthPx = Number.parseInt(match[2]!, 10);
  if (heightPx <= 0 || widthPx <= 0) {
    return true;
  }

  setCellDimensions({ widthPx, heightPx });
  // Invalidate all components so images re-render with correct dimensions.
  this.invalidate();
  this.requestRender();
  return true;
}

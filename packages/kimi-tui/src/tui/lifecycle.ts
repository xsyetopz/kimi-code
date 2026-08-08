import { performance } from "node:perf_hooks";
import process from "node:process";
import type { RgbColor, TerminalColorScheme } from "../terminal-colors.ts";
import { MIN_RENDER_INTERVAL_MS } from "./constants.ts";
import type {
  InputListener,
  PendingOsc11BackgroundQuery,
} from "./overlay-shared.ts";
import type { TUI } from "./tui-class.ts";

export function start(this: TUI): void {
  this.stopped = false;
  this.terminal.start(
    (data) => this.handleInput(data),
    () => this.requestRender(),
  );
  this.terminal.hideCursor();
  if (this.terminalColorSchemeNotificationsEnabled) {
    this.terminal.write("\x1b[?2031h");
  }
  this.queryCellSize();
  this.requestRender();
}

export function addInputListener(
  this: TUI,
  listener: InputListener,
): () => void {
  this.inputListeners.add(listener);
  return () => {
    this.inputListeners.delete(listener);
  };
}

export function removeInputListener(this: TUI, listener: InputListener): void {
  this.inputListeners.delete(listener);
}

/**
 * Run registered input listeners without forwarding to the focused component.
 * Used when Ink owns stdin: capability replies still need theme/focus handlers,
 * but leftovers must go to the Ink prompt path rather than the legacy editor.
 *
 * Returns `{ consume: true }` when fully consumed, otherwise the remaining data.
 */
export function filterInput(
  this: TUI,
  data: string,
): { consume: true } | { data: string } {
  if (this.inputListeners.size === 0) {
    return { data };
  }

  let current = data;
  for (const listener of this.inputListeners) {
    const result = listener(current);
    if (result?.consume) {
      return { consume: true };
    }
    if (result?.data !== undefined) {
      current = result.data;
    }
  }
  if (current.length === 0) {
    return { consume: true };
  }
  return { data: current };
}

export function onTerminalColorSchemeChange(
  this: TUI,
  listener: (scheme: TerminalColorScheme) => void,
): () => void {
  this.terminalColorSchemeListeners.add(listener);
  return () => {
    this.terminalColorSchemeListeners.delete(listener);
  };
}

export function setTerminalColorSchemeNotifications(
  this: TUI,
  enabled: boolean,
): void {
  if (this.terminalColorSchemeNotificationsEnabled === enabled) {
    return;
  }
  this.terminalColorSchemeNotificationsEnabled = enabled;
  if (!this.stopped) {
    this.terminal.write(enabled ? "\x1b[?2031h" : "\x1b[?2031l");
  }
}

export function stop(this: TUI): void {
  this.stopped = true;
  if (this.renderTimer) {
    clearTimeout(this.renderTimer);
    this.renderTimer = undefined;
  }
  if (this.terminalColorSchemeNotificationsEnabled) {
    this.terminal.write("\x1b[?2031l");
  }
  // Move cursor to the end of the content to prevent overwriting/artifacts on exit
  if (this.previousLines.length > 0) {
    const targetRow = this.previousLines.length; // Line after the last content
    const lineDiff = targetRow - this.hardwareCursorRow;
    if (lineDiff > 0) {
      this.terminal.write(`\x1b[${lineDiff}B`);
    } else if (lineDiff < 0) {
      this.terminal.write(`\x1b[${-lineDiff}A`);
    }
    this.terminal.write("\r\n");
  }

  this.terminal.showCursor();
  this.terminal.stop();
}

export function requestRender(this: TUI, force = false): void {
  if (force) {
    this.previousLines = [];
    this.previousWidth = -1; // -1 triggers widthChanged, forcing a full clear
    this.previousHeight = -1; // -1 triggers heightChanged, forcing a full clear
    this.cursorRow = 0;
    this.hardwareCursorRow = 0;
    this.maxLinesRendered = 0;
    this.previousViewportTop = 0;
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }
    this.renderRequested = true;
    process.nextTick(() => {
      if (this.stopped || !this.renderRequested) {
        return;
      }
      this.renderRequested = false;
      this.lastRenderAt = performance.now();
      this.doRender();
    });
    return;
  }
  if (this.renderRequested) return;
  this.renderRequested = true;
  process.nextTick(() => this.scheduleRender());
}

export function scheduleRender(this: TUI): void {
  if (this.stopped || this.renderTimer || !this.renderRequested) {
    return;
  }
  const elapsed = performance.now() - this.lastRenderAt;
  const delay = Math.max(0, MIN_RENDER_INTERVAL_MS - elapsed);
  this.renderTimer = setTimeout(() => {
    this.renderTimer = undefined;
    if (this.stopped || !this.renderRequested) {
      return;
    }
    this.renderRequested = false;
    this.lastRenderAt = performance.now();
    this.doRender();
    if (this.renderRequested) {
      this.scheduleRender();
    }
  }, delay);
}

export function dispatchInput(this: TUI, data: string): void {
  this.handleInput(data);
}

export function queryTerminalBackgroundColor(
  this: TUI,
  {
    timeoutMs,
  }: {
    timeoutMs: number;
  },
): Promise<RgbColor | undefined> {
  return new Promise((resolve) => {
    const query: PendingOsc11BackgroundQuery = {
      settled: false,
      resolve,
      timer: undefined,
    };

    query.timer = setTimeout(() => {
      if (query.settled) {
        return;
      }
      query.settled = true;
      query.timer = undefined;
      query.resolve?.(undefined);
      query.resolve = undefined;
    }, timeoutMs);
    this.pendingOsc11BackgroundQueries.push(query);
    this.pendingOsc11BackgroundReplies += 1;
    this.terminal.write("\x1b]11;?\x07");
  });
}

export function queryTerminalColorScheme(
  this: TUI,
  {
    timeoutMs,
  }: {
    timeoutMs: number;
  },
): Promise<TerminalColorScheme | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let unsubscribe: () => void = () => {};
    const settle = (scheme: TerminalColorScheme | undefined) => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      unsubscribe();
      resolve(scheme);
    };

    unsubscribe = this.onTerminalColorSchemeChange(settle);
    timer = setTimeout(() => settle(undefined), timeoutMs);
    this.terminal.write("\x1b[?996n");
  });
}

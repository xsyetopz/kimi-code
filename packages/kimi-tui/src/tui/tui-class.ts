import type { Terminal } from "../terminal.ts";
import { Container } from "./contracts.ts";
import type { Component } from "./contracts.ts";
import type {
  InputListener,
  OverlayFocusRestoreState,
  OverlayStackEntry,
  PendingOsc11BackgroundQuery,
} from "./overlay-shared.ts";
import type { TerminalColorScheme } from "../terminal-colors.ts";
import { setFocusInternal } from "./overlayFocus.ts";
import { clearOverlayFocusRestore } from "./overlayFocus.ts";
import { clearOverlayFocusRestoreFor } from "./overlayFocus.ts";
import { resolveBlockedOverlayFocusResume } from "./overlayFocus.ts";
import { getVisibleOverlayFocusRestore } from "./overlayFocus.ts";
import { isOverlayFocusAncestor } from "./overlayFocus.ts";
import { retargetOverlayPreFocus } from "./overlayFocus.ts";
import { isComponentMounted } from "./overlayFocus.ts";
import { containsComponent } from "./overlayFocus.ts";
import { showOverlay } from "./overlayFocus.ts";
import { hideOverlay } from "./overlayFocus.ts";
import { hasOverlay } from "./overlayFocus.ts";
import { isOverlayVisible } from "./overlayFocus.ts";
import { getTopmostVisibleOverlay } from "./overlayFocus.ts";
import { start } from "./lifecycle.ts";
import { addInputListener } from "./lifecycle.ts";
import { removeInputListener } from "./lifecycle.ts";
import { onTerminalColorSchemeChange } from "./lifecycle.ts";
import { setTerminalColorSchemeNotifications } from "./lifecycle.ts";
import { queryCellSize } from "./inputHandlers.ts";
import { stop } from "./lifecycle.ts";
import { requestRender } from "./lifecycle.ts";
import { scheduleRender } from "./lifecycle.ts";
import { handleInput } from "./inputHandlers.ts";
import { dispatchInput } from "./lifecycle.ts";
import { consumeOsc11BackgroundResponse } from "./inputHandlers.ts";
import { consumeTerminalColorSchemeReport } from "./inputHandlers.ts";
import { consumeCellSizeResponse } from "./inputHandlers.ts";
import { resolveOverlayLayout } from "./overlayLayout.ts";
import { resolveAnchorRow } from "./overlayLayout.ts";
import { resolveAnchorCol } from "./overlayLayout.ts";
import { compositeOverlays } from "./overlayLayout.ts";
import { unionKittyImageIds } from "./renderPipeline.ts";
import { deleteKittyImages } from "./renderPipeline.ts";
import { getKittyImageReservedRows } from "./renderPipeline.ts";
import { expandChangedRangeForKittyImages } from "./renderPipeline.ts";
import { deleteChangedKittyImages } from "./renderPipeline.ts";
import { compositeLineAt } from "./overlayLayout.ts";
import { extractCursorPosition } from "./renderPipeline.ts";
import { doRender } from "./renderPipeline.ts";
import { positionHardwareCursor } from "./renderPipeline.ts";
import { queryTerminalBackgroundColor } from "./lifecycle.ts";
import { queryTerminalColorScheme } from "./lifecycle.ts";

export class TUI extends Container {
  public terminal: Terminal;
  protected previousLines: string[] = [];
  /**
   * Raw (pre-processing) lines of the previous frame, aligned with
   * {@link previousLines}. Component render caches return identical string
   * references for unchanged content, which lets each frame reuse the
   * processed output for every untouched line instead of re-normalizing and
   * re-comparing the whole transcript (see doRender).
   */
  protected previousRawLines: string[] = [];
  /** Per-line kitty image ids of the previous frame, aligned with previousRawLines. */
  protected previousLineImageIds: ReadonlyArray<number>[] = [];
  protected previousKittyImageIds = new Set<number>();
  protected previousWidth = 0;
  protected previousHeight = 0;
  protected focusedComponent: Component | null = null;
  protected inputListeners = new Set<InputListener>();

  /** Global callback for debug key (Shift+Ctrl+D). Called before input is forwarded to focused component. */
  public onDebug?: () => void;
  protected renderRequested = false;
  protected renderTimer: NodeJS.Timeout | undefined;
  protected lastRenderAt = 0;
  protected cursorRow = 0; // Logical cursor row (end of rendered content)
  protected hardwareCursorRow = 0; // Actual terminal cursor row (may differ due to IME positioning)
  protected showHardwareCursor = process.env["PI_HARDWARE_CURSOR"] === "1";
  protected clearOnShrink = process.env["PI_CLEAR_ON_SHRINK"] === "1"; // Clear empty rows when content shrinks (default: off)
  protected maxLinesRendered = 0; // Track terminal's working area (max lines ever rendered)
  protected previousViewportTop = 0; // Track previous viewport top for resize-aware cursor moves
  protected fullRedrawCount = 0;
  protected stopped = false;
  protected pendingOsc11BackgroundReplies = 0;
  protected pendingOsc11BackgroundQueries: PendingOsc11BackgroundQuery[] = [];
  protected terminalColorSchemeListeners = new Set<
    (scheme: TerminalColorScheme) => void
  >();
  protected terminalColorSchemeNotificationsEnabled = false;

  // Overlay stack for modal components rendered on top of base content
  protected focusOrderCounter = 0;
  protected overlayStack: OverlayStackEntry[] = [];
  protected overlayFocusRestore: OverlayFocusRestoreState = {
    status: "inactive",
  };

  constructor(terminal: Terminal, showHardwareCursor?: boolean) {
    super();
    this.terminal = terminal;
    if (showHardwareCursor !== undefined) {
      this.showHardwareCursor = showHardwareCursor;
    }
  }

  get fullRedraws(): number {
    return this.fullRedrawCount;
  }

  getShowHardwareCursor(): boolean {
    return this.showHardwareCursor;
  }

  setShowHardwareCursor(enabled: boolean): void {
    if (this.showHardwareCursor === enabled) return;
    this.showHardwareCursor = enabled;
    if (!enabled) {
      this.terminal.hideCursor();
    }
    this.requestRender();
  }

  getClearOnShrink(): boolean {
    return this.clearOnShrink;
  }

  setClearOnShrink(enabled: boolean): void {
    this.clearOnShrink = enabled;
  }

  setFocus(component: Component | null): void {
    this.setFocusInternal({ component, overlayFocusRestore: "clear" });
  }

  override invalidate(): void {
    super.invalidate();
    for (const overlay of this.overlayStack) overlay.component.invalidate?.();
  }

  setFocusInternal = setFocusInternal;
  clearOverlayFocusRestore = clearOverlayFocusRestore;
  clearOverlayFocusRestoreFor = clearOverlayFocusRestoreFor;
  resolveBlockedOverlayFocusResume = resolveBlockedOverlayFocusResume;
  getVisibleOverlayFocusRestore = getVisibleOverlayFocusRestore;
  isOverlayFocusAncestor = isOverlayFocusAncestor;
  retargetOverlayPreFocus = retargetOverlayPreFocus;
  isComponentMounted = isComponentMounted;
  containsComponent = containsComponent;
  showOverlay = showOverlay;
  hideOverlay = hideOverlay;
  hasOverlay = hasOverlay;
  isOverlayVisible = isOverlayVisible;
  getTopmostVisibleOverlay = getTopmostVisibleOverlay;
  start = start;
  addInputListener = addInputListener;
  removeInputListener = removeInputListener;
  onTerminalColorSchemeChange = onTerminalColorSchemeChange;
  setTerminalColorSchemeNotifications = setTerminalColorSchemeNotifications;
  queryCellSize = queryCellSize;
  stop = stop;
  requestRender = requestRender;
  scheduleRender = scheduleRender;
  handleInput = handleInput;
  dispatchInput = dispatchInput;
  consumeOsc11BackgroundResponse = consumeOsc11BackgroundResponse;
  consumeTerminalColorSchemeReport = consumeTerminalColorSchemeReport;
  consumeCellSizeResponse = consumeCellSizeResponse;
  resolveOverlayLayout = resolveOverlayLayout;
  resolveAnchorRow = resolveAnchorRow;
  resolveAnchorCol = resolveAnchorCol;
  compositeOverlays = compositeOverlays;
  unionKittyImageIds = unionKittyImageIds;
  deleteKittyImages = deleteKittyImages;
  getKittyImageReservedRows = getKittyImageReservedRows;
  expandChangedRangeForKittyImages = expandChangedRangeForKittyImages;
  deleteChangedKittyImages = deleteChangedKittyImages;
  compositeLineAt = compositeLineAt;
  extractCursorPosition = extractCursorPosition;
  doRender = doRender;
  positionHardwareCursor = positionHardwareCursor;
  queryTerminalBackgroundColor = queryTerminalBackgroundColor;
  queryTerminalColorScheme = queryTerminalColorScheme;
}

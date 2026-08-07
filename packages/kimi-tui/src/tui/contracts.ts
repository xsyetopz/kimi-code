import process from "node:process";
import { visibleWidth } from "../utils.ts";

export interface Component {
  /**
   * Render the component to lines for the given viewport width
   * @param width - Current viewport width
   * @returns Array of strings, each representing a line
   */
  render(width: number): string[];

  /**
   * Optional handler for keyboard input when component has focus
   */
  handleInput?(data: string): void;

  /**
   * If true, component receives key release events (Kitty protocol).
   * Default is false - release events are filtered out.
   */
  wantsKeyRelease?: boolean;

  /**
   * Invalidate any cached rendering state.
   * Called when theme changes or when component needs to re-render from scratch.
   */
  invalidate(): void;
}

type InputListenerResult = { consume?: boolean; data?: string } | undefined;
type InputListener = (data: string) => InputListenerResult;
type PendingOsc11BackgroundQuery = {
  settled: boolean;
  resolve: ((rgb: RgbColor | undefined) => void) | undefined;
  timer: NodeJS.Timeout | undefined;
};

/**
 * Interface for components that can receive focus and display a hardware cursor.
 * When focused, the component should emit CURSOR_MARKER at the cursor position
 * in its render output. TUI will find this marker and position the hardware
 * cursor there for proper IME candidate window positioning.
 */
export interface Focusable {
  /** Set by TUI when focus changes. Component should emit CURSOR_MARKER when true. */
  focused: boolean;
}

/** Type guard to check if a component implements Focusable */
export function isFocusable(
  component: Component | null,
): component is Component & Focusable {
  return component !== null && "focused" in component;
}

/**
 * Cursor position marker - APC (Application Program Command) sequence.
 * This is a zero-width escape sequence that terminals ignore.
 * Components emit this at the cursor position when focused.
 * TUI finds and strips this marker, then positions the hardware cursor there.
 */
export const CURSOR_MARKER = "\x1b_pi:c\x07";

export { visibleWidth };

/**
 * Anchor position for overlays
 */
export type OverlayAnchor =
  | "center"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right"
  | "top-center"
  | "bottom-center"
  | "left-center"
  | "right-center";

/**
 * Margin configuration for overlays
 */
export interface OverlayMargin {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

/** Value that can be absolute (number) or percentage (string like "50%") */
export type SizeValue = number | `${number}%`;

/** Parse a SizeValue into absolute value given a reference size */
function _parseSizeValue(
  value: SizeValue | undefined,
  referenceSize: number,
): number | undefined {
  if (value === undefined) return;
  if (typeof value === "number") return value;
  // Parse percentage string like "50%"
  const match = value.match(/^(\d+(?:\.\d+)?)%$/u);
  if (match) {
    return Math.floor((referenceSize * Number.parseFloat(match[1]!)) / 100);
  }
}

function _isTermuxSession(): boolean {
  return Boolean(process.env.TERMUX_VERSION);
}

/**
 * Options for overlay positioning and sizing.
 * Values can be absolute numbers or percentage strings (e.g., "50%").
 */
export interface OverlayOptions {
  // === Sizing ===
  /** Width in columns, or percentage of terminal width (e.g., "50%") */
  width?: SizeValue;
  /** Minimum width in columns */
  minWidth?: number;
  /** Maximum height in rows, or percentage of terminal height (e.g., "50%") */
  maxHeight?: SizeValue;

  // === Positioning - anchor-based ===
  /** Anchor point for positioning (default: 'center') */
  anchor?: OverlayAnchor;
  /** Horizontal offset from anchor position (positive = right) */
  offsetX?: number;
  /** Vertical offset from anchor position (positive = down) */
  offsetY?: number;

  // === Positioning - percentage or absolute ===
  /** Row position: absolute number, or percentage (e.g., "25%" = 25% from top) */
  row?: SizeValue;
  /** Column position: absolute number, or percentage (e.g., "50%" = centered horizontally) */
  col?: SizeValue;

  // === Margin from terminal edges ===
  /** Margin from terminal edges. Number applies to all sides. */
  margin?: OverlayMargin | number;

  // === Visibility ===
  /**
   * Control overlay visibility based on terminal dimensions.
   * If provided, overlay is only rendered when this returns true.
   * Called each render cycle with current terminal dimensions.
   */
  visible?: (termWidth: number, termHeight: number) => boolean;
  /** If true, don't capture keyboard focus when shown */
  nonCapturing?: boolean;
}

/** Options for {@link OverlayHandle.unfocus}. */
export interface OverlayUnfocusOptions {
  /** Explicit target to focus after releasing this overlay. */
  target: Component | null;
}

/**
 * Handle returned by showOverlay for controlling the overlay
 */
export interface OverlayHandle {
  /** Permanently remove the overlay (cannot be shown again) */
  hide(): void;
  /** Temporarily hide or show the overlay */
  setHidden(hidden: boolean): void;
  /** Check if overlay is temporarily hidden */
  isHidden(): boolean;
  /** Focus this overlay and bring it to the visual front */
  focus(): void;
  /** Release focus to the next visible capturing overlay or previous target, or to an explicit target when provided */
  unfocus(options?: OverlayUnfocusOptions): void;
  /** Check if this overlay currently has focus */
  isFocused(): boolean;
}

type OverlayStackEntry = {
  component: Component;
  options?: OverlayOptions;
  preFocus: Component | null;
  hidden: boolean;
  focusOrder: number;
};

type OverlayBlockedFocusResume =
  | { status: "restore-overlay" }
  | { status: "focus-target"; target: Component | null };
type EligibleOverlayFocusRestoreState = {
  status: "eligible";
  overlay: OverlayStackEntry;
};
type BlockedOverlayFocusRestoreState = {
  status: "blocked";
  overlay: OverlayStackEntry;
  blockedBy: Component;
  resume: OverlayBlockedFocusResume;
};
type ActiveOverlayFocusRestoreState =
  | EligibleOverlayFocusRestoreState
  | BlockedOverlayFocusRestoreState;
type OverlayFocusRestoreState =
  | { status: "inactive" }
  | ActiveOverlayFocusRestoreState;
type OverlayFocusRestorePolicy = "clear" | "preserve";

/**
 * Container - a component that contains other components
 */
export class Container implements Component {
  children: Component[] = [];

  addChild(component: Component): void {
    this.children.push(component);
  }

  removeChild(component: Component): void {
    const index = this.children.indexOf(component);
    if (index !== -1) {
      this.children.splice(index, 1);
    }
  }

  clear(): void {
    this.children = [];
  }

  invalidate(): void {
    for (const child of this.children) {
      child.invalidate?.();
    }
  }

  render(width: number): string[] {
    // Extremely narrow terminals can report tiny or even non-positive
    // column counts; never propagate a width below 1 into components.
    width = Math.max(1, width);
    const lines: string[] = [];
    for (const child of this.children) {
      const childLines = child.render(width);
      for (const line of childLines) {
        lines.push(line);
      }
    }
    return lines;
  }
}

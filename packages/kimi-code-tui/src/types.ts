/**
 * Core types for Kimi Code React+Ink TUI renderer.
 * Replaces @moonshot-ai/pi-tui Component interface.
 */

import type { Provider, Text } from "ink";

/**
 * Base component interface for React+Ink renderable elements.
 */
export interface Component {
  /**
   * Render the component to lines for the given viewport width.
   * @param width - Current viewport width (columns)
   * @returns Array of strings, each representing a line of text
   */
  render(width: number): string[];

  /**
   * Optional handler for keyboard input when component has focus.
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

/**
 * Interface for components that can receive focus and display a hardware cursor.
 * When focused, the component should emit CURSOR_MARKER at the cursor position
 * in its render output. TUI will find this marker and position the hardware cursor there.
 */
export interface Focusable {
  focused: boolean;
}

/**
 * Type guard to check if a component implements Focusable
 */
export function isFocusable(
  component: Component | null,
): component is Component & Focusable {
  return component !== null && "focused" in component;
}

/**
 * Cursor position marker - APC (Application Program Command) sequence.
 * This is a zero-width escape sequence that terminals ignore.
 * Components emit this at the cursor position when focused.
 */
export const CURSOR_MARKER = "\x1b_pi:c\x07";

/**
 * Overlay anchor positions - 9 possible alignment points for modal overlays.
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
 * Size value - can be absolute (number) or percentage (string like "50%").
 */
export type SizeValue = number | `${number}%`;

/**
 * Margin configuration for overlays.
 */
export interface OverlayMargin {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

/**
 * Options for overlay positioning and sizing.
 */
export interface OverlayOptions {
  // Sizing
  /** Width in columns, or percentage of terminal width (e.g., "50%") */
  width?: SizeValue;
  /** Minimum width in columns */
  minWidth?: number;
  /** Maximum height in rows, or percentage of terminal height (e.g., "50%") */
  maxHeight?: SizeValue;

  // Positioning - anchor-based
  /** Anchor point for positioning (default: 'center') */
  anchor?: OverlayAnchor;
  /** Horizontal offset from anchor position (positive = right) */
  offsetX?: number;
  /** Vertical offset from anchor position (positive = down) */
  offsetY?: number;

  // Positioning - percentage or absolute
  /** Row position: absolute number, or percentage (e.g., "25%" = 25% from top) */
  row?: SizeValue;
  /** Column position: absolute number, or percentage (e.g., "50%" = centered horizontally) */
  col?: SizeValue;

  // Margin from terminal edges
  /** Margin from terminal edges. Number applies to all sides. */
  margin?: OverlayMargin | number;

  // Visibility
  /**
   * Control overlay visibility based on terminal dimensions.
   * If provided, overlay is only rendered when this returns true.
   * Called each render cycle with current terminal dimensions.
   */
  visible?: (termWidth: number, termHeight: number) => boolean;
  /** If true, don't capture keyboard focus when shown */
  nonCapturing?: boolean;
}

/**
 * Handle returned by showOverlay for controlling the overlay.
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
  /** Release focus to the next visible capturing overlay or previous target */
  unfocus(options?: OverlayUnfocusOptions): void;
  /** Check if this overlay currently has focus */
  isFocused(): boolean;
}

/**
 * Options for {@link OverlayHandle.unfocus}
 */
export interface OverlayUnfocusOptions {
  /** Explicit target to focus after releasing this overlay */
  target: Component | null;
}

/**
 * Type for pending overlay focus restoration state.
 */
type ActiveOverlayFocusRestoreState =
  | { status: "eligible"; overlay: OverlayStackEntry }
  | { status: "blocked"; overlay: OverlayStackEntry; blockedBy: Component };

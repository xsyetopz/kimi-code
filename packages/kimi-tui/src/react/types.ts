/**
 * Renderer-agnostic layout primitives shared by React, Ink, and pi-tui hosts.
 */

/** Horizontal and vertical padding for box-like containers. */
export interface UiPadding {
  x?: number;
  y?: number;
}

/** Renderer-agnostic text node props. */
export interface UiTextProps {
  children?: string;
  padding?: UiPadding;
}

/** Renderer-agnostic box container props. */
export interface UiBoxProps {
  children?: unknown;
  padding?: UiPadding;
}

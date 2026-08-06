/**
 * Graphics utilities for React+Ink TUI.
 */

import type { BoxProps } from "./components/box";

/**
 * Create a horizontal rule (line) component.
 */
export function createHorizontalRule(props: Partial<BoxProps> = {}): any {
  return {
    render(width: number): string[] {
      const separator = "─".repeat(width);
      return [separator];
    },
    invalidate(): void {},
    ...props,
  };
}

/**
 * Create a spacer component (empty line).
 */
export function createSpacer(lines: number = 1): any {
  return {
    render(width: number): string[] {
      const content = width > 0 ? " ".repeat(width) : "";
      return Array.from({ length: lines }, () => content);
    },
    invalidate(): void {},
  };
}

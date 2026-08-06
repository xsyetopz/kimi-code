/**
 * @moonshot-ai/kimi-code-tui
 *
 * React+Ink renderer for Kimi Code TUI.
 * This package replaces @moonshot-ai/pi-tui with a modern, dependency-free
 * implementation using React 19 + Ink 7.
 */

export * from "./src/types";

// Utility re-exports
export { visibleWidth, asciiVisibleWidth, ASCII_CACHE_SIZE } from "./src/utils/visibleWidth";
export { sliceByColumn } from "./src/utils/sliceByColumn";

// Hooks
export { useTerminalDimensions } from "./src/hooks/useTerminalDimensions";
export { useInputMode } from "./src/hooks/useInputMode";
export { useInkEditor } from "./src/hooks/useInkEditor";

// Components
export { Box } from "./src/components/box";
export { BoxProps } from "./src/components/box";

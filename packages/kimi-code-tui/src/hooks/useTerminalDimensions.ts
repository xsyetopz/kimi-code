/**
 * React hook to get current terminal dimensions.
 *
 * This hook uses Ink's `useWindowDimensions()` internally and provides
 * a React-friendly interface for components that need viewport sizing.
 */
import * as React from "react";
import { useWindowDimensions, useLength } from "ink";

export interface TerminalDimensions {
  width: number;
  height: number;
  widthInInches: number;
  heightInInches: number;
}

export function useTerminalDimensions(): TerminalDimensions {
  const dims = useWindowDimensions();

  // Convert pixels to inches using column width if available
  const widthInInches = useLength(dims.width, "in");
  const heightInInches = useLength(dims.height, "in");

  return {
    width: dims.width,
    height: dims.height,
    widthInInches,
    heightInInches,
  };
}

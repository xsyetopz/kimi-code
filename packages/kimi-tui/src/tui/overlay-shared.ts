/** Value that can be absolute (number) or percentage (string like "50%") */
import process from "node:process";
export type SizeValue = number | `${number}%`;

/** Parse a SizeValue into absolute value given a reference size */
export function parseSizeValue(
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

export function isTermuxSession(): boolean {
  return Boolean(process.env.TERMUX_VERSION);
}

import type { Component, OverlayOptions } from "./contracts.ts";

export type OverlayStackEntry = {
  component: Component;
  options?: OverlayOptions;
  preFocus: Component | null;
  hidden: boolean;
  focusOrder: number;
};

export type OverlayBlockedFocusResume =
  | { status: "restore-overlay" }
  | { status: "focus-target"; target: Component | null };
export type EligibleOverlayFocusRestoreState = {
  status: "eligible";
  overlay: OverlayStackEntry;
};
export type BlockedOverlayFocusRestoreState = {
  status: "blocked";
  overlay: OverlayStackEntry;
  blockedBy: Component;
  resume: OverlayBlockedFocusResume;
};
export type ActiveOverlayFocusRestoreState =
  | EligibleOverlayFocusRestoreState
  | BlockedOverlayFocusRestoreState;
export type OverlayFocusRestoreState =
  | { status: "inactive" }
  | ActiveOverlayFocusRestoreState;
export type OverlayFocusRestorePolicy = "clear" | "preserve";

export type InputListenerResult =
  | { consume?: boolean; data?: string }
  | undefined;
export type InputListener = (data: string) => InputListenerResult;
export type PendingOsc11BackgroundQuery = {
  settled: boolean;
  resolve:
    | ((rgb: import("../terminal-colors.ts").RgbColor | undefined) => void)
    | undefined;
  timer: NodeJS.Timeout | undefined;
};

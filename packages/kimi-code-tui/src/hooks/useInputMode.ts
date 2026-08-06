/**
 * React hook to track text editing input mode.
 *
 * Input modes: "text" (insert-like), "navigation" (arrow keys), "autocomplete" (tab/enter).
 */
import * as React from "react";

export type InputMode = "text" | "navigation" | "autocomplete";

export interface InputModeState {
  mode: InputMode;
  setMode: (mode: InputMode) => void;
}

export function useInputMode(initialMode: InputMode = "text"): InputModeState {
  const [mode, setMode] = React.useState<InputMode>(initialMode);

  return {
    mode,
    setMode,
  };
}

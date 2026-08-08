import { describe, expect, it, vi } from "vitest";

import type { TUIState } from "#/tui/kimi-tui";
import {
  DISABLE_TERMINAL_FOCUS_REPORTING,
  ENABLE_TERMINAL_FOCUS_REPORTING,
  handleTerminalFocusInput,
  installTerminalFocusTracking,
  TERMINAL_FOCUS_IN,
  TERMINAL_FOCUS_OUT,
} from "#/tui/utils/terminal-focus";

describe("terminal focus tracking", () => {
  it("updates focus state from terminal focus reporting sequences", () => {
    const state = { focused: true };

    expect(handleTerminalFocusInput(state, TERMINAL_FOCUS_OUT)).toEqual({
      consume: true,
    });
    expect(state.focused).toBe(false);

    expect(handleTerminalFocusInput(state, TERMINAL_FOCUS_IN)).toEqual({
      consume: true,
    });
    expect(state.focused).toBe(true);

    expect(handleTerminalFocusInput(state, "x")).toBeUndefined();
  });

  it("consumes Ink-stripped focus reports and coalesced startup replies", () => {
    const state = { focused: true };

    expect(handleTerminalFocusInput(state, "[O")).toEqual({ consume: true });
    expect(state.focused).toBe(false);

    expect(handleTerminalFocusInput(state, "[I")).toEqual({ consume: true });
    expect(state.focused).toBe(true);

    expect(
      handleTerminalFocusInput(state, "[I]11;rgb:1414/1414/1414\u0007[?997;1n"),
    ).toEqual({ data: "]11;rgb:1414/1414/1414\u0007[?997;1n" });
    // Do not eat ordinary user text that merely starts with "[I".
    expect(handleTerminalFocusInput(state, "[Info]")).toBeUndefined();
  });

  it("enables focus reporting and removes the listener on dispose", () => {
    const listeners: Array<(data: string) => { consume: true } | undefined> =
      [];
    const removeInputListener = vi.fn();
    const state = {
      terminalState: {
        focused: false,
      },
      terminal: {
        write: vi.fn(),
      },
      ui: {
        addInputListener: vi.fn((listener) => {
          listeners.push(listener);
          return removeInputListener;
        }),
      },
    } as unknown as TUIState;

    const dispose = installTerminalFocusTracking(state);

    expect(state.terminalState.focused).toBe(true);
    expect(state.terminal.write).toHaveBeenCalledWith(
      ENABLE_TERMINAL_FOCUS_REPORTING,
    );
    expect(listeners).toHaveLength(1);

    listeners[0]?.(TERMINAL_FOCUS_OUT);
    expect(state.terminalState.focused).toBe(false);

    dispose();

    expect(removeInputListener).toHaveBeenCalledOnce();
    expect(state.terminal.write).toHaveBeenCalledWith(
      DISABLE_TERMINAL_FOCUS_REPORTING,
    );
    expect(state.terminalState.focused).toBe(true);
  });
});

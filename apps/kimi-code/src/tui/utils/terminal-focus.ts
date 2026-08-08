import {
  DISABLE_TERMINAL_FOCUS_REPORTING,
  ENABLE_TERMINAL_FOCUS_REPORTING,
  TERMINAL_FOCUS_IN,
  TERMINAL_FOCUS_IN_NO_ESC,
  TERMINAL_FOCUS_OUT,
  TERMINAL_FOCUS_OUT_NO_ESC,
} from "#/tui/constant/terminal";
import type { TUIState } from "#/tui/tui-state";
import type { TerminalState } from "#/tui/utils/terminal-state";

export {
  DISABLE_TERMINAL_FOCUS_REPORTING,
  ENABLE_TERMINAL_FOCUS_REPORTING,
  TERMINAL_FOCUS_IN,
  TERMINAL_FOCUS_OUT,
} from "#/tui/constant/terminal";

// Only strip focus CSI when it is a real reply (alone or coalesced with other
// capability replies). Lookahead avoids eating user text like `[Info]`.
const FOCUS_IN_REPLY_RE =
  /(?:\u001b)?\[I(?=\]11;|\[\?997;|\[\?996|\[6;|\[I|\[O|$)/g;
const FOCUS_OUT_REPLY_RE =
  /(?:\u001b)?\[O(?=\]11;|\[\?997;|\[\?996|\[6;|\[I|\[O|$)/g;

export function installTerminalFocusTracking(state: TUIState): () => void {
  state.terminalState.focused = true;
  const disposeInputListener = state.ui.addInputListener((data) =>
    handleTerminalFocusInput(state.terminalState, data),
  );
  state.terminal.write(ENABLE_TERMINAL_FOCUS_REPORTING);

  return () => {
    disposeInputListener();
    state.terminal.write(DISABLE_TERMINAL_FOCUS_REPORTING);
    state.terminalState.focused = true;
  };
}

export function handleTerminalFocusInput(
  state: Pick<TerminalState, "focused">,
  data: string,
): { consume: true } | { data: string } | undefined {
  if (data === TERMINAL_FOCUS_IN || data === TERMINAL_FOCUS_IN_NO_ESC) {
    state.focused = true;
    return { consume: true };
  }
  if (data === TERMINAL_FOCUS_OUT || data === TERMINAL_FOCUS_OUT_NO_ESC) {
    state.focused = false;
    return { consume: true };
  }

  let remaining = data;
  let changed = false;

  const withoutOut = remaining.replace(FOCUS_OUT_REPLY_RE, "");
  if (withoutOut !== remaining) {
    state.focused = false;
    remaining = withoutOut;
    changed = true;
  }
  const withoutIn = remaining.replace(FOCUS_IN_REPLY_RE, "");
  if (withoutIn !== remaining) {
    state.focused = true;
    remaining = withoutIn;
    changed = true;
  }

  if (!changed) return undefined;
  if (remaining.length === 0) return { consume: true };
  return { data: remaining };
}

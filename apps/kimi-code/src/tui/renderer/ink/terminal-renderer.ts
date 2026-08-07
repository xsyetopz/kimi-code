import { type Instance, type RenderOptions, render } from "ink";
import { createElement } from "react";

import { InkTerminalView, type InkTerminalViewProps } from "./terminal-view";
import type { TerminalViewState } from "../terminal-view-state";

export interface InkTerminalRenderer {
  update(view: TerminalViewState): void;
  unmount(): void;
  waitUntilExit(): ReturnType<Instance["waitUntilExit"]>;
}

export interface InkTerminalRendererOptions extends RenderOptions {
  /** Receives canonical kimi-tui input sequences from Ink's useInput hook. */
  readonly onInput?: (data: string) => void;
}

/**
 * Mount the Ink tree and expose the lifecycle operations needed by a host
 * coordinator. The host owns state and calls update after each state snapshot;
 * no session or kimi-tui object is captured by the renderer.
 */
export function mountInkTerminalRenderer(
  initialView: TerminalViewState,
  options?: InkTerminalRendererOptions,
): InkTerminalRenderer {
  let mounted = true;
  const { onInput, ...renderOptions } = options ?? {};
  const node = (view: TerminalViewState): ReturnType<typeof createElement> => {
    const props: InkTerminalViewProps =
      onInput === undefined ? { view } : { view, onInput };
    return createElement<InkTerminalViewProps>(InkTerminalView, props);
  };
  // KimiTUI handles Ctrl+C itself (including the double-Esc/exit policy), so
  // Ink must not terminate the process before dispatching that input.
  const instance = render(node(initialView), {
    ...renderOptions,
    exitOnCtrlC: false,
    interactive:
      renderOptions?.interactive ??
      (process.stdin.isTTY === true && process.stdout.isTTY === true),
  });
  return {
    update(view: TerminalViewState): void {
      if (!mounted) return;
      instance.rerender(node(view));
    },
    unmount(): void {
      if (!mounted) return;
      mounted = false;
      instance.unmount();
    },
    waitUntilExit(): ReturnType<Instance["waitUntilExit"]> {
      return instance.waitUntilExit();
    },
  };
}

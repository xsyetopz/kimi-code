import { render } from "ink";
import { createElement } from "react";
import { createInteractiveHost } from "../cli/host";
import type { ReplContext } from "../cli/repl";
import { App } from "./App";

/** Default interactive path: React+Ink over the shared InteractiveHost. */
export async function runInkTui(ctx: ReplContext): Promise<void> {
  const host = createInteractiveHost(ctx, { quiet: true });
  const instance = render(createElement(App, { host }));
  await instance.waitUntilExit();
  await host.dispose();
}

/**
 * `kimi web` — run the local Kimi API server (REST + WebSocket) in the
 * foreground. The server stays attached to the terminal and stops with Ctrl+C.
 * Management subcommand: `web rotate-token` (rotate the home-wide bearer
 * token). Servers left behind by pre-0.28.0 builds are cleaned up with
 * `kimi server kill`.
 */

import type { Command } from "commander";

import { registerDeprecatedServerCommand } from "./deprecated-server";
import { registerRotateTokenCommand } from "./rotate-token";
import { buildWebCommand } from "./run";

export function registerWebCommand(program: Command): void {
  const web = buildWebCommand(
    program
      .command("web")
      .description("Run the local Kimi API server (REST + WebSocket)."),
  );
  registerRotateTokenCommand(web);
  registerDeprecatedServerCommand(program);
}

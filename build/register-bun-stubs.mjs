import { registerHooks } from "node:module";

import { resolve } from "./bun-stubs-resolver.mjs";

/**
 * Registers the `bun:*` stub resolver. Pass to Node via `--import` alongside
 * tsx so source-executed code can import `bun:sqlite` outside the Bun runtime.
 */
registerHooks({ resolve });

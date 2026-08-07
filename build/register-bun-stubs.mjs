import { register } from "node:module";

/**
 * Registers the `bun:*` stub resolver. Pass to Node via `--import` alongside
 * tsx so source-executed code can import `bun:sqlite` outside the Bun runtime.
 */
register("./bun-stubs-resolver.mjs", import.meta.url);

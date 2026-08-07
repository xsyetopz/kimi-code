import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const STUB_ROOT = resolvePath(
  dirname(fileURLToPath(import.meta.url)),
  "../packages/agent-core-v2/test/stubs",
);
const BUN_SQLITE_STUB = pathToFileURL(
  resolvePath(STUB_ROOT, "bun-sqlite.ts"),
).href;

/**
 * Node ESM resolve hook: alias `bun:*` imports to in-repo stubs for source
 * execution under Node (tsx dev, vitest). Production Bun builds use the real
 * modules.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "bun:sqlite") {
    return {
      format: "module",
      shortCircuit: true,
      url: BUN_SQLITE_STUB,
    };
  }
  return nextResolve(specifier, context);
}

import { rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Hermetic experimental-flag state for tests: scrub ambient
 * `KIMI_CODE_EXPERIMENTAL_*` env vars inherited from the developer shell
 * (e.g. a globally exported `KIMI_CODE_EXPERIMENTAL_FLAG=1`) so flag-driven
 * behavior — including tool schemas embedded in `llm.tools_snapshot`
 * snapshots — stays deterministic and matches CI. Tests opt into flags
 * explicitly via service overrides or `vi.stubEnv`.
 */
for (const key of Object.keys(process.env)) {
  if (key.startsWith("KIMI_CODE_EXPERIMENTAL_")) {
    delete process.env[key];
  }
}

// Strip leftover project-local config from interrupted runs so parallel suites
// do not read corrupt `.kimi-code/local.toml` at the package root.
rmSync(join(process.cwd(), ".kimi-code"), { recursive: true, force: true });

import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "bun:sqlite": path.join(
        packageRoot,
        "../agent-core-v2/test/stubs/bun-sqlite.ts",
      ),
      "@moonshot-ai/kimi-code-oauth": fileURLToPath(
        new URL("../oauth/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    name: "kimi-sdk",
    env: {
      KIMI_LOG_LEVEL: "off",
    },
    include: ["test/**/*.test.ts"],
  },
});

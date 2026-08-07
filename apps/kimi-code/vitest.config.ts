import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

const appRoot = import.meta.dirname;
const agentCoreRoot = resolve(appRoot, "../../packages/agent-core-v2");

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(appRoot, "src"),
      "bun:sqlite": resolve(agentCoreRoot, "test/stubs/bun-sqlite.ts"),
    },
  },
  test: {
    name: "cli",
    env: {
      KIMI_LOG_LEVEL: "off",
    },
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
  },
});

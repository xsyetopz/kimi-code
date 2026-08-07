import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "bun:sqlite": path.join(packageRoot, "test/stubs/bun-sqlite.ts"),
    },
  },
  test: {
    name: "agent-core-v2",
    include: ["test/**/*.{test,e2e,integration}.ts"],
    setupFiles: ["test/setup.ts"],
  },
});

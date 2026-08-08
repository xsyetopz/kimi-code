import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/ir",
      "packages/discover",
      "packages/model",
      "packages/adapters",
      "packages/session",
      "packages/exec",
      "packages/agent",
      "packages/ext",
      "packages/auth",
      "packages/tui",
      "apps/kimi-next",
    ],
  },
});

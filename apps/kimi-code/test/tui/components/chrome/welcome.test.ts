import { visibleWidth } from "@moonshot-ai/kimi-tui";
import { describe, expect, it } from "vitest";

import { WelcomeComponent } from "#/tui/components/chrome/welcome";
import type { AppState } from "#/tui/types";

const appState: AppState = {
  version: "1.2.3",
  workDir: "/tmp/project",
  additionalDirs: [],
  sessionId: "ses-1",
  sessionTitle: null,
  model: "kimi-k2",
  permissionMode: "manual",
  thinkingEffort: "off",
  contextUsage: 0,
  contextTokens: 0,
  maxContextTokens: 0,
  isCompacting: false,
  isReplaying: false,
  streamingPhase: "idle",
  streamingStartTime: 0,
  planMode: false,
  inputMode: "prompt",
  swarmMode: false,
  theme: "dark",
  editorCommand: null,
  notifications: { enabled: true, condition: "unfocused" },
  upgrade: { autoInstall: true },
  availableModels: {},
  availableProviders: {},
  mcpServersSummary: null,
};

describe("WelcomeComponent", () => {
  it("keeps every line within the requested width on narrow terminals", () => {
    for (const width of [0, 1, 2, 4, 10, 39, 80]) {
      for (const line of new WelcomeComponent(appState).render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});

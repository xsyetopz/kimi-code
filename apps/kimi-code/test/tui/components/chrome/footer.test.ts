import chalk from "chalk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FooterComponent } from "#/tui/components/chrome/footer";
import { currentTheme, darkColors, lightColors } from "#/tui/theme";
import type { ModelAlias } from "@moonshot-ai/kimi-code-sdk";
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

describe("FooterComponent", () => {
  const previousChalkLevel = chalk.level;

  beforeEach(() => {
    chalk.level = 3;
  });

  afterEach(() => {
    chalk.level = previousChalkLevel;
  });

  it("repaints from the active palette on the next render (no setColors needed)", () => {
    const footer = new FooterComponent(appState);
    const before = footer.render(120).join("\n");

    currentTheme.setPalette(lightColors);
    try {
      const after = footer.render(120).join("\n");
      // Reads currentTheme live, so a palette swap changes the emitted colours.
      expect(after).not.toBe(before);
    } finally {
      currentTheme.setPalette(darkColors);
    }
  });

  it("shows the effort for an effort-capable model", () => {
    const effortModel: ModelAlias = {
      provider: "managed:kimi-code",
      model: "kimi-k2",
      maxContextSize: 262144,
      supportEfforts: ["low", "high", "max"],
      defaultEffort: "high",
    };
    const state: AppState = {
      ...appState,
      thinkingEffort: "max",
      availableModels: { "kimi-k2": effortModel },
    };
    const footer = new FooterComponent(state);

    expect(footer.render(120).join("\n")).toContain("thinking: max");
  });

  it("does not show the effort for a legacy boolean model", () => {
    const plainModel: ModelAlias = {
      provider: "managed:kimi-code",
      model: "kimi-k2",
      maxContextSize: 262144,
      capabilities: ["thinking"],
    };
    const state: AppState = {
      ...appState,
      thinkingEffort: "high",
      availableModels: { "kimi-k2": plainModel },
    };
    const footer = new FooterComponent(state);
    const rendered = footer.render(120).join("\n");

    expect(rendered).toContain("thinking");
    expect(rendered).not.toContain("thinking:high");
  });
});

describe("FooterComponent overrides", () => {
  it("shows the overridden effort list", () => {
    const effortModelWithOverride: ModelAlias = {
      provider: "managed:kimi-code",
      model: "kimi-k2",
      maxContextSize: 262144,
      supportEfforts: ["low", "high", "max"],
      defaultEffort: "max",
      overrides: { supportEfforts: ["low", "high"], defaultEffort: "high" },
    };
    const state: AppState = {
      ...appState,
      thinkingEffort: "high",
      availableModels: { "kimi-k2": effortModelWithOverride },
    };
    const footer = new FooterComponent(state);

    expect(footer.render(120).join("\n")).toContain("thinking: high");
  });
});

describe("FooterComponent displayName override", () => {
  it("renders the overridden display name", () => {
    const state: AppState = {
      ...appState,
      model: "kimi-k2",
      availableModels: {
        "kimi-k2": {
          provider: "managed:kimi-code",
          model: "kimi-k2",
          maxContextSize: 262144,
          displayName: "Remote Name",
          overrides: { displayName: "Custom Name" },
        },
      },
    };
    const footer = new FooterComponent(state);

    expect(footer.render(120).join("\n")).toContain("Custom Name");
    expect(footer.render(120).join("\n")).not.toContain("Remote Name");
  });
});

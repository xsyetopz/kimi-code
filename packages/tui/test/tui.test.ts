import { describe, expect, it } from "vitest";
import { DEFAULT_TOGGLES, renderFooter, renderToolCall } from "../src/index";

describe("tui projections", () => {
  it("renders footer with usage", () => {
    const text = renderFooter(
      {
        modelId: "openai/gpt-4.1-mini",
        permissionMode: "manual",
        inputTokens: 10,
        outputTokens: 2,
        cachedInputTokens: 1,
      },
      DEFAULT_TOGGLES,
    );
    expect(text).toContain("model=openai/gpt-4.1-mini");
    expect(text).toContain("cached=1");
  });

  it("renders tool call label", () => {
    expect(renderToolCall({ name: "glob" })).toBe("[tool] glob");
  });
});

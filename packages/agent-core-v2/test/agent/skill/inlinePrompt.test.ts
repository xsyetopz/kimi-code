import { describe, expect, it } from "vitest";

import {
  parseInlineSkillInvocations,
  stripInlineSkillTokens,
} from "#/agent/skill/inlinePrompt";

describe("inlinePrompt", () => {
  it("parses inline /skill:<name> tokens", () => {
    expect(
      parseInlineSkillInvocations(
        "writing here /skill:alpha and /skill:beta later",
      ).map((invocation) => invocation.name),
    ).toEqual(["alpha", "beta"]);
  });

  it("strips inline skill tokens from prompt text", () => {
    expect(
      stripInlineSkillTokens(
        "writing here /skill:alpha and /skill:beta later",
      ),
    ).toBe("writing here and later");
  });
});

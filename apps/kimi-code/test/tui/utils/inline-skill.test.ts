import { describe, expect, it } from "vitest";

import {
  buildDedupedSkillPickerEntries,
  extractInlineSkillPrefix,
  parseInlineSkillInvocations,
} from "#/tui/utils/inline-skill";

describe("inline-skill utils", () => {
  const skillCommandMap = new Map<string, string>([
    ["skill:alpha", "alpha"],
    ["skill:beta", "beta"],
  ]);

  it("extractInlineSkillPrefix finds /skill: at token boundaries", () => {
    expect(
      extractInlineSkillPrefix("writing here /skill:al"),
    ).toBe("/skill:al");
    expect(extractInlineSkillPrefix("/skill:alpha")).toBe("/skill:alpha");
    expect(extractInlineSkillPrefix("email@example.com")).toBeNull();
  });

  it("parseInlineSkillInvocations collects multiple inline skills", () => {
    const parsed = parseInlineSkillInvocations(
      "writing here /skill:alpha and /skill:beta later",
      skillCommandMap,
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.invocations.map((inv) => inv.skillName)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(parsed!.strippedText).toBe("writing here and later");
  });

  it("buildDedupedSkillPickerEntries hides duplicate skill names", () => {
    const entries = buildDedupedSkillPickerEntries([
      {
        name: "alpha",
        description: "First",
        path: "/tmp/alpha",
        source: "project",
      },
      {
        name: "alpha",
        description: "Duplicate",
        path: "/other/alpha",
        source: "user",
      },
      {
        name: "beta",
        description: "Beta",
        path: "/tmp/beta",
        source: "user",
      },
      {
        name: "write-goal",
        description: "Builtin",
        path: "/builtin/write-goal",
        source: "builtin",
      },
    ]);
    expect(entries.map((entry) => entry.skillName)).toEqual(["alpha", "beta"]);
    expect(entries.every((entry) => entry.label.startsWith("/skill:"))).toBe(
      true,
    );
  });
});

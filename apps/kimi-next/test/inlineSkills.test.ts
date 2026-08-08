import { describe, expect, it } from "vitest";
import {
  activateInlineSkills,
  extractInlineSkillCalls,
  type SkillMeta,
} from "../src/cli/skills";

const skills: SkillMeta[] = [
  {
    name: "review",
    description: "Review code",
    body: "Review carefully.",
    dir: "/tmp/review",
    skillPath: "/tmp/review/SKILL.md",
    sourceRoot: "/tmp",
  },
  {
    name: "ship-it",
    description: "Ship changes",
    body: "Run the checks.",
    dir: "/tmp/ship-it",
    skillPath: "/tmp/ship-it/SKILL.md",
    sourceRoot: "/tmp",
  },
  {
    name: "review.security",
    description: "Security review",
    body: "Check auth.",
    dir: "/tmp/review/security",
    skillPath: "/tmp/review/security/SKILL.md",
    sourceRoot: "/tmp",
    parent: "review",
  },
];

describe("inline skill calls", () => {
  it("extracts known skills anywhere and deduplicates them", () => {
    const result = extractInlineSkillCalls(
      "Please /review this, then /ship-it; repeat /review.",
      skills,
    );

    expect(result.cleanText).toBe("Please this, then; repeat.");
    expect(result.skillNames).toEqual(["review", "ship-it"]);
  });

  it("extracts hierarchical skill names", () => {
    const result = extractInlineSkillCalls("Run /review.security now.", skills);
    expect(result.skillNames).toEqual(["review.security"]);
    expect(result.cleanText).toBe("Run now.");
  });

  it("preserves unknown skills and whole-line REPL commands", () => {
    expect(extractInlineSkillCalls("/help", skills)).toEqual({
      cleanText: "/help",
      skillNames: [],
    });
    expect(extractInlineSkillCalls("Try /unknown here.", skills)).toEqual({
      cleanText: "Try /unknown here.",
      skillNames: [],
    });
  });

  it("activates bodies in request order", async () => {
    await expect(
      activateInlineSkills(["ship-it", "review"], skills),
    ).resolves.toBe(
      "[Inline skill: ship-it]\nRun the checks.\n\n[Inline skill: review]\nReview carefully.",
    );
  });
});

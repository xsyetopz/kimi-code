import { describe, expect, it } from "vitest";
import { shouldAutoCompact } from "../src/cli/auto-compact";

describe("auto compact threshold", () => {
  it("triggers when derived conversation exceeds the configured budget", () => {
    const conversation = [
      {
        kind: "user" as const,
        id: "u1",
        content: [{ type: "text" as const, text: "a".repeat(100) }],
      },
    ];
    expect(shouldAutoCompact(conversation, { threshold: 10 })).toBe(true);
    expect(shouldAutoCompact(conversation, { threshold: 10_000 })).toBe(false);
  });
});

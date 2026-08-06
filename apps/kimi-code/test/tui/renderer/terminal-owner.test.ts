import { describe, expect, it } from "vitest";

import { TerminalOwnership } from "#/tui/renderer/terminal-owner";

describe("TerminalOwnership", () => {
  it("starts unowned and permits an idempotent claim", () => {
    const ownership = new TerminalOwnership();

    expect(ownership.current).toBe("none");
    ownership.claim("ink");
    ownership.claim("ink");
    expect(ownership.current).toBe("ink");
  });

  it("rejects competing owners until the current owner is released", () => {
    const ownership = new TerminalOwnership();
    ownership.claim("kimi-tui");

    expect(() => ownership.claim("ink")).toThrow("kimi-tui still owns it");
    ownership.release("ink");
    expect(ownership.current).toBe("kimi-tui");
    ownership.release("kimi-tui");
    ownership.claim("ink");
    expect(ownership.current).toBe("ink");
  });
});

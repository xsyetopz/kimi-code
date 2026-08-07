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

  it("requires release before a new owner can claim the terminal", () => {
    const ownership = new TerminalOwnership();
    ownership.claim("ink");

    expect(() => ownership.claim("ink")).not.toThrow();
    ownership.release("ink");
    expect(ownership.current).toBe("none");
    ownership.claim("ink");
    expect(ownership.current).toBe("ink");
  });
});

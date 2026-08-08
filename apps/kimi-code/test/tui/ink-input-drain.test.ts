import { describe, expect, it, vi } from "vitest";

import { ESC } from "#/constant/terminal";
import { drainInkTerminalInput } from "#/tui/utils/ink-input-drain";

describe("drainInkTerminalInput", () => {
  it("consumes capability replies via filterInput and returns null", () => {
    const filterInput = vi.fn(() => ({ consume: true as const }));
    expect(drainInkTerminalInput("[I", { filterInput })).toBeNull();
    expect(filterInput).toHaveBeenCalledWith("[I");
  });

  it("re-prefixes a stripped ESC for listeners that require it", () => {
    const filterInput = vi.fn((data: string) => {
      if (data === `${ESC}[?997;1n`) return { consume: true as const };
      return { data };
    });
    expect(drainInkTerminalInput("[?997;1n", { filterInput })).toBeNull();
    expect(filterInput).toHaveBeenCalledWith("[?997;1n");
    expect(filterInput).toHaveBeenCalledWith(`${ESC}[?997;1n`);
  });

  it("forwards ordinary key bytes to the editor", () => {
    const filterInput = vi.fn((data: string) => ({ data }));
    expect(drainInkTerminalInput("hello", { filterInput })).toBe("hello");
    expect(filterInput).toHaveBeenCalledOnce();
  });
});

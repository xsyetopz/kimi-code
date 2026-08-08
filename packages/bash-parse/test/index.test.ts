import { describe, expect, it } from "vitest";
import { parseBash } from "../src/index";

describe("parseBash", () => {
  it("finds command heads across operators outside quotes", () => {
    expect(parseBash(`echo "a|b" | cat && printf 'x;y'; pwd`)).toEqual({
      ok: true,
      hasError: false,
      commands: ["echo", "cat", "printf", "pwd"],
    });
  });

  it("reports unterminated quoting without making a safety decision", () => {
    expect(parseBash(`echo "unfinished`)).toEqual({
      ok: true,
      hasError: true,
      commands: ["echo"],
    });
  });
});

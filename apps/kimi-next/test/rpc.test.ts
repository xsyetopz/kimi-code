import { describe, expect, it } from "vitest";
import { parseRpcCommand } from "../src/cli/rpc";

describe("RPC commands", () => {
  it("parses prompt, compact, and exit commands", () => {
    expect(parseRpcCommand('{"op":"prompt","text":"hello"}')).toEqual({
      op: "prompt",
      text: "hello",
    });
    expect(parseRpcCommand('{"op":"compact"}')).toEqual({ op: "compact" });
    expect(parseRpcCommand('{"op":"exit"}')).toEqual({ op: "exit" });
  });

  it("rejects malformed commands", () => {
    expect(() => parseRpcCommand("not json")).toThrow();
    expect(() => parseRpcCommand('{"op":"prompt"}')).toThrow();
  });
});

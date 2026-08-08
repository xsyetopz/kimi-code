import { describe, expect, it } from "vitest";
import { parseArgs, helpText } from "../src/cli/args";

describe("cli args", () => {
  it("parses print mode and model", () => {
    const args = parseArgs(["--print", "--model", "anthropic/claude-sonnet-4-20250514", "hi"]);
    expect(args.print).toBe(true);
    expect(args.model).toBe("anthropic/claude-sonnet-4-20250514");
    expect(args.prompt).toBe("hi");
  });

  it("parses compact model", () => {
    const args = parseArgs(["--compact-model", "openai/gpt-4.1-nano"]);
    expect(args.compactModel).toBe("openai/gpt-4.1-nano");
  });

  it("parses --repl escape hatch", () => {
    const args = parseArgs(["--repl"]);
    expect(args.repl).toBe(true);
  });

  it("help text mentions kimi-next", () => {
    expect(helpText()).toContain("kimi-next");
    expect(helpText()).toContain("--repl");
  });
});

import { describe, expect, it } from "vitest";
import { parseArgs, helpText } from "../src/cli/args";
import { formatReceipt } from "../src/cli/receipt";
import { promptTextForTest } from "../src/cli/acp-text";

describe("cli args plan mode", () => {
  it("parses --plan", () => {
    expect(parseArgs(["--plan"]).plan).toBe(true);
  });

  it("help mentions plan mode", () => {
    expect(helpText()).toContain("--plan");
    expect(helpText()).toContain("/implement");
  });
});

describe("harness receipt", () => {
  it("formats receipt lines", () => {
    expect(
      formatReceipt({
        skillIndexCount: 2,
        activatedSkills: ["review"],
        mcpCatalogCount: 3,
        mcpFullSchemaCount: 3,
        toolsExposed: 0,
        planMode: true,
        permissionMode: "manual",
        instructionKind: "AGENTS.md",
      }),
    ).toContain("plan=on");
  });
});

describe("acp prompt text", () => {
  it("joins text content blocks", () => {
    expect(
      promptTextForTest([
        { type: "text", text: "hello" },
        { type: "text", text: " world" },
      ]),
    ).toBe("hello world");
  });
});

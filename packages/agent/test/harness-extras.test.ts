import { describe, expect, it, vi } from "vitest";
import {
  createPrivilegePermissionGate,
  privilegeAllows,
  privilegeForTool,
} from "../src/privilege";
import {
  classifyTask,
  modelForTask,
  parseRouteTable,
} from "../src/route";
import {
  formatReviewPanel,
  parseReviewModels,
  runReviewPanel,
} from "../src/review";
import { createManualPermissionGate } from "../src/permission";

describe("privilege tiers", () => {
  it("classifies tools and auto-allows within maxAuto", async () => {
    expect(privilegeForTool("read")).toBe("read");
    expect(privilegeForTool("write")).toBe("write");
    expect(privilegeForTool("bash")).toBe("exec");
    expect(privilegeForTool("mcp:fs:list")).toBe("mcp");
    expect(privilegeAllows("read", "glob")).toBe(true);
    expect(privilegeAllows("read", "write")).toBe(false);

    const asked: string[] = [];
    const gate = createPrivilegePermissionGate(
      createManualPermissionGate(async (request) => {
        asked.push(request.toolName);
        return "deny";
      }),
      "read",
    );
    await expect(
      gate.ask({ toolName: "read", arguments: "{}", mode: "manual" }),
    ).resolves.toBe("allow");
    await expect(
      gate.ask({ toolName: "write", arguments: "{}", mode: "manual" }),
    ).resolves.toBe("deny");
    expect(asked).toEqual(["write"]);
  });
});

describe("model routing", () => {
  it("classifies tasks and maps to route table", () => {
    expect(classifyTask("/usage")).toBe("cheap");
    expect(classifyTask("please review this")).toBe("review");
    expect(classifyTask("fix the bug")).toBe("implement");
    expect(classifyTask("anything", { planMode: true })).toBe("plan");
    expect(modelForTask("cheap")).toContain("mini");
    expect(parseRouteTable("review=openai/gpt-4.1").review).toBe(
      "openai/gpt-4.1",
    );
  });
});

describe("review panel", () => {
  it("aggregates concurrent OpenRouter-style opinions", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      return {
        ok: true,
        async json() {
          return {
            choices: [
              { message: { content: `opinion:${body.model}` } },
            ],
          };
        },
      } as Response;
    });
    const opinions = await runReviewPanel({
      models: ["openai/gpt-4.1-mini", "anthropic/claude-sonnet-4"],
      messages: [{ role: "user", content: "review this" }],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(opinions.map((opinion) => opinion.text)).toEqual([
      "opinion:openai/gpt-4.1-mini",
      "opinion:anthropic/claude-sonnet-4",
    ]);
    expect(formatReviewPanel(opinions)).toContain("## openai/gpt-4.1-mini");
    expect(parseReviewModels("a, b")).toEqual(["a", "b"]);
  });
});

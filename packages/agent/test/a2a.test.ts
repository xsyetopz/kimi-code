import { describe, expect, it } from "vitest";
import { createA2aPeerRunner } from "../src/a2a";

describe("a2a peer runner", () => {
  it("routes prompts through injectable A2A clients", async () => {
    const urls: string[] = [];
    const run = createA2aPeerRunner(
      [{ id: "worker-a", url: "https://example.test/a" }],
      {
        createClient: async (url) => {
          urls.push(url);
          return {
            async sendMessage() {
              return {
                parts: [{ content: { $case: "text", value: "peer-ok" } }],
              };
            },
          };
        },
      },
    );
    await expect(run("hello")).resolves.toEqual([
      { id: "worker-a", text: "peer-ok" },
    ]);
    expect(urls).toEqual(["https://example.test/a"]);
  });
});

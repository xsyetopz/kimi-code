import { describe, expect, it } from "vitest";
import { formatSwarmVisibility, runSwarmBatch } from "../src/swarm";
import { resolveModel } from "@kimi-next/model";

describe("swarm visibility", () => {
  it("formats worker model and effort", () => {
    const profile = resolveModel("openai/gpt-4.1-mini");
    const text = formatSwarmVisibility({
      workers: [
        { id: "w1", modelId: profile.id, effort: "medium", profile },
      ],
    });
    expect(text).toContain("openai/gpt-4.1-mini");
    expect(text).toContain("effort=medium");
  });

  it("runs workers in parallel and isolates failures", async () => {
    const profile = resolveModel("openai/gpt-4.1-mini");
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: string[] = [];
    const batch = runSwarmBatch({
      prompt: "investigate",
      workers: [
        { id: "w1", modelId: profile.id, profile },
        { id: "w2", modelId: profile.id, effort: "high", profile },
      ],
      runWorker: async (worker) => {
        started.push(worker.id);
        await gate;
        if (worker.id === "w2") {
          throw new Error("worker failed");
        }
        return "worker one result";
      },
    });

    await Promise.resolve();
    expect(started).toEqual(["w1", "w2"]);
    release?.();
    const results = await batch;

    expect(results).toEqual([
      { id: "w1", modelId: profile.id, text: "worker one result" },
      {
        id: "w2",
        modelId: profile.id,
        effort: "high",
        text: "",
        error: "worker failed",
      },
    ]);
  });
});

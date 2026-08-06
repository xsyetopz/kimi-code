import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CLIOptions } from "../../src/cli/options";
import { runPrompt } from "../../src/cli/run-prompt";

const mocks = vi.hoisted(() => ({
  runV2Print: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../src/cli/v2/run-v2-print", () => ({
  runV2Print: mocks.runV2Print,
}));

function opts(overrides: Partial<CLIOptions> = {}): CLIOptions {
  return {
    session: undefined,
    continue: false,
    yolo: false,
    auto: false,
    plan: false,
    model: undefined,
    outputFormat: undefined,
    prompt: "say hello",
    skillsDirs: [],
    agent: undefined,
    agentFiles: [],
    addDirs: [],
    ...overrides,
  };
}

function writer(): { readonly write: (chunk: string) => boolean } {
  return { write: vi.fn((_chunk: string) => true) };
}

describe("runPrompt", () => {
  beforeEach(() => {
    mocks.runV2Print.mockClear();
    mocks.runV2Print.mockResolvedValue(undefined);
  });

  it("dispatches prompt execution to the native print runner", async () => {
    const options = opts({ outputFormat: "stream-json" });
    const io = { stdout: writer(), stderr: writer() };

    await runPrompt(options, "1.2.3-test", io);

    expect(mocks.runV2Print).toHaveBeenCalledTimes(1);
    expect(mocks.runV2Print).toHaveBeenCalledWith(options, "1.2.3-test", io);
  });

  it("propagates failures from the native print runner", async () => {
    const failure = new Error("native print failed");
    mocks.runV2Print.mockRejectedValueOnce(failure);

    await expect(runPrompt(opts(), "1.2.3-test")).rejects.toBe(failure);
  });
});

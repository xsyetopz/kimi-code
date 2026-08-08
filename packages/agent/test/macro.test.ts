import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ToolCall } from "@kimi-next/ir";
import { writeFile } from "@kimi-next/exec";
import {
  createBuiltinToolExecutor,
  executeMacroSteps,
  formatMacroReport,
  parseMacroSteps,
} from "../src/index";

describe("macro", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kimi-next-macro-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("parses steps from JSON args", () => {
    const steps = parseMacroSteps([
      { op: "read", path: "a.ts" },
      { op: "write", path: "b.ts", content: "x" },
    ]);
    expect(steps).toHaveLength(2);
    expect(steps[0]?.op).toBe("read");
    expect(steps[1]?.path).toBe("b.ts");
  });

  it("runs read-only ops in parallel and mutating ops sequentially", async () => {
    const target = join(dir, "macro.txt");
    await writeFile(target, "before");

    const results = await executeMacroSteps(
      [
        { op: "read", path: target },
        { op: "glob", path: dir },
        { op: "write", path: target, content: "after" },
        { op: "read", path: target },
      ],
      dir,
    );

    expect(results).toHaveLength(4);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results[0]?.output).toBe("before");
    expect(results[2]?.output).toBe("ok");
    expect(results[3]?.output).toBe("after");
    expect(formatMacroReport(results)).toContain("read (ok)");
  });

  it("executes command_run via builtin tool executor", async () => {
    const target = join(dir, "tool.txt");
    const executor = createBuiltinToolExecutor(dir);
    const call: ToolCall = {
      id: "call-1",
      name: "command_run",
      arguments: JSON.stringify({
        steps: [
          { op: "write", path: target, content: "via macro" },
          { op: "read", path: target },
        ],
      }),
    };
    const result = await executor.execute(call, () => "res-1");
    expect(result.isError).toBe(false);
    expect(result.content).toContain("via macro");
  });
});

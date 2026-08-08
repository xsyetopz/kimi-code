import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readFile, runCommand, writeFile } from "../src/index";

describe("exec fs", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kimi-next-exec-"));
    filePath = join(dir, "sample.txt");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes and reads a temp file", async () => {
    await writeFile(filePath, "hello exec");
    const content = await readFile(filePath);
    expect(content).toBe("hello exec");
  });
});

describe("exec process", () => {
  it("runs echo hello", async () => {
    const result = await runCommand("echo", ["hello"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.stderr).toBe("");
  });
});

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expandMentions } from "../src/cli/mentions";

describe("expandMentions", () => {
  it("attaches files and directory listings", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kimi-next-mentions-"));
    await writeFile(join(cwd, "note.md"), "hello from file");
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src", "main.ts"), "export {}");

    const result = await expandMentions(
      "Please inspect @note.md and @src/.",
      cwd,
    );

    expect(result.text).toContain("Please inspect @note.md and @src/.");
    expect(result.text).toContain("[Attached file: note.md]");
    expect(result.text).toContain("hello from file");
    expect(result.text).toContain("[Attached dir: src]");
    expect(result.text).toContain("main.ts");
    expect(result.attachments).toHaveLength(2);
  });

  it("leaves unknown paths unchanged", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kimi-next-mentions-"));
    const result = await expandMentions("Look at @missing.txt, please.", cwd);
    expect(result.text).toBe("Look at @missing.txt, please.");
    expect(result.attachments).toEqual([]);
  });
});

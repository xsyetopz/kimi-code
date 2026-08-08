import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ensureProjectTrust, isProjectTrusted } from "../src/cli/trust";

describe("project trust", () => {
  it("gates project trust on the marker file", async () => {
    const cwd = join(tmpdir(), `kimi-next-trust-${Date.now()}`);
    await mkdir(cwd, { recursive: true });
    try {
      expect(await isProjectTrusted(cwd)).toBe(false);
      expect(await ensureProjectTrust(cwd, false)).toBe(false);
      await mkdir(join(cwd, ".kimi-next"), { recursive: true });
      await writeFile(join(cwd, ".kimi-next", "trust"), "trusted\n");
      expect(await isProjectTrusted(cwd)).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

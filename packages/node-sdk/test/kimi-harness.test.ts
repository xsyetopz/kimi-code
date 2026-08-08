import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createKimiHarnessV2,
  ImageLimits,
  KimiHarness,
  SDKRpcClientBase,
} from "#/index";

import { removeTempDirs } from "./session-runtime-helpers";
import { TEST_IDENTITY } from "./test-identity";

const tempDirs: string[] = [];

afterEach(async () => {
  await removeTempDirs(tempDirs);
});

/**
 * The recursive RPC surface KimiHarness touches for the tests below: kept
 * minimal like the StubRpc in create-session-transport.test.ts.
 */
class StubRpc extends SDKRpcClientBase {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected async getRpc(): Promise<any> {
    throw new Error("no core calls expected");
  }
}

describe("KimiHarness imageLimits", () => {
  it("exposes the in-process core [image] limits loaded from config.toml", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "kimi-sdk-harness-"));
    tempDirs.push(homeDir);
    await writeFile(
      join(homeDir, "config.toml"),
      `
[image]
max_edge_px = 1200
read_byte_budget = 65536
`,
      "utf-8",
    );

    const harness = createKimiHarnessV2({ identity: TEST_IDENTITY, homeDir });
    try {
      // The core was constructed in-process; its owner-scoped [image] limits
      // must be readable on the harness for prompt-ingestion paths.
      expect(harness.imageLimits).toBeInstanceOf(ImageLimits);
      expect(harness.imageLimits?.maxEdgePx()).toBe(1200);
      expect(harness.imageLimits?.readByteBudget()).toBe(65536);
    } finally {
      await harness.close();
    }
  });

  it("falls back to built-in defaults when no [image] section is configured", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "kimi-sdk-harness-"));
    tempDirs.push(homeDir);

    const harness = createKimiHarnessV2({ identity: TEST_IDENTITY, homeDir });
    try {
      expect(harness.imageLimits).toBeInstanceOf(ImageLimits);
      expect(harness.imageLimits?.maxEdgePx()).toBe(2000);
      expect(harness.imageLimits?.readByteBudget()).toBe(256 * 1024);
    } finally {
      await harness.close();
    }
  });

  it("a hand-built harness returns the injected ImageLimits as-is", () => {
    const limits = new ImageLimits(process.env, { maxEdgePx: 900 });
    const harness = new KimiHarness(new StubRpc(), {
      homeDir: "/tmp/home",
      configPath: "/tmp/config.toml",
      auth: { status: async () => ({ providers: [] }) } as never,
      engineAuth: {
        status: async () => ({ loggedIn: false }),
        summarize: async () => [],
        startLogin: async () => ({
          flow_id: "flow",
          provider: "opencode",
          status: "authenticated" as const,
        }),
        flow: async () => undefined,
        cancelLogin: async () => ({
          cancelled: false,
          status: "cancelled" as const,
        }),
        logout: async () => ({
          logged_out: true as const,
          provider: "opencode",
        }),
      },
      ensureConfigFile: async () => undefined,
      onClose: () => undefined,
      imageLimits: limits,
    });

    expect(harness.imageLimits).toBe(limits);
    expect(harness.imageLimits?.maxEdgePx()).toBe(900);
  });
});

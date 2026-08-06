import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OAuthManager } from "../src/oauth-manager";
import type { TokenStorage } from "../src/storage";
import type { OAuthFlowConfig, TokenInfo } from "../src/types";

class InMemoryStorage implements TokenStorage {
  public token: TokenInfo | undefined;

  async load(): Promise<TokenInfo | undefined> {
    return this.token;
  }

  async save(_name: string, token: TokenInfo): Promise<void> {
    this.token = token;
  }

  async remove(): Promise<void> {
    this.token = undefined;
  }

  async list(): Promise<string[]> {
    return this.token === undefined ? [] : ["kimi-code"];
  }
}

const config: OAuthFlowConfig = {
  name: "kimi-code",
  oauthHost: "https://unused.test",
  clientId: "test-client-id",
};

function makeToken(): TokenInfo {
  return {
    accessToken: "at-old",
    refreshToken: "rt-old",
    expiresAt: 999_999_000,
    scope: "",
    tokenType: "Bearer",
    expiresIn: 3600,
  };
}

describe("OAuthManager lock path sanitization", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(
      process.cwd(),
      ".tmp",
      `oauth-lock-sanitize-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
  });

  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(dir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")(
    "removes a regular file occupying the lock directory path before acquiring",
    async () => {
      const storage = new InMemoryStorage();
      storage.token = makeToken();
      const now = 1_000_000_000;

      const oauthDir = join(dir, "oauth");
      await mkdir(oauthDir, { recursive: true });
      await writeFile(join(oauthDir, "kimi-code"), "", { flag: "wx" });
      await writeFile(join(oauthDir, "kimi-code.lock"), "", { flag: "wx" });

      const manager = new OAuthManager({
        config,
        storage,
        configDir: dir,
        now: () => now,
        refreshTokenImpl: async () => ({
          accessToken: "at-new",
          refreshToken: "rt-new",
          expiresAt: now + 3_600_000,
          scope: "",
          tokenType: "Bearer",
          expiresIn: 3600,
        }),
      });

      const accessToken = await manager.ensureFresh();
      expect(accessToken).toBe("at-new");
    },
  );
});

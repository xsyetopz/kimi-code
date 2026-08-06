import { describe, expect, it, vi } from "vitest";

import type { TokenInfo, TokenStorage } from "@moonshot-ai/kimi-code-oauth";

import { OpenCodeAuthAdapter } from "#/app/auth/opencodeAuthAdapter";

class MemoryTokenStorage implements TokenStorage {
  token: TokenInfo | undefined;

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
    return this.token === undefined ? [] : ["opencode"];
  }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("OpenCodeAuthAdapter", () => {
  it("uses the official device response URL for both Kimi device-flow URL fields", async () => {
    const storage = new MemoryTokenStorage();
    const sleep = vi.fn(() => new Promise<void>(() => {}));
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        device_code: "device-code",
        user_code: "ABCD-EFGH",
        verification_uri_complete:
          "https://console.opencode.ai/auth/device?code=ABCD-EFGH",
        expires_in: 900,
        interval: 5,
      }),
    );
    const adapter = new OpenCodeAuthAdapter({
      storage,
      fetch: fetch as unknown as typeof globalThis.fetch,
      sleep,
    });

    const result = await adapter.startLogin("opencode");

    expect(fetch).toHaveBeenCalledWith(
      "https://console.opencode.ai/auth/device/code",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ client_id: "opencode-cli" }),
      }),
    );
    expect(result).toMatchObject({
      provider: "opencode",
      status: "pending",
      verification_uri:
        "https://console.opencode.ai/auth/device?code=ABCD-EFGH",
      verification_uri_complete:
        "https://console.opencode.ai/auth/device?code=ABCD-EFGH",
      user_code: "ABCD-EFGH",
    });
    expect(sleep).toHaveBeenCalledWith(5000, expect.any(AbortSignal));
  });

  it("persists device tokens and supplies a bearer token after official polling succeeds", async () => {
    const storage = new MemoryTokenStorage();
    let releaseSleep: (() => void) | undefined;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          device_code: "device-code",
          user_code: "ABCD-EFGH",
          verification_uri_complete:
            "https://console.opencode.ai/auth/device?code=ABCD-EFGH",
          expires_in: 900,
          interval: 1,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
        }),
      );
    const adapter = new OpenCodeAuthAdapter({
      storage,
      fetch: fetch as unknown as typeof globalThis.fetch,
      sleep: () =>
        new Promise<void>((resolve) => {
          releaseSleep = resolve;
        }),
    });

    await adapter.startLogin("opencode-go");
    releaseSleep?.();
    await flush();

    await expect(adapter.status("opencode-go")).resolves.toEqual({
      loggedIn: true,
      provider: "opencode-go",
    });
    await expect(
      adapter.resolveTokenProvider("opencode-go")?.getAccessToken(),
    ).resolves.toBe("access-token");
    expect(adapter.getFlow("opencode-go")).toMatchObject({
      status: "authenticated",
    });
    expect(storage.token).toMatchObject({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      tokenType: "Bearer",
    });
    expect(fetch).toHaveBeenLastCalledWith(
      "https://console.opencode.ai/auth/device/token",
      expect.objectContaining({
        body: JSON.stringify({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: "device-code",
          client_id: "opencode-cli",
        }),
      }),
    );
  });

  it("refreshes a Kimi-owned stored token and never reads OpenCode CLI files", async () => {
    const storage = new MemoryTokenStorage();
    storage.token = {
      accessToken: "expired",
      refreshToken: "refresh-token",
      expiresAt: 1,
      expiresIn: 1,
      scope: "",
      tokenType: "Bearer",
    };
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        access_token: "fresh-token",
        refresh_token: "next-refresh-token",
        expires_in: 3600,
      }),
    );
    const adapter = new OpenCodeAuthAdapter({
      storage,
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => 2_000_000,
    });

    await expect(
      adapter.resolveTokenProvider("opencode")?.getAccessToken(),
    ).resolves.toBe("fresh-token");
    expect(fetch).toHaveBeenCalledWith(
      "https://console.opencode.ai/auth/device/token",
      expect.objectContaining({
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: "refresh-token",
          client_id: "opencode-cli",
        }),
      }),
    );
    expect(storage.token?.accessToken).toBe("fresh-token");
  });

  it("cancels a pending device poll without persisting a token", async () => {
    const storage = new MemoryTokenStorage();
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        device_code: "device-code",
        user_code: "ABCD-EFGH",
        verification_uri_complete:
          "https://console.opencode.ai/auth/device?code=ABCD-EFGH",
        expires_in: 900,
        interval: 1,
      }),
    );
    const adapter = new OpenCodeAuthAdapter({
      storage,
      fetch: fetch as unknown as typeof globalThis.fetch,
      sleep: (_ms, signal) =>
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
    });

    await adapter.startLogin("opencode");
    await expect(adapter.cancelLogin("opencode")).resolves.toEqual({
      cancelled: true,
      status: "cancelled",
    });
    await flush();

    expect(storage.token).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(adapter.getFlow("opencode")).toMatchObject({ status: "cancelled" });
  });
});

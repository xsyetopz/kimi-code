import { describe, expect, it, vi } from "vitest";

import type { TokenInfo, TokenStorage } from "@moonshot-ai/kimi-code-oauth";

import { CopilotAuthAdapter } from "#/app/auth/copilotAuthAdapter";

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
    return this.token === undefined ? [] : ["github-copilot"];
  }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("CopilotAuthAdapter", () => {
  it("starts GitHub device authorization with the OpenCode Copilot client id", async () => {
    const storage = new MemoryTokenStorage();
    const sleep = vi.fn(() => new Promise<void>(() => {}));
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        device_code: "device-code",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      }),
    );
    const adapter = new CopilotAuthAdapter({
      storage,
      fetch: fetch as unknown as typeof globalThis.fetch,
      sleep,
    });

    const result = await adapter.startLogin("github-copilot");

    expect(fetch).toHaveBeenCalledWith(
      "https://github.com/login/device/code",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          client_id: "Ov23li8tweQw6odWQebz",
          scope: "read:user",
        }),
      }),
    );
    expect(result).toMatchObject({
      provider: "github-copilot",
      status: "pending",
      verification_uri: "https://github.com/login/device",
      verification_uri_complete:
        "https://github.com/login/device?user_code=ABCD-1234",
      user_code: "ABCD-1234",
    });
    expect(sleep).toHaveBeenCalledWith(8000, expect.any(AbortSignal));
  });

  it("persists the GitHub token after device polling succeeds", async () => {
    const storage = new MemoryTokenStorage();
    let releaseSleep: (() => void) | undefined;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          device_code: "device-code",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 1,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          access_token: "github-access-token",
        }),
      );
    const adapter = new CopilotAuthAdapter({
      storage,
      fetch: fetch as unknown as typeof globalThis.fetch,
      sleep: () =>
        new Promise<void>((resolve) => {
          releaseSleep = resolve;
        }),
    });

    await adapter.startLogin("github-copilot");
    releaseSleep?.();
    await flush();

    await expect(adapter.status("github-copilot")).resolves.toEqual({
      loggedIn: true,
      provider: "github-copilot",
    });
    await expect(
      adapter.resolveTokenProvider("github-copilot")?.getAccessToken(),
    ).resolves.toBe("github-access-token");
    expect(adapter.getFlow("github-copilot")).toMatchObject({
      status: "authenticated",
    });
    expect(storage.token).toMatchObject({
      accessToken: "github-access-token",
      refreshToken: "github-access-token",
      expiresAt: 0,
      tokenType: "Bearer",
      scope: "read:user",
    });
    expect(fetch).toHaveBeenLastCalledWith(
      "https://github.com/login/oauth/access_token",
      expect.objectContaining({
        body: JSON.stringify({
          client_id: "Ov23li8tweQw6odWQebz",
          device_code: "device-code",
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      }),
    );
  });

  it("returns a cached non-expiring GitHub token without refresh", async () => {
    const storage = new MemoryTokenStorage();
    storage.token = {
      accessToken: "github-access-token",
      refreshToken: "github-access-token",
      expiresAt: 0,
      expiresIn: 0,
      scope: "read:user",
      tokenType: "Bearer",
    };
    const fetch = vi.fn();
    const adapter = new CopilotAuthAdapter({
      storage,
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => 2_000_000,
    });

    await expect(
      adapter.resolveTokenProvider("github-copilot")?.getAccessToken(),
    ).resolves.toBe("github-access-token");
    await expect(
      adapter.getCachedAccessToken("github-copilot"),
    ).resolves.toBe("github-access-token");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("clears stored credentials on logout", async () => {
    const storage = new MemoryTokenStorage();
    storage.token = {
      accessToken: "github-access-token",
      refreshToken: "github-access-token",
      expiresAt: 0,
      expiresIn: 0,
      scope: "read:user",
      tokenType: "Bearer",
    };
    const adapter = new CopilotAuthAdapter({ storage });

    await expect(adapter.logout("github-copilot")).resolves.toEqual({
      logged_out: true,
      provider: "github-copilot",
    });
    expect(storage.token).toBeUndefined();
  });

  it("cancels a pending device poll without persisting a token", async () => {
    const storage = new MemoryTokenStorage();
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        device_code: "device-code",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 1,
      }),
    );
    const adapter = new CopilotAuthAdapter({
      storage,
      fetch: fetch as unknown as typeof globalThis.fetch,
      sleep: (_ms, signal) =>
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
    });

    await adapter.startLogin("github-copilot");
    await expect(adapter.cancelLogin("github-copilot")).resolves.toEqual({
      cancelled: true,
      status: "cancelled",
    });
    await flush();

    expect(storage.token).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(adapter.getFlow("github-copilot")).toMatchObject({
      status: "cancelled",
    });
  });
});

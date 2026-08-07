import { describe, expect, it, vi } from "vitest";

import type { TokenInfo, TokenStorage } from "@moonshot-ai/kimi-code-oauth";

import { CodexAuthAdapter } from "#/app/auth/codexAuthAdapter";
import { extractAccountIdFromTokens } from "#/app/auth/codexAccountId";

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
    return this.token === undefined ? [] : ["openai-codex"];
  }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function createTestJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

describe("CodexAuthAdapter", () => {
  it("starts Codex device authorization with the official client id", async () => {
    const storage = new MemoryTokenStorage();
    const sleep = vi.fn(() => new Promise<void>(() => {}));
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        device_auth_id: "device-auth-id",
        user_code: "ABCD-1234",
        interval: "5",
      }),
    );
    const adapter = new CodexAuthAdapter({
      storage,
      fetch: fetch as unknown as typeof globalThis.fetch,
      sleep,
    });

    const result = await adapter.startLogin("openai");

    expect(fetch).toHaveBeenCalledWith(
      "https://auth.openai.com/api/accounts/deviceauth/usercode",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        }),
      }),
    );
    expect(result).toMatchObject({
      provider: "openai",
      status: "pending",
      verification_uri: "https://auth.openai.com/codex/device",
      verification_uri_complete: "https://auth.openai.com/codex/device",
      user_code: "ABCD-1234",
    });
    expect(sleep).toHaveBeenCalledWith(8000, expect.any(AbortSignal));
  });

  it("persists Codex tokens after device polling and PKCE exchange", async () => {
    const storage = new MemoryTokenStorage();
    let releaseSleep: (() => void) | undefined;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          device_auth_id: "device-auth-id",
          user_code: "ABCD-1234",
          interval: 1,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          authorization_code: "auth-code",
          code_verifier: "code-verifier",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          access_token: "codex-access-token",
          refresh_token: "codex-refresh-token",
          expires_in: 3600,
        }),
      );
    const adapter = new CodexAuthAdapter({
      storage,
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => 1_000_000,
      sleep: () =>
        new Promise<void>((resolve) => {
          releaseSleep = resolve;
        }),
    });

    await adapter.startLogin("openai");
    releaseSleep?.();
    await flush();

    await expect(adapter.status("openai")).resolves.toEqual({
      loggedIn: true,
      provider: "openai",
    });
    await expect(
      adapter.resolveTokenProvider("openai")?.getAccessToken(),
    ).resolves.toBe("codex-access-token");
    expect(adapter.getFlow("openai")).toMatchObject({
      status: "authenticated",
    });
    expect(storage.token).toMatchObject({
      accessToken: "codex-access-token",
      refreshToken: "codex-refresh-token",
      expiresAt: 1_000_000 / 1000 + 3600,
      tokenType: "Bearer",
    });
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://auth.openai.com/api/accounts/deviceauth/token",
      expect.objectContaining({
        body: JSON.stringify({
          device_auth_id: "device-auth-id",
          user_code: "ABCD-1234",
        }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      "https://auth.openai.com/oauth/token",
      expect.objectContaining({
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "auth-code",
          redirect_uri: "https://auth.openai.com/deviceauth/callback",
          client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
          code_verifier: "code-verifier",
        }).toString(),
      }),
    );
  });

  it("persists ChatGPT account id from OAuth id_token and exposes request headers", async () => {
    const storage = new MemoryTokenStorage();
    let releaseSleep: (() => void) | undefined;
    const idToken = createTestJwt({ chatgpt_account_id: "org-acc-42" });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          device_auth_id: "device-auth-id",
          user_code: "ABCD-1234",
          interval: 1,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          authorization_code: "auth-code",
          code_verifier: "code-verifier",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          id_token: idToken,
          access_token: "codex-access-token",
          refresh_token: "codex-refresh-token",
          expires_in: 3600,
        }),
      );
    const adapter = new CodexAuthAdapter({
      storage,
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => 1_000_000,
      sleep: () =>
        new Promise<void>((resolve) => {
          releaseSleep = resolve;
        }),
    });

    await adapter.startLogin("openai");
    releaseSleep?.();
    await flush();

    expect(storage.token?.accountId).toBe("org-acc-42");
    expect(
      extractAccountIdFromTokens({
        id_token: createTestJwt({ chatgpt_account_id: "from-id-token" }),
        access_token: createTestJwt({ chatgpt_account_id: "from-access-token" }),
      }),
    ).toBe("from-id-token");
    await expect(
      adapter.resolveTokenProvider("openai")?.getRequestHeaders?.(),
    ).resolves.toEqual({ "ChatGPT-Account-Id": "org-acc-42" });
  });

  it("refreshes an expired Codex access token", async () => {
    const storage = new MemoryTokenStorage();
    storage.token = {
      accessToken: "stale-access-token",
      refreshToken: "codex-refresh-token",
      expiresAt: 500,
      expiresIn: 3600,
      scope: "openid profile email offline_access",
      tokenType: "Bearer",
    };
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        access_token: "fresh-access-token",
        refresh_token: "fresh-refresh-token",
        expires_in: 7200,
      }),
    );
    const adapter = new CodexAuthAdapter({
      storage,
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => 2_000_000,
    });

    await expect(
      adapter.resolveTokenProvider("openai")?.getAccessToken(),
    ).resolves.toBe("fresh-access-token");
    expect(fetch).toHaveBeenCalledWith(
      "https://auth.openai.com/oauth/token",
      expect.objectContaining({
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: "codex-refresh-token",
          client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        }).toString(),
      }),
    );
    expect(storage.token).toMatchObject({
      accessToken: "fresh-access-token",
      refreshToken: "fresh-refresh-token",
      expiresAt: 2_000_000 / 1000 + 7200,
    });
  });

  it("cancels a pending device poll without persisting a token", async () => {
    const storage = new MemoryTokenStorage();
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        device_auth_id: "device-auth-id",
        user_code: "ABCD-1234",
        interval: 1,
      }),
    );
    const adapter = new CodexAuthAdapter({
      storage,
      fetch: fetch as unknown as typeof globalThis.fetch,
      sleep: (_ms, signal) =>
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
    });

    await adapter.startLogin("openai");
    await expect(adapter.cancelLogin("openai")).resolves.toEqual({
      cancelled: true,
      status: "cancelled",
    });
    await flush();

    expect(storage.token).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(adapter.getFlow("openai")).toMatchObject({
      status: "cancelled",
    });
  });
});

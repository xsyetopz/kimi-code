import { describe, expect, it, vi } from "vitest";

import { createKimiEngineAuthFacade } from "#/engine-auth";

describe("createKimiEngineAuthFacade", () => {
  it("delegates every engine auth lifecycle method", async () => {
    const auth = {
      status: vi.fn(async () => ({ loggedIn: true, provider: "opencode" })),
      summarize: vi.fn(async () => [{ loggedIn: true, provider: "openai" }]),
      startLogin: vi.fn(async () => ({
        flow_id: "flow-1",
        provider: "github-copilot",
        status: "pending" as const,
        verification_uri: "https://example.test/device",
        verification_uri_complete: "https://example.test/device?code=ABCD",
        user_code: "ABCD",
        expires_in: 900,
        interval: 5,
        expires_at: new Date(Date.now() + 900_000).toISOString(),
      })),
      flow: vi.fn(async () => ({
        flow_id: "flow-1",
        provider: "openai",
        status: "authenticated" as const,
        verification_uri: "https://example.test/device",
        verification_uri_complete: "https://example.test/device?code=ABCD",
        user_code: "ABCD",
        expires_in: 900,
        interval: 5,
        expires_at: new Date(Date.now() + 900_000).toISOString(),
      })),
      cancelLogin: vi.fn(async () => ({
        cancelled: true as const,
        status: "cancelled" as const,
      })),
      logout: vi.fn(async () => ({
        logged_out: true as const,
        provider: "openai",
      })),
    };

    const facade = createKimiEngineAuthFacade(auth);

    await expect(facade.status("opencode")).resolves.toEqual({
      loggedIn: true,
      provider: "opencode",
    });
    await expect(facade.summarize()).resolves.toEqual([
      { loggedIn: true, provider: "openai" },
    ]);
    await expect(facade.startLogin("github-copilot")).resolves.toMatchObject({
      provider: "github-copilot",
      status: "pending",
    });
    await expect(facade.flow("openai")).resolves.toMatchObject({
      status: "authenticated",
    });
    await expect(facade.cancelLogin("openai")).resolves.toEqual({
      cancelled: true,
      status: "cancelled",
    });
    await expect(facade.logout("openai")).resolves.toEqual({
      logged_out: true,
      provider: "openai",
    });

    expect(auth.status).toHaveBeenCalledWith("opencode");
    expect(auth.summarize).toHaveBeenCalled();
    expect(auth.startLogin).toHaveBeenCalledWith("github-copilot");
    expect(auth.flow).toHaveBeenCalledWith("openai");
    expect(auth.cancelLogin).toHaveBeenCalledWith("openai");
    expect(auth.logout).toHaveBeenCalledWith("openai");
  });
});

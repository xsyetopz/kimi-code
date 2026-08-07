import { describe, expect, it, vi } from "vitest";

import {
  handleLoginCommand,
  handleLogoutCommand,
} from "#/tui/commands/auth";
import {
  promptLogoutProviderSelection,
  promptPlatformSelection,
} from "#/tui/commands/prompts";
import type { SlashCommandHost } from "#/tui/commands/dispatch";

vi.mock("#/tui/commands/prompts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("#/tui/commands/prompts")>();
  return {
    ...actual,
    promptPlatformSelection: vi.fn(),
    promptLogoutProviderSelection: vi.fn(),
  };
});

function makeHost(
  overrides: {
    harness?: Record<string, unknown>;
    state?: Record<string, unknown>;
  } = {},
): SlashCommandHost {
  const refreshConfigAfterLogin = vi.fn(async () => {});
  const refreshConfigAfterLogout = vi.fn(async () => {});
  const clearActiveSessionAfterLogout = vi.fn(async () => {});
  return {
    harness: {
      auth: {
        status: vi.fn(async () => ({ providers: [] })),
        login: vi.fn(async () => {}),
        logout: vi.fn(),
      },
      engineAuth: {
        status: vi.fn(async () => ({ loggedIn: false })),
        summarize: vi.fn(async () => []),
        startLogin: vi.fn(async () => ({
          flow_id: "flow-opencode",
          provider: "opencode",
          status: "authenticated" as const,
        })),
        flow: vi.fn(async () => undefined),
        cancelLogin: vi.fn(),
        logout: vi.fn(async () => ({
          logged_out: true as const,
          provider: "opencode",
        })),
      },
      getConfig: vi.fn(async () => ({ providers: {}, models: {} })),
      removeProvider: vi.fn(),
      track: vi.fn(),
      ...overrides.harness,
    },
    state: {
      appState: {
        model: "",
        availableModels: {},
        availableProviders: {},
      },
      ...overrides.state,
    },
    authFlow: {
      refreshConfigAfterLogin,
      refreshConfigAfterLogout,
      clearActiveSessionAfterLogout,
    },
    session: undefined,
    cancelInFlight: undefined,
    restoreEditor: vi.fn(),
    mountEditorReplacement: vi.fn(),
    showError: vi.fn(),
    showStatus: vi.fn(),
    track: vi.fn(),
    showLoginProgressSpinner: vi.fn(() => ({ stop: vi.fn() })),
    showLoginAuthorizationPrompt: vi.fn(() => ({ stop: vi.fn() })),
    setAppState: vi.fn(),
  } as unknown as SlashCommandHost;
}

describe("handleLoginCommand external oauth", () => {
  it("routes OpenCode Zen through engine auth", async () => {
    const host = makeHost();
    vi.mocked(promptPlatformSelection).mockResolvedValue("opencode");

    await handleLoginCommand(host);

    expect(host.harness.engineAuth.startLogin).toHaveBeenCalledWith("opencode");
    expect(host.harness.auth.login).not.toHaveBeenCalled();
    expect(host.authFlow.refreshConfigAfterLogin).toHaveBeenCalled();
    expect(host.track).toHaveBeenCalledWith("login", {
      provider: "opencode",
      method: "oauth",
      already_logged_in: false,
    });
  });

  it("shows the device-code prompt while OpenCode Go login is pending", async () => {
    const flow = vi
      .fn()
      .mockResolvedValueOnce({
        flow_id: "flow-opencode-go",
        provider: "opencode-go",
        status: "pending" as const,
        verification_uri: "https://console.opencode.ai/auth/device",
        verification_uri_complete:
          "https://console.opencode.ai/auth/device?code=ABCD-EFGH",
        user_code: "ABCD-EFGH",
        expires_in: 900,
        expires_at: new Date(Date.now() + 900_000).toISOString(),
        interval: 0,
      })
      .mockResolvedValueOnce({
        flow_id: "flow-opencode-go",
        provider: "opencode-go",
        status: "authenticated" as const,
        verification_uri: "https://console.opencode.ai/auth/device",
        verification_uri_complete:
          "https://console.opencode.ai/auth/device?code=ABCD-EFGH",
        user_code: "ABCD-EFGH",
        expires_in: 900,
        expires_at: new Date(Date.now() + 900_000).toISOString(),
        interval: 0,
      });
    const host = makeHost({
      harness: {
        engineAuth: {
          status: vi.fn(async () => ({ loggedIn: false })),
          summarize: vi.fn(async () => []),
          startLogin: vi.fn(async () => ({
            flow_id: "flow-opencode-go",
            provider: "opencode-go",
            status: "pending" as const,
            verification_uri: "https://console.opencode.ai/auth/device",
            verification_uri_complete:
              "https://console.opencode.ai/auth/device?code=ABCD-EFGH",
            user_code: "ABCD-EFGH",
            expires_in: 900,
            expires_at: new Date(Date.now() + 900_000).toISOString(),
            interval: 0,
          })),
          flow,
          cancelLogin: vi.fn(),
          logout: vi.fn(),
        },
      },
    });
    vi.mocked(promptPlatformSelection).mockResolvedValue("opencode-go");

    await handleLoginCommand(host);

    expect(host.showLoginAuthorizationPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        userCode: "ABCD-EFGH",
        verificationUriComplete:
          "https://console.opencode.ai/auth/device?code=ABCD-EFGH",
      }),
      "Sign in to OpenCode Go",
    );
    expect(flow).toHaveBeenCalledWith("opencode-go");
  });
});

describe("handleLogoutCommand external oauth", () => {
  it("logs out OpenCode Zen through engine auth", async () => {
    const host = makeHost({
      harness: {
        engineAuth: {
          status: vi.fn(async (provider?: string) =>
            provider === "opencode"
              ? { loggedIn: true, provider: "opencode" }
              : { loggedIn: false },
          ),
          summarize: vi.fn(async () => []),
          startLogin: vi.fn(),
          flow: vi.fn(),
          cancelLogin: vi.fn(),
          logout: vi.fn(async () => ({
            logged_out: true as const,
            provider: "opencode",
          })),
        },
      },
    });
    vi.mocked(promptLogoutProviderSelection).mockResolvedValue("opencode");

    await handleLogoutCommand(host);

    expect(host.harness.engineAuth.logout).toHaveBeenCalledWith("opencode");
    expect(host.harness.auth.logout).not.toHaveBeenCalled();
    expect(host.track).toHaveBeenCalledWith("logout", { provider: "opencode" });
  });
});

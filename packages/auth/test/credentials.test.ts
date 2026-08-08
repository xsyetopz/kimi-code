import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Credential,
  listAuthStatus,
  loadCredentials,
  loginProvider,
  logoutProvider,
  saveCredentials,
  setApiKey,
} from "../src/index";

describe("credential store", () => {
  let tempDir: string;
  let credPath: string;

  afterEach(async () => {
    void tempDir;
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  async function setup(): Promise<string> {
    tempDir = await mkdtemp(join(tmpdir(), "kimi-auth-"));
    credPath = join(tempDir, "credentials.json");
    return credPath;
  }

  it("roundtrips credentials through save and load", async () => {
    const path = await setup();
    const credentials: Credential[] = [
      { providerId: "moonshot", kind: "api_key", apiKey: "sk-test" },
      {
        providerId: "openai-codex",
        kind: "oauth",
        accessToken: "access-1",
        refreshToken: "refresh-1",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    ];

    await saveCredentials(credentials, path);
    const loaded = await loadCredentials(path);

    expect(loaded).toEqual(credentials);

    const raw = await readFile(path, "utf8");
    expect(JSON.parse(raw)).toEqual(credentials);
  });

  it("replaces api key for the same provider", async () => {
    const path = await setup();
    await setApiKey("xai", "key-a", path);
    await setApiKey("xai", "key-b", path);

    const loaded = await loadCredentials(path);
    expect(loaded).toEqual([
      { providerId: "xai", kind: "api_key", apiKey: "key-b" },
    ]);
  });

  it("loginProvider stores api key and logout clears it", async () => {
    const path = await setup();
    await loginProvider("openrouter", { apiKey: "or-key", path });

    const statuses = await listAuthStatus(path);
    const openrouter = statuses.find((s) => s.providerId === "openrouter");
    expect(openrouter?.configured).toBe(true);
    expect(openrouter?.kind).toBe("api_key");

    await logoutProvider("openrouter", path);
    const afterLogout = await listAuthStatus(path);
    expect(
      afterLogout.find((s) => s.providerId === "openrouter")?.configured,
    ).toBe(false);
  });

  it("finishes a mocked PKCE OAuth exchange", async () => {
    const path = await setup();
    vi.stubEnv("KIMI_NEXT_OPENAI_CODEX_CLIENT_ID", "test-client");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: "real-access-token",
              refresh_token: "real-refresh-token",
              expires_in: 3600,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const begin = await loginProvider("openai-codex", { path });
    expect(begin.authorizeUrl).toContain("auth.openai.com");
    expect(begin.state).toBeTruthy();

    const finishOptions: { path: string; code: string; state?: string } = {
      path,
      code: "auth-code",
    };
    if (begin.state !== undefined) {
      finishOptions.state = begin.state;
    }
    await loginProvider("openai-codex", finishOptions);

    const loaded = await loadCredentials(path);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.kind).toBe("oauth");
    expect(loaded[0]?.accessToken).toBe("real-access-token");
    expect(loaded[0]?.refreshToken).toBe("real-refresh-token");
  });
});

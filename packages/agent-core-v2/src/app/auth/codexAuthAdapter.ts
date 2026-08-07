/**
 * `auth` domain — OpenAI Codex device-OAuth provider adapter.
 *
 * Implements Codex's official device authorization flow (usercode poll plus
 * PKCE token exchange) against `auth.openai.com`, persists subscription
 * credentials through Kimi-owned storage, and exposes refresh for outbound
 * Codex API requests. Bound at App scope by `codexAuthAdapterService` when
 * the experimental flag is enabled.
 */

import { randomUUID } from "node:crypto";

import type { TokenInfo, TokenStorage } from "@moonshot-ai/kimi-code-oauth";

import type { AuthStatus } from "./auth";
import {
  completeDeviceOAuthFlow,
  failDeviceOAuthFlow,
  sleepWithAbort,
  toDeviceOAuthFlowSnapshot,
  toDeviceOAuthFlowStart,
  type DeviceOAuthFlow,
} from "./deviceOAuthHelpers";
import { extractAccountIdFromTokens } from "./codexAccountId";
import type {
  OAuthFlowSnapshot,
  OAuthFlowStart,
  OAuthLoginCancelResponse,
  OAuthLogoutResponse,
} from "./oauthProtocol";
import type {
  ProviderAuthAdapter,
  ProviderTokenProvider,
} from "./providerAuth";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEVICE_USERCODE_URL =
  "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN_URL =
  "https://auth.openai.com/api/accounts/deviceauth/token";
const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const DEVICE_VERIFICATION_URI = "https://auth.openai.com/codex/device";
const DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
const DEFAULT_DEVICE_EXPIRES_SEC = 15 * 60;
const DEFAULT_TOKEN_EXPIRES_SEC = 3600;
const REFRESH_SKEW_MS = 60_000;
/** Extra polling delay beyond the server-reported interval. */
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3_000;
const CODEX_ACCOUNT_ID_HEADER = "ChatGPT-Account-Id";
const STORAGE_NAME = "openai-codex";
const SCOPE = "openid profile email offline_access";

type UserCodeResponse = {
  readonly device_auth_id: string;
  readonly user_code: string;
  readonly interval: string | number;
};

type DeviceTokenResponse = {
  readonly authorization_code: string;
  readonly code_verifier: string;
};

type TokenResponse = {
  readonly id_token?: string;
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
};

export interface CodexAuthAdapterOptions {
  readonly storage: TokenStorage;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export class CodexAuthAdapter implements ProviderAuthAdapter {
  readonly integration = "openai-codex" as const;

  private readonly storage: TokenStorage;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly flows = new Map<string, DeviceOAuthFlow>();
  private readonly tokenProvider: ProviderTokenProvider;

  constructor(options: CodexAuthAdapterOptions) {
    this.storage = options.storage;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? sleepWithAbort;
    this.tokenProvider = {
      getAccessToken: (options) => this.accessToken(options?.force === true),
      getCachedAccessToken: () => this.cachedAccessToken(),
      getRequestHeaders: () => this.requestHeaders(),
    };
  }

  async startLogin(provider: string): Promise<OAuthFlowStart> {
    await this.cancelLogin(provider);
    const device = await this.postJson<UserCodeResponse>(DEVICE_USERCODE_URL, {
      client_id: CLIENT_ID,
    });
    if (!isUserCodeResponse(device))
      throw new Error(
        "OpenAI Codex returned an invalid device authorization response",
      );

    const interval = parseInterval(device.interval);
    const now = this.now();
    const flow: DeviceOAuthFlow = {
      flowId: `codex_${randomUUID()}`,
      provider,
      controller: new AbortController(),
      verificationUri: DEVICE_VERIFICATION_URI,
      verificationUriComplete: DEVICE_VERIFICATION_URI,
      userCode: device.user_code,
      expiresAt: now + DEFAULT_DEVICE_EXPIRES_SEC * 1000,
      interval,
      status: "pending",
    };
    this.flows.set(provider, flow);
    void this.poll(flow, device.device_auth_id, device.user_code);
    return toDeviceOAuthFlowStart(flow, this.now);
  }

  getFlow(provider: string): OAuthFlowSnapshot | undefined {
    const flow = this.flows.get(provider);
    return flow === undefined ? undefined : toDeviceOAuthFlowSnapshot(flow, this.now);
  }

  async cancelLogin(provider: string): Promise<OAuthLoginCancelResponse> {
    const flow = this.flows.get(provider);
    if (flow === undefined || flow.status !== "pending") {
      return { cancelled: false, status: flow?.status ?? "cancelled" };
    }
    flow.controller.abort();
    flow.status = "cancelled";
    flow.resolvedAt = new Date(this.now()).toISOString();
    return { cancelled: true, status: "cancelled" };
  }

  async logout(provider: string): Promise<OAuthLogoutResponse> {
    await this.cancelLogin(provider);
    await this.storage.remove(STORAGE_NAME);
    return { logged_out: true, provider };
  }

  async status(provider: string): Promise<AuthStatus> {
    const token = await this.cachedAccessToken();
    return token === undefined
      ? { loggedIn: false }
      : { loggedIn: true, provider };
  }

  resolveTokenProvider(_provider: string): ProviderTokenProvider {
    return this.tokenProvider;
  }

  async getCachedAccessToken(_provider: string): Promise<string | undefined> {
    return this.cachedAccessToken();
  }

  private async poll(
    flow: DeviceOAuthFlow,
    deviceAuthId: string,
    userCode: string,
  ): Promise<void> {
    try {
      while (!flow.controller.signal.aborted && this.now() < flow.expiresAt) {
        await this.sleep(
          flow.interval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS,
          flow.controller.signal,
        );
        if (flow.controller.signal.aborted) return;
        const response = await this.fetchImpl(DEVICE_TOKEN_URL, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            device_auth_id: deviceAuthId,
            user_code: userCode,
          }),
          signal: flow.controller.signal,
        });
        if (response.ok) {
          const deviceToken = (await response.json()) as DeviceTokenResponse;
          if (!isDeviceTokenResponse(deviceToken)) {
            failDeviceOAuthFlow(
              flow,
              "OpenAI Codex returned an invalid device token response",
              this.now,
            );
            return;
          }
          const tokens = await this.exchangeAuthorizationCode(
            deviceToken.authorization_code,
            deviceToken.code_verifier,
            flow.controller.signal,
          );
          if (!isTokenResponse(tokens) || tokens.access_token === undefined) {
            failDeviceOAuthFlow(
              flow,
              "OpenAI Codex returned an invalid token response",
              this.now,
            );
            return;
          }
          await this.saveToken(tokens);
          completeDeviceOAuthFlow(flow, "authenticated", this.now);
          return;
        }
        if (response.status === 403 || response.status === 404) continue;
        failDeviceOAuthFlow(
          flow,
          `Device authorization failed with status ${response.status}`,
          this.now,
        );
        return;
      }
      if (!flow.controller.signal.aborted)
        completeDeviceOAuthFlow(flow, "expired", this.now);
    } catch (error) {
      if (flow.controller.signal.aborted) return;
      failDeviceOAuthFlow(
        flow,
        error instanceof Error ? error.message : String(error),
        this.now,
      );
    }
  }

  private async exchangeAuthorizationCode(
    code: string,
    codeVerifier: string,
    signal?: AbortSignal,
  ): Promise<TokenResponse> {
    return this.postForm(
      OAUTH_TOKEN_URL,
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: DEVICE_REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: codeVerifier,
      },
      signal,
    );
  }

  private async accessToken(force: boolean): Promise<string> {
    const token = await this.storage.load(STORAGE_NAME);
    if (token === undefined || token.accessToken === "")
      throw new Error("OpenAI Codex is not authenticated");
    if (!force && token.expiresAt * 1000 > this.now() + REFRESH_SKEW_MS)
      return token.accessToken;
    if (token.refreshToken === "")
      throw new Error("OpenAI Codex authentication has expired");
    const refreshed = await this.postForm(OAUTH_TOKEN_URL, {
      grant_type: "refresh_token",
      refresh_token: token.refreshToken,
      client_id: CLIENT_ID,
    });
    if (!isTokenResponse(refreshed) || refreshed.access_token === undefined)
      throw new Error("OpenAI Codex returned an invalid refresh response");
    await this.saveToken(refreshed, token);
    return refreshed.access_token;
  }

  private async cachedAccessToken(): Promise<string | undefined> {
    const token = await this.storage.load(STORAGE_NAME);
    if (token === undefined || token.accessToken === "") return undefined;
    return token.expiresAt * 1000 > this.now() ? token.accessToken : undefined;
  }

  private async requestHeaders(): Promise<Record<string, string> | undefined> {
    const token = await this.storage.load(STORAGE_NAME);
    if (token?.accountId === undefined || token.accountId === "") return undefined;
    return { [CODEX_ACCOUNT_ID_HEADER]: token.accountId };
  }

  private async saveToken(
    token: TokenResponse,
    existing?: TokenInfo,
  ): Promise<void> {
    const expiresIn = token.expires_in ?? DEFAULT_TOKEN_EXPIRES_SEC;
    const accountId =
      extractAccountIdFromTokens(token) ?? existing?.accountId;
    const stored: TokenInfo = {
      accessToken: token.access_token ?? existing?.accessToken ?? "",
      refreshToken: token.refresh_token ?? existing?.refreshToken ?? "",
      expiresAt: Math.floor(this.now() / 1000) + expiresIn,
      expiresIn,
      scope: SCOPE,
      tokenType: "Bearer",
      accountId,
    };
    await this.storage.save(STORAGE_NAME, stored);
  }

  private async postJson<T>(
    url: string,
    body: Record<string, string>,
    requireOk = true,
    signal?: AbortSignal,
  ): Promise<T> {
    const request: RequestInit = {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    };
    const response = await this.fetchImpl(url, request);
    if (requireOk && !response.ok)
      throw new Error(`OpenAI Codex OAuth request failed: ${response.status}`);
    return response.json() as Promise<T>;
  }

  private async postForm(
    url: string,
    body: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<TokenResponse> {
    const request: RequestInit = {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body).toString(),
      ...(signal === undefined ? {} : { signal }),
    };
    const response = await this.fetchImpl(url, request);
    if (!response.ok)
      throw new Error(`OpenAI Codex OAuth request failed: ${response.status}`);
    return response.json() as Promise<TokenResponse>;
  }

}

function isUserCodeResponse(value: unknown): value is UserCodeResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as UserCodeResponse).device_auth_id === "string" &&
    typeof (value as UserCodeResponse).user_code === "string" &&
    (typeof (value as UserCodeResponse).interval === "string" ||
      typeof (value as UserCodeResponse).interval === "number")
  );
}

function isDeviceTokenResponse(value: unknown): value is DeviceTokenResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as DeviceTokenResponse).authorization_code === "string" &&
    typeof (value as DeviceTokenResponse).code_verifier === "string"
  );
}

function isTokenResponse(value: unknown): value is TokenResponse {
  return typeof value === "object" && value !== null;
}

function parseInterval(value: string | number): number {
  if (typeof value === "number") return value > 0 ? value : 5;
  const parsed = Number.parseInt(value.trim(), 10);
  return parsed > 0 ? parsed : 5;
}


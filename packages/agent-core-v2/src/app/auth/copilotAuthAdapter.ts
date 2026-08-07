/**
 * `auth` domain — GitHub Copilot device-OAuth provider adapter.
 *
 * Implements GitHub's device authorization flow and persists the resulting
 * GitHub access token through Kimi-owned storage for Copilot API requests.
 * Bound at App scope by `copilotAuthAdapterService` when the experimental flag
 * is enabled.
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

const CLIENT_ID = "Ov23li8tweQw6odWQebz";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const DEFAULT_VERIFICATION_URI = "https://github.com/login/device";
const SCOPE = "read:user";
const STORAGE_NAME = "github-copilot";
/** GitHub device-flow polling safety margin (OpenCode Copilot plugin). */
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3_000;

type DeviceResponse = {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly verification_uri_complete?: string;
  readonly expires_in: number;
  readonly interval: number;
};

type TokenResponse = {
  readonly access_token?: string;
  readonly error?: string;
  readonly interval?: number;
};

export interface CopilotAuthAdapterOptions {
  readonly storage: TokenStorage;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export class CopilotAuthAdapter implements ProviderAuthAdapter {
  readonly integration = "github-copilot" as const;

  private readonly storage: TokenStorage;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly flows = new Map<string, DeviceOAuthFlow>();
  private readonly tokenProvider: ProviderTokenProvider;

  constructor(options: CopilotAuthAdapterOptions) {
    this.storage = options.storage;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? sleepWithAbort;
    this.tokenProvider = {
      getAccessToken: () => this.accessToken(),
      getCachedAccessToken: () => this.cachedAccessToken(),
    };
  }

  async startLogin(provider: string): Promise<OAuthFlowStart> {
    await this.cancelLogin(provider);
    const device = await this.post<DeviceResponse>(DEVICE_CODE_URL, {
      client_id: CLIENT_ID,
      scope: SCOPE,
    });
    if (!isDeviceResponse(device))
      throw new Error(
        "GitHub Copilot returned an invalid device authorization response",
      );

    const verificationUri = device.verification_uri || DEFAULT_VERIFICATION_URI;
    const verificationUriComplete =
      device.verification_uri_complete ??
      `${verificationUri}?user_code=${encodeURIComponent(device.user_code)}`;
    const now = this.now();
    const flow: DeviceOAuthFlow = {
      flowId: `copilot_${randomUUID()}`,
      provider,
      controller: new AbortController(),
      verificationUri,
      verificationUriComplete,
      userCode: device.user_code,
      expiresAt: now + device.expires_in * 1000,
      interval: device.interval,
      status: "pending",
    };
    this.flows.set(provider, flow);
    void this.poll(flow, device.device_code);
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

  private async poll(flow: DeviceOAuthFlow, deviceCode: string): Promise<void> {
    try {
      while (!flow.controller.signal.aborted && this.now() < flow.expiresAt) {
        await this.sleep(
          flow.interval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS,
          flow.controller.signal,
        );
        if (flow.controller.signal.aborted) return;
        const result = await this.post<TokenResponse>(
          TOKEN_URL,
          {
            client_id: CLIENT_ID,
            device_code: deviceCode,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          },
          false,
          flow.controller.signal,
        );
        if (typeof result.access_token === "string" && result.access_token !== "") {
          await this.saveGithubToken(result.access_token);
          completeDeviceOAuthFlow(flow, "authenticated", this.now);
          return;
        }
        if (result.error === "authorization_pending") continue;
        if (result.error === "slow_down") {
          flow.interval += 5;
          if (
            typeof result.interval === "number" &&
            result.interval > 0
          ) {
            flow.interval = result.interval;
          }
          continue;
        }
        failDeviceOAuthFlow(
          flow,
          result.error === undefined
            ? "Device authorization failed"
            : `Device authorization failed: ${result.error}`,
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

  private async accessToken(): Promise<string> {
    const token = await this.storage.load(STORAGE_NAME);
    if (token === undefined || token.accessToken === "")
      throw new Error("GitHub Copilot is not authenticated");
    if (token.expiresAt === 0 || token.expiresAt * 1000 > this.now())
      return token.accessToken;
    throw new Error("GitHub Copilot authentication has expired");
  }

  private async cachedAccessToken(): Promise<string | undefined> {
    const token = await this.storage.load(STORAGE_NAME);
    if (token === undefined || token.accessToken === "") return undefined;
    if (token.expiresAt === 0) return token.accessToken;
    return token.expiresAt * 1000 > this.now() ? token.accessToken : undefined;
  }

  private async saveGithubToken(accessToken: string): Promise<void> {
    const stored: TokenInfo = {
      accessToken,
      // GitHub device OAuth does not issue a refresh token; Copilot uses the
      // GitHub token directly (OpenCode plugin stores the same value twice).
      refreshToken: accessToken,
      expiresAt: 0,
      expiresIn: 0,
      scope: SCOPE,
      tokenType: "Bearer",
    };
    await this.storage.save(STORAGE_NAME, stored);
  }

  private async post<T>(
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
      throw new Error(`GitHub Copilot OAuth request failed: ${response.status}`);
    return response.json() as Promise<T>;
  }

}

function isDeviceResponse(value: unknown): value is DeviceResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as DeviceResponse).device_code === "string" &&
    typeof (value as DeviceResponse).user_code === "string" &&
    typeof (value as DeviceResponse).verification_uri === "string" &&
    typeof (value as DeviceResponse).expires_in === "number" &&
    typeof (value as DeviceResponse).interval === "number"
  );
}


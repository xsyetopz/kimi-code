/**
 * `auth` domain — OpenCode Console device-OAuth provider adapter.
 *
 * Implements OpenCode's published device authorization and refresh contract,
 * persists its account credential through Kimi-owned token storage, and
 * exposes the generic provider-auth lifecycle consumed by `authService`.
 * Bound at App scope by `opencodeAuthAdapterService`.
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

const DEFAULT_SERVER = "https://console.opencode.ai";
const CLIENT_ID = "opencode-cli";
const STORAGE_NAME = "opencode";
const REFRESH_SKEW_MS = 60_000;

type DeviceResponse = {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri_complete: string;
  readonly expires_in: number;
  readonly interval: number;
};

type TokenResponse = {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_in: number;
};

type PendingResponse = { readonly error: string };

export interface OpenCodeAuthAdapterOptions {
  readonly storage: TokenStorage;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly server?: string;
}

export class OpenCodeAuthAdapter implements ProviderAuthAdapter {
  readonly integration = "opencode" as const;

  private readonly storage: TokenStorage;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly server: string;
  private readonly flows = new Map<string, DeviceOAuthFlow>();
  private readonly tokenProvider: ProviderTokenProvider;

  constructor(options: OpenCodeAuthAdapterOptions) {
    this.storage = options.storage;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? sleepWithAbort;
    this.server = (options.server ?? DEFAULT_SERVER).replace(/\/$/, "");
    this.tokenProvider = {
      getAccessToken: (options) => this.accessToken(options?.force === true),
      getCachedAccessToken: () => this.cachedAccessToken(),
    };
  }

  async startLogin(provider: string): Promise<OAuthFlowStart> {
    await this.cancelLogin(provider);
    const device = await this.post<DeviceResponse>("/auth/device/code", {
      client_id: CLIENT_ID,
    });
    if (!isDeviceResponse(device))
      throw new Error(
        "OpenCode returned an invalid device authorization response",
      );

    const now = this.now();
    const verificationUri = device.verification_uri_complete;
    const flow: DeviceOAuthFlow = {
      flowId: `opencode_${randomUUID()}`,
      provider,
      controller: new AbortController(),
      // OpenCode publishes only verification_uri_complete. Preserve it verbatim
      // in both fields rather than manufacturing an undocumented bare URL.
      verificationUri,
      verificationUriComplete: verificationUri,
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
    let interval = flow.interval;
    try {
      while (!flow.controller.signal.aborted && this.now() < flow.expiresAt) {
        await this.sleep(interval * 1000, flow.controller.signal);
        if (flow.controller.signal.aborted) return;
        const result = await this.post<TokenResponse | PendingResponse>(
          "/auth/device/token",
          {
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: deviceCode,
            client_id: CLIENT_ID,
          },
          false,
          flow.controller.signal,
        );
        if (isTokenResponse(result)) {
          await this.saveToken(result);
          completeDeviceOAuthFlow(flow, "authenticated", this.now);
          return;
        }
        if (result.error === "authorization_pending") continue;
        if (result.error === "slow_down") {
          interval += 5;
          continue;
        }
        failDeviceOAuthFlow(
          flow,
          `Device authorization failed: ${result.error}`,
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

  private async accessToken(force: boolean): Promise<string> {
    const token = await this.storage.load(STORAGE_NAME);
    if (token === undefined || token.accessToken === "")
      throw new Error("OpenCode is not authenticated");
    if (!force && token.expiresAt * 1000 > this.now() + REFRESH_SKEW_MS)
      return token.accessToken;
    if (token.refreshToken === "")
      throw new Error("OpenCode authentication has expired");
    const refreshed = await this.post<TokenResponse>("/auth/device/token", {
      grant_type: "refresh_token",
      refresh_token: token.refreshToken,
      client_id: CLIENT_ID,
    });
    if (!isTokenResponse(refreshed))
      throw new Error("OpenCode returned an invalid refresh response");
    await this.saveToken(refreshed);
    return refreshed.access_token;
  }

  private async cachedAccessToken(): Promise<string | undefined> {
    const token = await this.storage.load(STORAGE_NAME);
    if (token === undefined || token.accessToken === "") return undefined;
    return token.expiresAt * 1000 > this.now() ? token.accessToken : undefined;
  }

  private async saveToken(token: TokenResponse): Promise<void> {
    const stored: TokenInfo = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: Math.floor(this.now() / 1000) + token.expires_in,
      expiresIn: token.expires_in,
      scope: "",
      tokenType: "Bearer",
    };
    await this.storage.save(STORAGE_NAME, stored);
  }

  private async post<T>(
    path: string,
    body: Record<string, string>,
    requireOk = true,
    signal?: AbortSignal,
  ): Promise<T> {
    const request: RequestInit = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    };
    const response = await this.fetchImpl(`${this.server}${path}`, request);
    if (requireOk && !response.ok)
      throw new Error(`OpenCode OAuth request failed: ${response.status}`);
    return response.json() as Promise<T>;
  }

}

function isDeviceResponse(value: unknown): value is DeviceResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as DeviceResponse).device_code === "string" &&
    typeof (value as DeviceResponse).user_code === "string" &&
    typeof (value as DeviceResponse).verification_uri_complete === "string" &&
    typeof (value as DeviceResponse).expires_in === "number" &&
    typeof (value as DeviceResponse).interval === "number"
  );
}

function isTokenResponse(value: unknown): value is TokenResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as TokenResponse).access_token === "string" &&
    typeof (value as TokenResponse).refresh_token === "string" &&
    typeof (value as TokenResponse).expires_in === "number"
  );
}


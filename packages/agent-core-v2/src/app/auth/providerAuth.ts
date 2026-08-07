/**
 * `auth` domain — provider-auth integration registry.
 *
 * Transport/provider definitions describe how requests are sent; this catalog
 * separately describes who owns authentication. External adapters are
 * optional and injected by integrations that own the provider's official
 * login/token protocol. Keeping this boundary dependency-free prevents an
 * OpenAI-compatible endpoint from being routed through the Kimi OAuth toolkit
 * by provider-name accident.
 */

import type { OAuthRef } from "#/kosong/provider/provider";

import type { AuthStatus } from "./auth";
import type {
  OAuthFlowSnapshot,
  OAuthFlowStart,
  OAuthLoginCancelResponse,
  OAuthLogoutResponse,
} from "./oauthProtocol";

export type ProviderAuthKind =
  | "api-key"
  | "kimi-device-oauth"
  | "external-oauth";

export type ExternalProviderAuthIntegration =
  | "opencode"
  | "openai-codex"
  | "github-copilot";

export interface ProviderTokenProvider {
  /**
   * Resolve a token for an outbound request. Official SDK adapters may refresh
   * it when `force` is true (or when their SDK requires it).
   */
  getAccessToken(options?: {
    readonly force?: boolean | undefined;
  }): Promise<string>;
  /**
   * Read the adapter's local token cache without starting a login or refresh.
   * This is optional because some official SDKs expose only a request-time
   * token provider; readiness checks must not manufacture a protocol for them.
   */
  getCachedAccessToken?(): Promise<string | undefined>;
  /**
   * Optional per-request headers for provider-owned OAuth (for example Codex
   * org subscriptions need `ChatGPT-Account-Id`).
   */
  getRequestHeaders?(): Promise<Record<string, string> | undefined>;
}

/**
 * Adapter contract implemented by an optional official provider integration.
 * The adapter owns the provider-specific OAuth/browser/device protocol and
 * token storage; the core only dispatches the auth lifecycle and returns the
 * existing auth wire contract.
 */
export interface ProviderAuthAdapter {
  readonly integration: ExternalProviderAuthIntegration;
  startLogin(providerId: string): Promise<OAuthFlowStart>;
  getFlow?(providerId: string): OAuthFlowSnapshot | undefined;
  cancelLogin?(providerId: string): Promise<OAuthLoginCancelResponse>;
  logout?(providerId: string): Promise<OAuthLogoutResponse>;
  status?(providerId: string): Promise<AuthStatus>;
  resolveTokenProvider?(
    providerId: string,
    oauthRef?: OAuthRef,
  ): ProviderTokenProvider | undefined;
  getCachedAccessToken?(
    providerId: string,
    oauthRef?: OAuthRef,
  ): Promise<string | undefined>;
}

export interface ProviderAuthIntegration {
  readonly providerId: string;
  readonly kind: ProviderAuthKind;
  readonly displayName: string;
  /** Upstream integration boundary, when authentication is owned externally. */
  readonly integration?: ExternalProviderAuthIntegration;
  /** Ordered environment names for API-key auth (first non-empty wins). */
  readonly apiKeyEnv?: string | readonly string[];
}

const integrations = new Map<string, ProviderAuthIntegration>([
  [
    "managed:kimi-code",
    {
      providerId: "managed:kimi-code",
      kind: "kimi-device-oauth",
      displayName: "Kimi Code",
    },
  ],
  [
    "kimi",
    {
      providerId: "kimi",
      kind: "kimi-device-oauth",
      displayName: "Kimi Code",
    },
  ],
  [
    "opencode",
    {
      providerId: "opencode",
      kind: "external-oauth",
      displayName: "OpenCode Zen",
      integration: "opencode",
      apiKeyEnv: ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
    },
  ],
  [
    "opencode-go",
    {
      providerId: "opencode-go",
      kind: "external-oauth",
      displayName: "OpenCode Go",
      integration: "opencode",
      apiKeyEnv: ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
    },
  ],
  [
    "openai",
    {
      providerId: "openai",
      kind: "external-oauth",
      displayName: "OpenAI Codex",
      integration: "openai-codex",
      apiKeyEnv: "OPENAI_API_KEY",
    },
  ],
  [
    "openai_responses",
    {
      providerId: "openai_responses",
      kind: "external-oauth",
      displayName: "OpenAI Codex",
      integration: "openai-codex",
      apiKeyEnv: "OPENAI_API_KEY",
    },
  ],
  [
    "github-copilot",
    {
      providerId: "github-copilot",
      kind: "external-oauth",
      displayName: "GitHub Copilot",
      integration: "github-copilot",
      apiKeyEnv: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
    },
  ],
]);

const adapters = new Map<
  ExternalProviderAuthIntegration,
  ProviderAuthAdapter
>();

/** Register an auth owner at the integration boundary (for example, an
 * optional Codex or Copilot SDK adapter). Transport code must not own this. */
export function registerProviderAuthIntegration(
  integration: ProviderAuthIntegration,
): void {
  if (integrations.has(integration.providerId)) {
    throw new Error(
      `provider auth integration '${integration.providerId}' is already registered`,
    );
  }
  integrations.set(integration.providerId, integration);
}

export function getProviderAuthIntegration(
  providerId: string,
  providerType?: string,
): ProviderAuthIntegration | undefined {
  const direct = integrations.get(providerId);
  if (direct !== undefined) return direct;
  return providerType === undefined ? undefined : integrations.get(providerType);
}

/**
 * Inject an optional provider-auth adapter. The returned disposer is intended
 * for host teardown and tests; it removes only the adapter instance that was
 * registered by this call.
 */
export function registerProviderAuthAdapter(
  adapter: ProviderAuthAdapter,
): () => void {
  if (adapters.has(adapter.integration)) {
    throw new Error(
      `provider auth adapter '${adapter.integration}' is already registered`,
    );
  }
  adapters.set(adapter.integration, adapter);
  return () => {
    if (adapters.get(adapter.integration) === adapter) {
      adapters.delete(adapter.integration);
    }
  };
}

export function getProviderAuthAdapter(
  providerId: string,
  providerType?: string,
): ProviderAuthAdapter | undefined {
  const integration = getProviderAuthIntegration(providerId, providerType)?.integration;
  return integration === undefined ? undefined : adapters.get(integration);
}

export function listProviderAuthAdapters(): readonly ProviderAuthAdapter[] {
  return [...adapters.values()];
}

export function listProviderAuthIntegrations(): readonly ProviderAuthIntegration[] {
  return [...integrations.values()];
}

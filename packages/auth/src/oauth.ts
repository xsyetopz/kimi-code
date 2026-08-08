import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Credential } from "./types";

export interface OAuthProvider {
  readonly id: string;
  readonly label: string;
  beginLogin(): Promise<{ authorizeUrl: string; state: string }>;
  finishLogin(code: string, state: string): Promise<Credential>;
}

interface PkceConfig {
  readonly providerId: string;
  readonly clientIdEnv: string;
  readonly defaultClientId?: string;
  readonly authorizeEndpoint: string;
  readonly tokenEndpoint: string;
  readonly scope: string;
  readonly redirectUri: string;
}

interface PendingPkce {
  readonly verifier: string;
  readonly config: PkceConfig;
}

const pending = new Map<string, PendingPkce>();

function clientId(config: PkceConfig): string {
  const value = process.env[config.clientIdEnv] ?? config.defaultClientId;
  if (!value) {
    throw new Error(`Set ${config.clientIdEnv} before starting OAuth login`);
  }
  return value;
}

export function beginPkceLogin(config: PkceConfig): {
  authorizeUrl: string;
  state: string;
} {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomUUID();
  pending.set(state, { verifier, config });
  const params = new URLSearchParams({
    client_id: clientId(config),
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: config.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return { authorizeUrl: `${config.authorizeEndpoint}?${params}`, state };
}

export async function finishPkceLogin(
  providerId: string,
  code: string,
  state: string,
): Promise<Credential> {
  const entry = pending.get(state);
  if (!entry || entry.config.providerId !== providerId) {
    throw new Error("Invalid or expired OAuth state");
  }
  pending.delete(state);
  const response = await fetch(entry.config.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId(entry.config),
      redirect_uri: entry.config.redirectUri,
      code_verifier: entry.verifier,
    }),
  });
  if (!response.ok) {
    throw new Error(`OAuth token exchange failed (${response.status})`);
  }
  const body: unknown = await response.json();
  if (!body || typeof body !== "object") {
    throw new Error("OAuth token response was not an object");
  }
  const data = body as Record<string, unknown>;
  if (typeof data["access_token"] !== "string") {
    throw new Error("OAuth token response did not include access_token");
  }
  const credential: {
    providerId: string;
    kind: "oauth";
    accessToken: string;
    refreshToken?: string;
    expiresAt?: string;
  } = {
    providerId,
    kind: "oauth",
    accessToken: data["access_token"],
  };
  if (typeof data["refresh_token"] === "string") {
    credential.refreshToken = data["refresh_token"];
  }
  if (typeof data["expires_in"] === "number") {
    credential.expiresAt = new Date(
      Date.now() + data["expires_in"] * 1000,
    ).toISOString();
  }
  return credential;
}

export const OAUTH_PROVIDER_IDS = [
  "openai-codex",
  "google-gemini",
  "xai",
  "openrouter",
  "moonshot",
] as const;

export type OAuthProviderId = (typeof OAUTH_PROVIDER_IDS)[number];

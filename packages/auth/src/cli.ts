import {
  envVarForProvider,
  loadCredentials,
  removeCredential,
  resolveApiKey,
  setApiKey,
  setOAuthCredential,
} from "./credentials";
import { getOAuthProvider, listOAuthProviders } from "./providers";
import type { AuthStatus } from "./types";

const API_KEY_PROVIDER_IDS = ["xai", "openrouter", "moonshot"] as const;

export interface LoginOptions {
  readonly apiKey?: string;
  readonly code?: string;
  readonly state?: string;
  readonly path?: string;
}

export interface LoginResult {
  readonly providerId: string;
  readonly kind: "api_key" | "oauth";
  readonly authorizeUrl?: string;
  readonly state?: string;
  readonly message: string;
}

export async function loginProvider(
  providerId: string,
  options: LoginOptions = {},
): Promise<LoginResult> {
  const path = options.path;

  if (isApiKeyProvider(providerId)) {
    const apiKey = options.apiKey ?? envVarForProvider(providerId);
    if (!apiKey) {
      throw new Error(
        `API key required for ${providerId}. Pass apiKey or set ${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY.`,
      );
    }
    await setApiKey(providerId, apiKey, path);
    return {
      providerId,
      kind: "api_key",
      message: `Stored API key for ${providerId}.`,
    };
  }

  const provider = getOAuthProvider(providerId);
  if (!provider) {
    throw new Error(`Unknown auth provider: ${providerId}`);
  }

  if (options.code) {
    const state = options.state ?? "";
    const credential = await provider.finishLogin(options.code, state);
    await setOAuthCredential(credential, path);
    return {
      providerId,
      kind: "oauth",
      message: `OAuth login completed for ${provider.label}.`,
    };
  }

  const { authorizeUrl, state } = await provider.beginLogin();
  return {
    providerId,
    kind: "oauth",
    authorizeUrl,
    state,
    message: `Open ${authorizeUrl} to authorize ${provider.label}, then call loginProvider with code and state.`,
  };
}

export async function logoutProvider(
  providerId: string,
  path?: string,
): Promise<void> {
  await removeCredential(providerId, path);
}

export async function listAuthStatus(path?: string): Promise<AuthStatus[]> {
  const credentials = await loadCredentials(path);
  const statuses: AuthStatus[] = [];

  for (const provider of listOAuthProviders()) {
    const cred = credentials.find((c) => c.providerId === provider.id);
    const configured =
      resolveApiKey(credentials, provider.id) !== undefined ||
      cred?.kind === "oauth";

    const status: AuthStatus = {
      providerId: provider.id,
      label: provider.label,
      kind: cred?.kind ?? (configured ? "api_key" : "none"),
      configured,
    };
    if (cred?.expiresAt !== undefined) {
      statuses.push({ ...status, expiresAt: cred.expiresAt });
    } else {
      statuses.push(status);
    }
  }

  return statuses;
}

function isApiKeyProvider(
  providerId: string,
): providerId is (typeof API_KEY_PROVIDER_IDS)[number] {
  return (API_KEY_PROVIDER_IDS as readonly string[]).includes(providerId);
}

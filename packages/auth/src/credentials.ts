import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { Credential } from "./types";

export function defaultCredentialPath(): string {
  return join(homedir(), ".kimi-next", "credentials.json");
}

export async function loadCredentials(
  path = defaultCredentialPath(),
): Promise<Credential[]> {
  try {
    const raw = await readFile(path, "utf8");
    const json: unknown = JSON.parse(raw);
    if (!Array.isArray(json)) return [];
    return json.filter(isCredential);
  } catch {
    return [];
  }
}

export async function saveCredentials(
  credentials: readonly Credential[],
  path = defaultCredentialPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(credentials, null, 2)}\n`, "utf8");
}

export async function setApiKey(
  providerId: string,
  apiKey: string,
  path = defaultCredentialPath(),
): Promise<void> {
  const all = await loadCredentials(path);
  const next = all.filter((c) => c.providerId !== providerId);
  next.push({ providerId, kind: "api_key", apiKey });
  await saveCredentials(next, path);
}

export async function removeCredential(
  providerId: string,
  path = defaultCredentialPath(),
): Promise<void> {
  const all = await loadCredentials(path);
  const next = all.filter((c) => c.providerId !== providerId);
  await saveCredentials(next, path);
}

export async function setOAuthCredential(
  credential: Credential,
  path = defaultCredentialPath(),
): Promise<void> {
  const all = await loadCredentials(path);
  const next = all.filter((c) => c.providerId !== credential.providerId);
  next.push(credential);
  await saveCredentials(next, path);
}

export function resolveApiKey(
  credentials: readonly Credential[],
  providerId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const fromEnv = envVarForProvider(providerId, env);
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  const cred = credentials.find((c) => c.providerId === providerId);
  if (cred?.kind === "api_key" && cred.apiKey) return cred.apiKey;
  if (cred?.kind === "oauth" && cred.accessToken) return cred.accessToken;
  return undefined;
}

export function envVarForProvider(
  providerId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const specific = env[`${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`];
  if (typeof specific === "string" && specific.length > 0) {
    return specific;
  }

  switch (providerId) {
    case "openai":
    case "openai-codex":
      return env["OPENAI_API_KEY"];
    case "anthropic":
      return env["ANTHROPIC_API_KEY"];
    case "moonshot":
      return env["MOONSHOT_API_KEY"];
    case "google-gemini":
      return env["GEMINI_API_KEY"] ?? env["GOOGLE_API_KEY"];
    case "xai":
      return env["XAI_API_KEY"];
    case "openrouter":
      return env["OPENROUTER_API_KEY"];
    default:
      return undefined;
  }
}

export function isCredential(value: unknown): value is Credential {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["providerId"] === "string" &&
    (v["kind"] === "api_key" || v["kind"] === "oauth")
  );
}

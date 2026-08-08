import type { OAuthProvider } from "../oauth";
import { googleGeminiProvider } from "./google-gemini";
import { moonshotProvider } from "./moonshot";
import { openaiCodexProvider } from "./openai-codex";
import { openrouterProvider } from "./openrouter";
import { xaiProvider } from "./xai";

const PROVIDERS: ReadonlyMap<string, OAuthProvider> = new Map([
  [openaiCodexProvider.id, openaiCodexProvider],
  [googleGeminiProvider.id, googleGeminiProvider],
  [xaiProvider.id, xaiProvider],
  [openrouterProvider.id, openrouterProvider],
  [moonshotProvider.id, moonshotProvider],
]);

export function getOAuthProvider(id: string): OAuthProvider | undefined {
  return PROVIDERS.get(id);
}

export function listOAuthProviders(): readonly OAuthProvider[] {
  return [...PROVIDERS.values()];
}

export {
  googleGeminiProvider,
  moonshotProvider,
  openaiCodexProvider,
  openrouterProvider,
  xaiProvider,
};

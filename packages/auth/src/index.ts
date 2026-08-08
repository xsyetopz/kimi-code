export type { AuthKind, AuthStatus, Credential } from "./types";
export {
  defaultCredentialPath,
  envVarForProvider,
  isCredential,
  loadCredentials,
  removeCredential,
  resolveApiKey,
  saveCredentials,
  setApiKey,
  setOAuthCredential,
} from "./credentials";
export type { OAuthProvider, OAuthProviderId } from "./oauth";
export { OAUTH_PROVIDER_IDS } from "./oauth";
export {
  getOAuthProvider,
  googleGeminiProvider,
  listOAuthProviders,
  moonshotProvider,
  openaiCodexProvider,
  openrouterProvider,
  xaiProvider,
} from "./providers";
export {
  MOONSHOT_API_KEY_ENV,
} from "./providers/moonshot";
export {
  OPENROUTER_API_KEY_ENV,
} from "./providers/openrouter";
export {
  XAI_API_KEY_ENV,
} from "./providers/xai";
export type { LoginOptions, LoginResult } from "./cli";
export { listAuthStatus, loginProvider, logoutProvider } from "./cli";

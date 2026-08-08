import { beginPkceLogin, finishPkceLogin, type OAuthProvider } from "../oauth";

export const openaiCodexProvider: OAuthProvider = {
  id: "openai-codex",
  label: "OpenAI Codex",

  async beginLogin() {
    return beginPkceLogin({
      providerId: "openai-codex",
      clientIdEnv: "KIMI_NEXT_OPENAI_CODEX_CLIENT_ID",
      authorizeEndpoint: "https://auth.openai.com/authorize",
      tokenEndpoint: "https://auth.openai.com/oauth/token",
      scope: "openid profile email offline_access",
      redirectUri: "http://localhost:1455/auth/callback",
    });
  },

  async finishLogin(code, state) {
    return finishPkceLogin("openai-codex", code, state);
  },
};

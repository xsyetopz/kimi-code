import { beginPkceLogin, finishPkceLogin, type OAuthProvider } from "../oauth";

export const googleGeminiProvider: OAuthProvider = {
  id: "google-gemini",
  label: "Google Gemini",

  async beginLogin() {
    return beginPkceLogin({
      providerId: "google-gemini",
      clientIdEnv: "KIMI_NEXT_GOOGLE_GEMINI_CLIENT_ID",
      authorizeEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      scope:
        "openid profile email https://www.googleapis.com/auth/generative-language",
      redirectUri: "http://localhost:43817/oauth2callback",
    });
  },

  async finishLogin(code, state) {
    return finishPkceLogin("google-gemini", code, state);
  },
};

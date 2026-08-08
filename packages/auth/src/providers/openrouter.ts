import type { OAuthProvider } from "../oauth";

export const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";

export const openrouterProvider: OAuthProvider = {
  id: "openrouter",
  label: "OpenRouter",

  async beginLogin() {
    throw new Error("OpenRouter uses API key login; pass an API key instead");
  },

  async finishLogin() {
    throw new Error("OpenRouter uses API key login; pass an API key instead");
  },
};

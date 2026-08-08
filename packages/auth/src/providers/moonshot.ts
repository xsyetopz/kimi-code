import type { OAuthProvider } from "../oauth";

export const MOONSHOT_API_KEY_ENV = "MOONSHOT_API_KEY";

export const moonshotProvider: OAuthProvider = {
  id: "moonshot",
  label: "Moonshot",

  async beginLogin() {
    throw new Error("Moonshot uses API key login; pass an API key instead");
  },

  async finishLogin() {
    throw new Error("Moonshot uses API key login; pass an API key instead");
  },
};

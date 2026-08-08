import type { OAuthProvider } from "../oauth";

export const XAI_API_KEY_ENV = "XAI_API_KEY";

export const xaiProvider: OAuthProvider = {
  id: "xai",
  label: "xAI",

  async beginLogin() {
    throw new Error("xAI uses API key login; pass an API key instead");
  },

  async finishLogin() {
    throw new Error("xAI uses API key login; pass an API key instead");
  },
};

/**
 * `kosong/provider` domain — side-effect registrations for standard provider
 * transports and their endpoint/auth environment declarations.
 *
 * Like every contribution module, this file is imported for effect only.
 */

import { registerProviderDefinition } from "../providerDefinition";

registerProviderDefinition({
  id: "anthropic",
  baseProtocol: "anthropic",
  traits: [],
  endpoint: {
    apiKeyEnv: "ANTHROPIC_API_KEY",
    baseUrlEnv: "ANTHROPIC_BASE_URL",
  },
});

registerProviderDefinition({
  id: "openai",
  baseProtocol: "openai",
  traits: [],
  endpoint: { apiKeyEnv: "OPENAI_API_KEY", baseUrlEnv: "OPENAI_BASE_URL" },
});

// OpenCode Zen speaks the OpenAI Chat Completions protocol. OpenCode's
// account flow can provide either an OAuth bearer token or a copied API key;
// Zen Free is a zero-cost model tier within this provider, not a separate
// provider/auth owner. The public credential keeps that tier available
// without login.
registerProviderDefinition({
  id: "opencode",
  baseProtocol: "openai",
  // The endpoint is repeated as a construction-time trait because the
  // OpenAI base consumes endpoint declarations through composed traits. The
  // definition-level copy remains the provider registry's introspection and
  // env-bag resolution source of truth.
  traits: [
    {
      endpoint: () => ({
        apiKeyEnv: ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
        defaultApiKey: "public",
        defaultBaseUrl: "https://opencode.ai/zen/v1",
      }),
    },
  ],
  endpoint: {
    apiKeyEnv: ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
    defaultApiKey: "public",
    defaultBaseUrl: "https://opencode.ai/zen/v1",
  },
});

// OpenCode Go is a distinct subscription/catalog endpoint. It shares the
// OpenCode account/API-key boundary but must not be collapsed into Zen because
// model availability and billing are selected by the URL. It has no public
// Zen-Free fallback.
registerProviderDefinition({
  id: "opencode-go",
  baseProtocol: "openai",
  traits: [
    {
      endpoint: () => ({
        apiKeyEnv: ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
        defaultBaseUrl: "https://opencode.ai/zen/go/v1",
      }),
    },
  ],
  endpoint: {
    apiKeyEnv: ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
    defaultBaseUrl: "https://opencode.ai/zen/go/v1",
  },
});

// GitHub Copilot's OpenAI-compatible endpoint is authenticated with a GitHub
// token. The Copilot login/runtime boundary stays outside the kosong layer.
registerProviderDefinition({
  id: "github-copilot",
  baseProtocol: "openai",
  traits: [
    {
      endpoint: () => ({
        apiKeyEnv: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
        defaultBaseUrl: "https://api.githubcopilot.com",
      }),
    },
  ],
  endpoint: {
    apiKeyEnv: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
    defaultBaseUrl: "https://api.githubcopilot.com",
  },
});

registerProviderDefinition({
  id: "openai_responses",
  baseProtocol: "openai_responses",
  traits: [],
  endpoint: { apiKeyEnv: "OPENAI_API_KEY", baseUrlEnv: "OPENAI_BASE_URL" },
});

registerProviderDefinition({
  id: "google-genai",
  baseProtocol: "google-genai",
  traits: [
    {
      endpoint: () => ({
        apiKeyEnv: "VERTEXAI_API_KEY",
        baseUrlEnv: "GOOGLE_VERTEX_BASE_URL",
      }),
    },
    {
      endpoint: () => ({
        apiKeyEnv: "GOOGLE_API_KEY",
        baseUrlEnv: "GOOGLE_GEMINI_BASE_URL",
      }),
    },
  ],
});

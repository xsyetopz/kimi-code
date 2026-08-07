import type { CatalogProviderEntry } from "./catalog";
import type { ProviderType } from "./providers";
import type {
  ModelProtocolProfile,
  ProviderTransportProfile,
} from "./protocol";
import {
  ANTHROPIC_PROTOCOL_PROFILE,
  DEEPSEEK_PROTOCOL_PROFILE,
  GEMINI_PROTOCOL_PROFILE,
  KIMI_K2_PROTOCOL_PROFILE,
  KIMI_K3_PROTOCOL_PROFILE,
  MINIMAX_PROTOCOL_PROFILE,
  OPENAI_CHAT_PROTOCOL_PROFILE,
  OPENAI_RESPONSES_PROTOCOL_PROFILE,
  TRANSPORT_PROFILE_BY_WIRE,
} from "./protocol/presets";

const OPENAI_MODEL_RE = /^(?:gpt-|o[134](?:-|$)|chatgpt-|codex)/;
const CLAUDE_MODEL_RE = /\bclaude\b/;
const GEMINI_MODEL_RE = /\bgemini[-/]/;
const KIMI_K3_MODEL_RE = /\bk3(?:[-_.]|$)|\bkimi-k3\b/;
const KIMI_MODEL_RE = /\bkimi\b|moonshot/;
const DEEPSEEK_MODEL_RE = /\bdeepseek\b/;
const MINIMAX_MODEL_RE = /\bminimax\b|\babab\d/;

function normalizedModelId(modelId: string): string {
  return modelId.trim().toLowerCase();
}

function normalizedProviderKey(providerId: string | undefined): string {
  return (providerId ?? "").trim().toLowerCase();
}

function isOpenAiGptModel(modelId: string): boolean {
  const normalized = normalizedModelId(modelId);
  const base = normalized.includes("/")
    ? (normalized.split("/").pop() ?? normalized)
    : normalized;
  return OPENAI_MODEL_RE.test(base);
}

/** Resolve a declarative protocol profile for a catalog model when not pinned on the entry. */
export function resolveModelProtocolProfile(
  modelId: string,
  wire: ProviderType | undefined,
  explicit?: ModelProtocolProfile,
  providerId?: string,
  protocol?: "anthropic",
): ModelProtocolProfile | undefined {
  if (explicit !== undefined) return explicit;

  const providerKey = normalizedProviderKey(providerId);
  const model = normalizedModelId(modelId);

  if (DEEPSEEK_MODEL_RE.test(model) || providerKey.includes("deepseek")) {
    return DEEPSEEK_PROTOCOL_PROFILE;
  }
  if (MINIMAX_MODEL_RE.test(model) || providerKey.includes("minimax")) {
    return MINIMAX_PROTOCOL_PROFILE;
  }
  if (KIMI_K3_MODEL_RE.test(model)) {
    return KIMI_K3_PROTOCOL_PROFILE;
  }
  if (
    wire === "kimi" ||
    KIMI_MODEL_RE.test(model) ||
    providerKey.includes("moonshot") ||
    providerKey.includes("kimi")
  ) {
    return KIMI_K2_PROTOCOL_PROFILE;
  }
  if (
    protocol === "anthropic" ||
    wire === "anthropic" ||
    CLAUDE_MODEL_RE.test(model) ||
    providerKey.includes("anthropic")
  ) {
    return ANTHROPIC_PROTOCOL_PROFILE;
  }
  if (
    wire === "google-genai" ||
    wire === "vertexai" ||
    GEMINI_MODEL_RE.test(model) ||
    providerKey.includes("gemini") ||
    providerKey.includes("google")
  ) {
    return GEMINI_PROTOCOL_PROFILE;
  }
  if (wire === "openai_responses" && isOpenAiGptModel(modelId)) {
    return OPENAI_RESPONSES_PROTOCOL_PROFILE;
  }
  if (
    wire === "openai" ||
    wire === "openai_responses" ||
    isOpenAiGptModel(modelId) ||
    providerKey.includes("openai")
  ) {
    return wire === "openai_responses"
      ? OPENAI_RESPONSES_PROTOCOL_PROFILE
      : OPENAI_CHAT_PROTOCOL_PROFILE;
  }
  if (wire === "openai_responses") {
    return OPENAI_RESPONSES_PROTOCOL_PROFILE;
  }
  if (wire === "openai") {
    return OPENAI_CHAT_PROTOCOL_PROFILE;
  }
  if (wire === "anthropic") {
    return ANTHROPIC_PROTOCOL_PROFILE;
  }
  if (wire === "google-genai" || wire === "vertexai") {
    return GEMINI_PROTOCOL_PROFILE;
  }
  if (wire === "kimi") {
    return KIMI_K2_PROTOCOL_PROFILE;
  }
  return undefined;
}

/** Resolve transport/auth metadata for a catalog provider when not pinned on the entry. */
export function resolveProviderTransportProfile(
  entry: CatalogProviderEntry,
  wire: ProviderType | undefined,
): ProviderTransportProfile | undefined {
  if (entry.transportProfile !== undefined) return entry.transportProfile;
  if (wire === undefined) return undefined;
  return TRANSPORT_PROFILE_BY_WIRE[wire];
}

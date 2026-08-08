/**
 * Multi-model design/review panel via OpenRouter chat completions.
 * Practical seatbelt: diverse opinions on a scoped artifact — not a benchmark farm.
 */

export interface ReviewPanelMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface ReviewPanelOpinion {
  readonly model: string;
  readonly text: string;
  readonly error?: string;
}

export interface ReviewPanelOptions {
  readonly models: readonly string[];
  readonly messages: readonly ReviewPanelMessage[];
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
}

const DEFAULT_BASE = "https://openrouter.ai/api/v1";

async function oneOpinion(
  model: string,
  options: ReviewPanelOptions,
): Promise<ReviewPanelOpinion> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = (options.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
  try {
    const init: {
      method: string;
      headers: { Authorization: string; "Content-Type": string };
      body: string;
      signal?: AbortSignal;
    } = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: options.messages,
        temperature: 0.2,
      }),
    };
    if (options.signal !== undefined) init.signal = options.signal;
    const response = await fetchImpl(`${base}/chat/completions`, init);    if (!response.ok) {
      return {
        model,
        text: "",
        error: `HTTP ${response.status} ${response.statusText}`,
      };
    }
    const json: unknown = await response.json();
    const record = json && typeof json === "object" ? (json as Record<string, unknown>) : null;
    const choices = record && Array.isArray(record["choices"]) ? record["choices"] : [];
    const first = choices[0];
    const message =
      first && typeof first === "object"
        ? (first as Record<string, unknown>)["message"]
        : undefined;
    const content =
      message && typeof message === "object"
        ? (message as Record<string, unknown>)["content"]
        : undefined;
    return {
      model,
      text: typeof content === "string" ? content : JSON.stringify(content ?? ""),
    };
  } catch (error) {
    return {
      model,
      text: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Concurrently query several models; returns one opinion per model. */
export async function runReviewPanel(
  options: ReviewPanelOptions,
): Promise<readonly ReviewPanelOpinion[]> {
  if (options.models.length === 0) return [];
  return Promise.all(options.models.map((model) => oneOpinion(model, options)));
}

export function formatReviewPanel(
  opinions: readonly ReviewPanelOpinion[],
): string {
  if (opinions.length === 0) return "No review models configured.";
  return opinions
    .map((opinion) => {
      if (opinion.error) {
        return `## ${opinion.model}\n\nERROR: ${opinion.error}`;
      }
      return `## ${opinion.model}\n\n${opinion.text.trim()}`;
    })
    .join("\n\n");
}

/** Parse `KIMI_REVIEW_MODELS=a,b,c` (OpenRouter model ids). */
export function parseReviewModels(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  createFakeProviderHarness,
  type FakeProviderHarness,
} from "../../kosong/test/e2e/fake-provider-harness";

export interface FakeProviderCall {
  readonly systemPrompt: string;
  readonly history: unknown;
  readonly headers: Record<string, string>;
}

export const fakeProviderState = {
  calls: [] as FakeProviderCall[],
  responseText: "hello from fake provider",
  responseQueue: [] as string[],
};

const activeHarnesses: FakeProviderHarness[] = [];

export async function startFakeProviderHarness(): Promise<FakeProviderHarness> {
  const harness = await createFakeProviderHarness();
  activeHarnesses.push(harness);

  harness.route("POST", "/v1/chat/completions", async (request, reply) => {
    const body = request.bodyJson as Record<string, unknown>;
    const messages = Array.isArray(body["messages"])
      ? (body["messages"] as ReadonlyArray<Record<string, unknown>>)
      : [];
    const systemMessage = messages.find((message) => message["role"] === "system");
    const systemContent = systemMessage?.["content"];
    const systemPrompt =
      typeof systemContent === "string"
        ? systemContent
        : JSON.stringify(systemContent ?? "");
    const history = messages.filter((message) => message["role"] !== "system");

    fakeProviderState.calls.push({
      systemPrompt,
      history,
      headers: request.headers,
    });

    const text =
      fakeProviderState.responseQueue.shift() ?? fakeProviderState.responseText;
    await reply.sseJson(200, [
      makeChunk({ content: text }),
      makeChunk(
        {},
        {
          finishReason: "stop",
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
          },
        },
      ),
    ]);
  });

  return harness;
}

export async function closeFakeProviderHarnesses(): Promise<void> {
  while (activeHarnesses.length > 0) {
    const harness = activeHarnesses.pop();
    if (harness !== undefined) {
      await harness.close();
    }
  }
}

export function resetFakeProviderState(): void {
  fakeProviderState.calls.length = 0;
  fakeProviderState.responseText = "hello from fake provider";
  fakeProviderState.responseQueue.length = 0;
}

export async function configureFakeProvider(
  homeDir: string,
  baseUrl: string,
): Promise<void> {
  await writeFile(
    join(homeDir, "config.toml"),
    `
default_model = "fake-model"

[providers.local]
type = "kimi"
base_url = "${baseUrl}/v1"
api_key = "sk-test"

[models.fake-model]
provider = "local"
model = "fake-model"
max_context_size = 262144
`,
    "utf-8",
  );
}

function makeChunk(
  delta: Record<string, unknown>,
  opts?: {
    readonly finishReason?: string;
    readonly usage?: Record<string, unknown>;
  },
): Record<string, unknown> {
  const chunk: Record<string, unknown> = {
    id: "chatcmpl-fake-1",
    object: "chat.completion.chunk",
    created: 1_234_567_890,
    model: "fake-model",
    choices: [
      {
        index: 0,
        delta,
        finish_reason: opts?.finishReason ?? null,
      },
    ],
  };
  if (opts?.usage !== undefined) {
    chunk["choices"] = [
      {
        index: 0,
        delta,
        finish_reason: opts?.finishReason ?? null,
        usage: opts.usage,
      },
    ];
  }
  return chunk;
}

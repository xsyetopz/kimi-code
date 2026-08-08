import { ClientFactory } from "@a2a-js/sdk/client";

export interface A2aPeer {
  readonly id: string;
  readonly url: string;
}

export interface A2aPeerResult {
  readonly id: string;
  readonly text: string;
}

export interface A2aMessageClient {
  sendMessage(request: unknown): Promise<unknown>;
}

export interface A2aPeerRunnerOptions {
  readonly createClient?: (url: string) => Promise<A2aMessageClient>;
}

function textFromValue(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const status = record["status"];
  if (status && typeof status === "object") {
    const statusMessage = (status as Record<string, unknown>)["message"];
    const statusText = textFromValue(statusMessage);
    if (statusText) return statusText;
  }
  const parts = Array.isArray(record["parts"]) ? record["parts"] : [];
  return parts
    .filter(
      (part): part is Record<string, unknown> =>
        Boolean(part) && typeof part === "object",
    )
    .map((part) => {
      const content = part["content"];
      if (!content || typeof content !== "object") return "";
      const contentRecord = content as Record<string, unknown>;
      return contentRecord["$case"] === "text" &&
        typeof contentRecord["value"] === "string"
        ? contentRecord["value"]
        : "";
    })
    .join("");
}

/** Sends a swarm prompt through the official A2A client transport. */
export function createA2aPeerRunner(
  peers: readonly A2aPeer[],
  options?: A2aPeerRunnerOptions,
) {
  const factory = new ClientFactory();
  const createClient =
    options?.createClient ??
    ((url: string) => factory.createFromUrl(url) as Promise<A2aMessageClient>);
  return async (prompt: string): Promise<readonly A2aPeerResult[]> =>
    Promise.all(
      peers.map(async (peer) => {
        const client = await createClient(peer.url);
        const result = await client.sendMessage({
          message: {
            messageId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
            contextId: undefined,
            taskId: undefined,
            role: 1,
            parts: [{ content: { $case: "text", value: prompt } }],
            metadata: undefined,
            extensions: [],
            referenceTaskIds: [],
          },
          tenant: "",
          configuration: undefined,
          metadata: undefined,
        });
        return { id: peer.id, text: textFromValue(result) };
      }),
    );
}

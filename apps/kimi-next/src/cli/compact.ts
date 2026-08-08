import type { TransportAdapter } from "@kimi-next/adapters";
import {
  applyStreamEvent,
  assembleAssistantTurn,
  createTurnAssembler,
  type Conversation,
} from "@kimi-next/ir";
import type { ModelProfile } from "@kimi-next/model";
import { validateRequest } from "@kimi-next/model";
import type { BuildCompactCheckpointInput } from "@kimi-next/session";

export interface CompactRefineOptions {
  readonly profile: ModelProfile;
  readonly adapter: TransportAdapter;
  readonly draft: BuildCompactCheckpointInput;
  readonly stream: (
    wireBody: unknown,
    signal?: AbortSignal,
  ) => AsyncIterable<unknown>;
  readonly generateId: () => string;
  readonly signal?: AbortSignal;
}

function parseRefinedDraft(text: string): BuildCompactCheckpointInput | null {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const parsed: unknown = JSON.parse(jsonMatch[0]);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const progress =
      typeof record["progress"] === "string" ? record["progress"] : "";
    const validation =
      typeof record["validation"] === "string" ? record["validation"] : "";
    const nextSteps =
      typeof record["nextSteps"] === "string" ? record["nextSteps"] : "";
    const filesRaw = record["filesTouched"];
    const filesTouched = Array.isArray(filesRaw)
      ? filesRaw.filter((f): f is string => typeof f === "string")
      : [];
    if (!progress) return null;
    return { progress, filesTouched, validation, nextSteps };
  } catch {
    return null;
  }
}

export async function refineCompactDraft(
  options: CompactRefineOptions,
): Promise<BuildCompactCheckpointInput> {
  validateRequest({ profile: options.profile, tools: false });

  const prompt = [
    "Refine this session compact checkpoint draft. Return JSON only with keys:",
    "progress, filesTouched (string[]), validation, nextSteps.",
    "",
    JSON.stringify(options.draft, null, 2),
  ].join("\n");

  const conversation: Conversation = [
    {
      kind: "user",
      id: options.generateId(),
      content: [{ type: "text", text: prompt }],
    },
  ];

  const wireBody = options.adapter.serialize({
    model: options.profile.wireModel,
    conversation,
    tools: [],
    system:
      "You refine coding-session checkpoint summaries. Respond with a single JSON object only.",
  });

  const assembler = createTurnAssembler();
  const decoded = options.adapter.decodeStream(
    options.stream(wireBody, options.signal),
  );

  for await (const event of decoded) {
    options.signal?.throwIfAborted();
    applyStreamEvent(assembler, event);
  }

  const turn = assembleAssistantTurn(assembler, options.generateId());
  const text = turn.text.join("");
  return parseRefinedDraft(text) ?? options.draft;
}

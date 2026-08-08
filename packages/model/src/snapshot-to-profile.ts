import type { ReasoningMode } from "@kimi-next/ir";
import type { CatalogSnapshotModel } from "./snapshot-types";
import type { ModelProfile } from "./profile";

export function snapshotModelToProfile(
  entry: CatalogSnapshotModel,
): ModelProfile {
  const isAnthropic = entry.transport === "anthropic";
  const hasReasoning = entry.reasoning;

  const supportedModes: ReasoningMode[] = ["none"];
  if (hasReasoning) {
    if (isAnthropic) {
      supportedModes.push("exposed");
    } else {
      supportedModes.push("opaque");
    }
  }

  let defaultMode: ReasoningMode = "none";
  if (hasReasoning && entry.id === "moonshotai/kimi-k2") {
    defaultMode = "opaque";
  }

  return {
    id: entry.id,
    displayName: entry.displayName,
    wireModel: entry.wireModel,
    transport: entry.transport,
    limits: {
      contextTokens: entry.contextTokens,
      maxOutputTokens: entry.maxOutputTokens,
    },
    capabilities: {
      input: { text: true, images: entry.images },
      output: { text: true, toolCalls: entry.toolCalls },
      tools: { parallel: true, streamingArguments: true },
      reasoning: {
        none: true,
        opaque: hasReasoning && !isAnthropic,
        exposed: hasReasoning && isAnthropic,
      },
      conversation: {
        systemMessage: true,
        toolResults: true,
        alternation: isAnthropic ? "strict" : "flexible",
      },
    },
    reasoning: {
      defaultMode,
      supportedModes,
    },
    replay: replayRulesFor(entry.transport, entry.id),
    parameters: {
      temperature: entry.temperature,
      topP: true,
      maxOutputTokens: true,
      stopSequences: entry.id !== "moonshotai/kimi-k2",
    },
  };
}

function replayRulesFor(
  transport: CatalogSnapshotModel["transport"],
  modelId: string,
): ModelProfile["replay"] {
  if (modelId === "moonshotai/kimi-k2") {
    return {
      requireRawProviderMessage: true,
      requireContinuation: true,
      requireSignatures: false,
    };
  }

  switch (transport) {
    case "anthropic":
    case "gemini":
      return {
        requireRawProviderMessage: true,
        requireContinuation: false,
        requireSignatures: false,
      };
    case "openai-chat":
    case "openai-responses":
      return {
        requireRawProviderMessage: false,
        requireContinuation: false,
        requireSignatures: false,
      };
    default: {
      const _exhaustive: never = transport;
      throw new Error(`Unhandled transport: ${_exhaustive}`);
    }
  }
}

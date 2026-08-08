import { randomUUID } from "node:crypto";

import type {
  AssistantTurn,
  CompactCheckpoint,
  Conversation,
  ToolCall,
} from "@kimi-next/ir";

export interface BuildCompactCheckpointInput {
  readonly progress: string;
  readonly filesTouched: readonly string[];
  readonly validation: string;
  readonly nextSteps: string;
}

export function buildCompactCheckpoint(
  input: BuildCompactCheckpointInput,
): CompactCheckpoint {
  return {
    kind: "compact_checkpoint",
    id: randomUUID(),
    progress: input.progress,
    filesTouched: [...input.filesTouched],
    validation: input.validation,
    nextSteps: input.nextSteps,
    createdAt: new Date().toISOString(),
  };
}

export interface CompactSummarizeHook {
  (
    draft: BuildCompactCheckpointInput,
  ): Promise<BuildCompactCheckpointInput>;
}

export interface BuildCompactFromConversationOptions {
  readonly summarize?: CompactSummarizeHook;
}

function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
}

function pathFromToolCall(call: ToolCall): string | undefined {
  const args = parseToolArgs(call.arguments);
  const path = args["path"];
  return typeof path === "string" && path.length > 0 ? path : undefined;
}

function collectFilesTouched(archive: Conversation): string[] {
  const files = new Set<string>();
  const fileTools = new Set(["read", "write", "edit", "glob", "grep"]);

  for (const record of archive) {
    if (record.kind !== "assistant") continue;
    for (const call of record.toolCalls) {
      if (!fileTools.has(call.name) && call.name !== "command_run") continue;
      if (call.name === "command_run") {
        const args = parseToolArgs(call.arguments);
        const steps = args["steps"];
        if (!Array.isArray(steps)) continue;
        for (const step of steps) {
          if (!step || typeof step !== "object") continue;
          const path = (step as Record<string, unknown>)["path"];
          if (typeof path === "string" && path.length > 0) {
            files.add(path);
          }
        }
        continue;
      }
      const path = pathFromToolCall(call);
      if (path) files.add(path);
    }
  }
  return [...files];
}

function lastAssistantText(archive: Conversation): string {
  for (let i = archive.length - 1; i >= 0; i--) {
    const record = archive[i];
    if (record?.kind === "assistant") {
      const text = (record as AssistantTurn).text.join("").trim();
      if (text.length > 0) return text;
    }
  }
  return "No assistant progress recorded yet.";
}

function validationHeuristic(archive: Conversation): string {
  let errors = 0;
  let tools = 0;
  for (const record of archive) {
    if (record.kind === "tool_result") {
      tools += 1;
      if (record.isError) errors += 1;
    }
  }
  if (tools === 0) return "No tool results yet";
  if (errors === 0) return `All ${tools} tool result(s) succeeded`;
  return `${errors} of ${tools} tool result(s) failed`;
}

function nextStepsHeuristic(archive: Conversation): string {
  for (let i = archive.length - 1; i >= 0; i--) {
    const record = archive[i];
    if (record?.kind === "user") {
      const text = record.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
        .trim();
      if (text.length > 0) {
        return `Continue from last user request: ${text.slice(0, 200)}`;
      }
    }
  }
  return "Continue from checkpoint";
}

function buildHeuristicDraft(archive: Conversation): BuildCompactCheckpointInput {
  return {
    progress: lastAssistantText(archive),
    filesTouched: collectFilesTouched(archive),
    validation: validationHeuristic(archive),
    nextSteps: nextStepsHeuristic(archive),
  };
}

export async function buildCompactCheckpointFromConversation(
  archive: Conversation,
  options?: BuildCompactFromConversationOptions,
): Promise<CompactCheckpoint> {
  let draft = buildHeuristicDraft(archive);
  if (options?.summarize) {
    draft = await options.summarize(draft);
  }
  return buildCompactCheckpoint(draft);
}

export function applyCompact(
  archive: Conversation,
  checkpoint: CompactCheckpoint,
): Conversation {
  return [...archive, checkpoint];
}

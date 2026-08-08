import { readFile } from "node:fs/promises";
import type { AgentHooks, HookDecision } from "@kimi-next/agent";
import type { ToolCall, ToolResult, UserMessage } from "@kimi-next/ir";
import {
  loadHooks,
  resolveInstructionFile,
  type HookEntry,
  type HookEvent,
} from "@kimi-next/discover";
import { runCommand } from "@kimi-next/exec";

interface HookInput {
  readonly event: HookEvent;
  readonly [key: string]: unknown;
}

async function invoke(
  entry: HookEntry | undefined,
  cwd: string,
  input: HookInput,
): Promise<{ readonly code: number; readonly stdout: string }> {
  if (!entry) return { code: 0, stdout: "" };
  const result = await runCommand("sh", ["-c", entry.command], {
    cwd,
    env: { KIMI_HOOK_INPUT: JSON.stringify(input) },
  });
  return { code: result.code, stdout: result.stdout };
}

function decisionFromResult(
  result: { readonly code: number; readonly stdout: string },
): HookDecision {
  if (result.code !== 0) {
    return { action: "deny", reason: "PreToolUse hook failed" };
  }
  try {
    const parsed: unknown = JSON.parse(result.stdout.trim());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (record["action"] === "deny") {
        return {
          action: "deny",
          reason:
            typeof record["reason"] === "string"
              ? record["reason"]
              : "Denied by PreToolUse hook",
        };
      }
      if (
        record["action"] === "modify" &&
        typeof record["arguments"] === "string"
      ) {
        return { action: "modify", arguments: record["arguments"] };
      }
      if (record["action"] === "allow") return { action: "allow" };
    }
  } catch {
    // Non-JSON hook output means allow.
  }
  return { action: "allow" };
}

export interface HookHost {
  readonly hooks: AgentHooks;
  readonly instructionPrompt?: string;
}

async function safeInvoke(
  entry: HookEntry | undefined,
  cwd: string,
  input: HookInput,
): Promise<{ readonly code: number; readonly stdout: string }> {
  try {
    return await invoke(entry, cwd, input);
  } catch {
    return { code: 1, stdout: "" };
  }
}

export async function createHookHost(cwd: string): Promise<HookHost> {
  const registry = await loadHooks(cwd);
  const instruction = await resolveInstructionFile(cwd);
  const instructionPrompt = instruction
    ? await readFile(instruction.path, "utf8")
    : undefined;
  let sessionStarted = false;
  const run = (event: HookEvent, payload: Record<string, unknown>) =>
    safeInvoke(registry.hooks.get(event), cwd, { event, ...payload });

  const hooks: AgentHooks = {
    sessionStart: async () => {
      if (sessionStarted) return;
      sessionStarted = true;
      await run("SessionStart", { cwd });
    },
    userPromptSubmit: async (message: UserMessage) => {
      await run("UserPromptSubmit", { message });
    },
    preToolUse: async (call: ToolCall) =>
      decisionFromResult(await run("PreToolUse", { call })),
    postToolUse: async (call: ToolCall, result: ToolResult) => {
      await run("PostToolUse", { call, result });
    },
    preCompact: async (context) => {
      await run("PreCompact", { context });
    },
  };
  if (instructionPrompt === undefined) return { hooks };
  return { hooks, instructionPrompt };
}

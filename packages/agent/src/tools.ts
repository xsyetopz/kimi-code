import { editFile, readFile, runCommand, writeFile } from "@kimi-next/exec";
import type { ToolCall, ToolDefinition, ToolResult } from "@kimi-next/ir";
import { resolveModel } from "@kimi-next/model";
import { executeMacroSteps, formatMacroReport, parseMacroSteps } from "./macro";
import {
  formatSwarmVisibility,
  runSwarmBatch,
  type SwarmWorkerSpec,
} from "./swarm";

export interface ToolExecutor {
  execute(call: ToolCall, generateId: () => string): Promise<ToolResult>;
  definitions(): readonly ToolDefinition[];
}

export interface SwarmToolOptions {
  readonly runWorker: (
    worker: SwarmWorkerSpec,
    prompt: string,
    toolNames?: readonly string[],
  ) => Promise<string>;
  readonly onVisibility?: (visibility: string) => void;
  readonly workerTools?: "none" | "readonly";
}

const READONLY_WORKER_TOOLS = ["read", "glob", "grep"] as const;

function parseArgs(raw: string): Record<string, unknown> {
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

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v : "";
}

function swarmWorkers(args: Record<string, unknown>): SwarmWorkerSpec[] {
  const rawWorkers = args["workers"];
  if (!Array.isArray(rawWorkers) || rawWorkers.length === 0) {
    throw new Error("swarm requires at least one worker");
  }

  return rawWorkers.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`swarm worker ${index + 1} must be an object`);
    }
    const worker = raw as Record<string, unknown>;
    const id = typeof worker["id"] === "string" ? worker["id"] : "";
    const modelId =
      typeof worker["modelId"] === "string" ? worker["modelId"] : "";
    if (!id || !modelId) {
      throw new Error(`swarm worker ${index + 1} requires id and modelId`);
    }
    const effort =
      worker["effort"] === undefined
        ? undefined
        : typeof worker["effort"] === "string"
          ? worker["effort"]
          : (() => {
              throw new Error(`swarm worker ${index + 1} has invalid effort`);
            })();
    const profile = resolveModel(modelId);
    const spec: {
      id: string;
      modelId: string;
      profile: SwarmWorkerSpec["profile"];
      effort?: string;
    } = { id, modelId, profile };
    if (effort !== undefined) {
      spec.effort = effort;
    }
    return spec;
  });
}

const DEFINITIONS: ToolDefinition[] = [
  {
    name: "read",
    description: "Read a UTF-8 text file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "write",
    description: "Write a UTF-8 text file",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit",
    description:
      "Replace the first occurrence of oldText with newText in a file",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        oldText: { type: "string" },
        newText: { type: "string" },
      },
      required: ["path", "oldText", "newText"],
    },
  },
  {
    name: "bash",
    description: "Run a shell command via /bin/sh -c",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "glob",
    description: "Expand a glob pattern into matching files",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "grep",
    description: "Search files with ripgrep (rg)",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "command_run",
    description:
      "Run a batch of file/shell steps (read/glob/grep in parallel; write/edit/bash sequential)",
    parameters: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              op: {
                type: "string",
                enum: ["read", "bash", "glob", "grep", "write", "edit"],
              },
              path: { type: "string" },
              content: { type: "string" },
              oldText: { type: "string" },
              newText: { type: "string" },
              command: { type: "string" },
              pattern: { type: "string" },
            },
            required: ["op"],
          },
        },
      },
      required: ["steps"],
    },
  },
  {
    name: "swarm",
    description: "Run a prompt across multiple agent workers in parallel",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        workers: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              modelId: { type: "string" },
              effort: { type: "string" },
            },
            required: ["id", "modelId"],
          },
        },
      },
      required: ["prompt", "workers"],
    },
  },
];

export function createBuiltinToolExecutor(
  cwd: string,
  swarm?: SwarmToolOptions,
): ToolExecutor {
  return {
    definitions() {
      return DEFINITIONS;
    },
    async execute(call, generateId) {
      const args = parseArgs(call.arguments);
      try {
        const content = await dispatch(call.name, args, cwd, swarm);
        return {
          kind: "tool_result",
          id: generateId(),
          callId: call.id,
          content,
          isError: false,
        };
      } catch (err) {
        return {
          kind: "tool_result",
          id: generateId(),
          callId: call.id,
          content: err instanceof Error ? err.message : String(err),
          isError: true,
        };
      }
    },
  };
}

async function dispatch(
  name: string,
  args: Record<string, unknown>,
  cwd: string,
  swarm: SwarmToolOptions | undefined,
): Promise<string> {
  switch (name) {
    case "read":
      return readFile(str(args, "path"));
    case "write":
      await writeFile(str(args, "path"), str(args, "content"));
      return "ok";
    case "edit":
      await editFile(
        str(args, "path"),
        str(args, "oldText"),
        str(args, "newText"),
      );
      return "ok";
    case "bash": {
      const result = await runCommand("/bin/sh", ["-c", str(args, "command")], {
        cwd,
      });
      return `exit ${result.code}\n${result.stdout}${result.stderr}`;
    }
    case "glob": {
      const pattern = str(args, "path");
      if (!pattern) throw new Error("glob requires a pattern");
      const result = await runCommand("rg", ["--files", "-g", pattern], {
        cwd,
      });
      return result.stdout || "(no matches)";
    }
    case "grep": {
      const pattern = str(args, "pattern");
      const path = str(args, "path") || cwd;
      const result = await runCommand("rg", ["-n", pattern, path], { cwd });
      return result.stdout || result.stderr || "(no matches)";
    }
    case "command_run": {
      const steps = parseMacroSteps(args["steps"]);
      if (steps.length === 0) {
        throw new Error("command_run requires at least one step");
      }
      const results = await executeMacroSteps(steps, cwd);
      return formatMacroReport(results);
    }
    case "swarm": {
      if (swarm === undefined) {
        throw new Error("swarm tool is not configured");
      }
      const prompt = str(args, "prompt");
      if (!prompt) {
        throw new Error("swarm requires a non-empty prompt");
      }
      const workers = swarmWorkers(args);
      swarm.onVisibility?.(formatSwarmVisibility({ workers }));
      const results = await runSwarmBatch({
        workers,
        prompt,
        runWorker: (worker, workerPrompt) =>
          swarm.runWorker(
            worker,
            workerPrompt,
            swarm.workerTools === "none" ? [] : READONLY_WORKER_TOOLS,
          ),
      });
      return JSON.stringify(results);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

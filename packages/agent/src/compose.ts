import type { ToolCall, ToolDefinition, ToolResult } from "@kimi-next/ir";
import type { ToolExecutor } from "./tools";

/** Merge multiple tool executors; first matching definition wins on name collision. */
export function composeToolExecutors(
  ...executors: readonly ToolExecutor[]
): ToolExecutor {
  return {
    definitions() {
      const seen = new Set<string>();
      const defs: ToolDefinition[] = [];
      for (const executor of executors) {
        for (const def of executor.definitions()) {
          if (seen.has(def.name)) continue;
          seen.add(def.name);
          defs.push(def);
        }
      }
      return defs;
    },
    async execute(call: ToolCall, generateId: () => string): Promise<ToolResult> {
      for (const executor of executors) {
        if (executor.definitions().some((d) => d.name === call.name)) {
          return executor.execute(call, generateId);
        }
      }
      return {
        kind: "tool_result",
        id: generateId(),
        callId: call.id,
        content: `Unknown tool: ${call.name}`,
        isError: true,
      };
    },
  };
}

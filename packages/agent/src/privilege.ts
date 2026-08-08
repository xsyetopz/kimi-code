import type { PermissionGate, PermissionRequest } from "./permission";

/** Structural tool privilege — host policy, not prompt text, elevates. */

export type ToolPrivilege = "read" | "write" | "exec" | "mcp";

const ORDER: readonly ToolPrivilege[] = ["read", "write", "exec", "mcp"];

const READ_TOOLS = new Set([
  "read",
  "glob",
  "grep",
  "mcp_list",
  "mcp_schema",
]);

const WRITE_TOOLS = new Set(["write", "edit"]);

const EXEC_TOOLS = new Set(["bash", "command_run"]);

export function privilegeRank(level: ToolPrivilege): number {
  return ORDER.indexOf(level);
}

export function privilegeForTool(toolName: string): ToolPrivilege {
  if (toolName.startsWith("mcp:")) return "mcp";
  if (READ_TOOLS.has(toolName)) return "read";
  if (WRITE_TOOLS.has(toolName)) return "write";
  if (EXEC_TOOLS.has(toolName)) return "exec";
  if (toolName === "swarm") return "exec";
  return "exec";
}

export function privilegeAllows(
  maxAuto: ToolPrivilege,
  toolName: string,
): boolean {
  return privilegeRank(privilegeForTool(toolName)) <= privilegeRank(maxAuto);
}

/**
 * Outer gate: tools at or below `maxAuto` skip the inner ask.
 * Elevation only comes from host `maxAuto` / yolo — never from user prompt text.
 */
export function createPrivilegePermissionGate(
  inner: PermissionGate,
  maxAuto: ToolPrivilege,
): PermissionGate {
  return {
    async ask(request: PermissionRequest) {
      if (request.mode === "yolo") return "allow";
      if (privilegeAllows(maxAuto, request.toolName)) return "allow";
      return inner.ask(request);
    },
  };
}

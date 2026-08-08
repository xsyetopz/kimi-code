import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createMcpToolBridgeFromPluginRoots,
  type McpToolExecutor,
} from "@kimi-next/ext";

/** Discover plugin directories under `.kimi-next/plugins` and `plugins/`. */
export async function discoverPluginRoots(cwd: string): Promise<string[]> {
  const roots: string[] = [];
  for (const base of [join(cwd, ".kimi-next", "plugins"), join(cwd, "plugins")]) {
    try {
      const entries = await readdir(base, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) roots.push(join(base, entry.name));
      }
    } catch {
      // missing dir is fine
    }
  }
  return roots;
}

export async function loadMcpTools(
  cwd: string,
): Promise<McpToolExecutor | undefined> {
  const roots = await discoverPluginRoots(cwd);
  if (roots.length === 0) return undefined;
  try {
    const bridge = await createMcpToolBridgeFromPluginRoots(roots);
    if (bridge.definitions().length === 0) {
      await bridge.close();
      return undefined;
    }
    return bridge;
  } catch (err) {
    console.error(
      `MCP plugin load failed: ${err instanceof Error ? err.message : err}`,
    );
    return undefined;
  }
}

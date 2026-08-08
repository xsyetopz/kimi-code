import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface PluginManifest {
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly root: string;
}

export interface McpStdioServer {
  readonly id: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
}

/**
 * Load agent-plugins.org plugin.json from a directory.
 * Unknown fields ignored; schema violations skip the plugin.
 */
export async function loadPlugin(
  root: string,
): Promise<PluginManifest | null> {
  try {
    const raw = await readFile(join(root, "plugin.json"), "utf8");
    const json: unknown = JSON.parse(raw);
    if (!json || typeof json !== "object") return null;
    const obj = json as Record<string, unknown>;
    if (
      typeof obj["name"] !== "string" ||
      !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(obj["name"])
    ) {
      console.warn(`Skipping plugin with invalid name in ${root}`);
      return null;
    }
    const manifest: {
      name: string;
      root: string;
      version?: string;
      description?: string;
    } = { name: obj["name"], root };
    if (typeof obj["version"] === "string") {
      manifest.version = obj["version"];
    }
    if (typeof obj["description"] === "string") {
      manifest.description = obj["description"];
    }
    return manifest;
  } catch {
    return null;
  }
}

/**
 * Parse mcp.json stdio servers only (Day-1). Remote transports deferred.
 */
export async function loadMcpStdioServers(
  pluginRoot: string,
): Promise<McpStdioServer[]> {
  try {
    const raw = await readFile(join(pluginRoot, "mcp.json"), "utf8");
    const json: unknown = JSON.parse(raw);
    if (!json || typeof json !== "object") return [];
    const servers = (json as { mcpServers?: unknown }).mcpServers;
    if (!servers || typeof servers !== "object") return [];
    const out: McpStdioServer[] = [];
    for (const [id, cfg] of Object.entries(
      servers as Record<string, unknown>,
    )) {
      if (!cfg || typeof cfg !== "object") continue;
      const c = cfg as Record<string, unknown>;
      const type = c["type"] ?? "stdio";
      if (type !== "stdio") continue;
      if (typeof c["command"] !== "string") continue;
      const args = Array.isArray(c["args"])
        ? c["args"].filter((a): a is string => typeof a === "string")
        : [];
      const env: Record<string, string> = {};
      if (c["env"] && typeof c["env"] === "object") {
        for (const [k, v] of Object.entries(c["env"] as Record<string, unknown>)) {
          if (typeof v === "string") env[k] = v;
        }
      }
      out.push({
        id,
        command: c["command"],
        args,
        env: {
          ...env,
          PLUGIN_ROOT: pluginRoot,
          PLUGIN_DATA: join(pluginRoot, ".data"),
        },
        cwd: pluginRoot,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Prefix MCP tool names to avoid collisions. */
export function prefixMcpToolName(serverId: string, toolName: string): string {
  return `mcp:${serverId}:${toolName}`;
}

import { isAbsolute, relative, sep } from "node:path";

const MAX_ARG_LENGTH = 60;
const PATH_KEYS = new Set(["path", "file_path"]);

function truncateArgValue(key: string, value: string): string {
  if (value.length <= MAX_ARG_LENGTH) return value;
  if (PATH_KEYS.has(key)) {
    return "…" + value.slice(value.length - (MAX_ARG_LENGTH - 1));
  }
  return value.slice(0, MAX_ARG_LENGTH - 3) + "...";
}

export function makeWorkspaceRelativePath(
  filePath: string,
  workspaceDir: string | undefined,
): string {
  if (
    workspaceDir === undefined ||
    workspaceDir.length === 0 ||
    !isAbsolute(filePath)
  ) {
    return filePath;
  }
  const relativePath = relative(workspaceDir, filePath);
  if (
    relativePath.length === 0 ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return filePath;
  }
  return relativePath;
}

function formatKeyArgument(
  toolName: string,
  key: string,
  value: string,
  workspaceDir: string | undefined,
): string {
  const displayValue =
    toolName === "Read" && PATH_KEYS.has(key)
      ? makeWorkspaceRelativePath(value, workspaceDir)
      : value;
  return truncateArgValue(key, displayValue);
}

/** Key argument shown in the tool-call header chip, shared by pi-tui and Ink. */
export function extractKeyArgument(
  toolName: string,
  args: Record<string, unknown>,
  workspaceDir?: string,
): string | null {
  const keyMap: Record<string, string[]> = {
    Bash: ["command"],
    Read: ["path", "file_path"],
    Write: ["path", "file_path"],
    Edit: ["path", "file_path"],
    Grep: ["pattern"],
    Glob: ["pattern"],
    FetchURL: ["url"],
    WebSearch: ["query"],
    Agent: ["description", "prompt"],
  };

  if (toolName === "Glob") {
    const pattern = args["pattern"];
    if (typeof pattern !== "string" || pattern.length === 0) return null;
    let summary = pattern;
    const path = args["path"];
    if (typeof path === "string" && path.length > 0) {
      summary += ` · ${makeWorkspaceRelativePath(path, workspaceDir)}`;
    }
    if (args["include_ignored"] === true) {
      summary += " · include ignored";
    }
    return truncateArgValue("pattern", summary);
  }

  const candidates = keyMap[toolName] ?? Object.keys(args);
  for (const key of candidates) {
    const val = args[key];
    if (typeof val === "string" && val.length > 0) {
      const firstLine = val.split("\n")[0] ?? val;
      const displayValue =
        toolName === "Bash" && val.includes("\n") ? `${firstLine}…` : firstLine;
      return formatKeyArgument(toolName, key, displayValue, workspaceDir);
    }
  }
  return null;
}

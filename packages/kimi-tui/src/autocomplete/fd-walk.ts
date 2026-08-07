import { spawn } from "node:child_process";
import { buildFdPathQuery, toDisplayPath } from "./path-token.ts";

/** Use fd to walk directory tree (fast, respects .gitignore). */
export async function walkDirectoryWithFd(
  baseDir: string,
  fdPath: string,
  query: string,
  maxResults: number,
  signal: AbortSignal,
): Promise<Array<{ path: string; isDirectory: boolean }>> {
  const args = [
    "--base-directory",
    baseDir,
    "--max-results",
    String(maxResults),
    "--type",
    "f",
    "--type",
    "d",
    "--follow",
    "--hidden",
    "--exclude",
    ".git",
    "--exclude",
    ".git/*",
    "--exclude",
    ".git/**",
  ];

  if (toDisplayPath(query).includes("/")) {
    args.push("--full-path");
  }

  if (query) {
    args.push(buildFdPathQuery(query));
  }

  return await new Promise((resolve) => {
    if (signal.aborted) {
      resolve([]);
      return;
    }

    const child = spawn(fdPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let resolved = false;

    const finish = (results: Array<{ path: string; isDirectory: boolean }>) => {
      if (resolved) return;
      resolved = true;
      signal.removeEventListener("abort", onAbort);
      resolve(results);
    };

    const onAbort = () => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    };

    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", () => {
      finish([]);
    });
    child.on("close", (code) => {
      if (signal.aborted || code !== 0 || !stdout) {
        finish([]);
        return;
      }

      const lines = stdout.trim().split("\n").filter(Boolean);
      const results: Array<{ path: string; isDirectory: boolean }> = [];

      for (const line of lines) {
        const displayLine = toDisplayPath(line);
        const hasTrailingSeparator = displayLine.endsWith("/");
        const normalizedPath = hasTrailingSeparator
          ? displayLine.slice(0, -1)
          : displayLine;
        if (
          normalizedPath === ".git" ||
          normalizedPath.startsWith(".git/") ||
          normalizedPath.includes("/.git/")
        ) {
          continue;
        }

        results.push({
          path: displayLine,
          isDirectory: hasTrailingSeparator,
        });
      }

      finish(results);
    });
  });
}

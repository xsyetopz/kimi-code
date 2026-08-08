#!/usr/bin/env node
/**
 * Emit directed maintenance prompts from codebase health signals.
 * Vague "tidy the codebase" is forbidden — this prints concrete targets.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const MAX = 800;
const SKIP = new Set(["node_modules", "dist", ".git", "testdata"]);

/** @type {{ path: string; lines: number }[]} */
const files = [];

/**
 * @param {string} dir
 */
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path);
      continue;
    }
    if (!/\.(ts|tsx|mjs|js)$/.test(entry.name)) continue;
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) {
      continue;
    }
    const text = readFileSync(path, "utf8");
    const lines = text.split("\n").length;
    files.push({ path: relative(root, path), lines });
  }
}

for (const base of ["apps", "packages", "scripts"]) {
  const dir = join(root, base);
  if (existsSync(dir)) walk(dir);
}

files.sort((a, b) => b.lines - a.lines);
const hot = files.slice(0, 12);

console.log("kimi-next health — directed prompts (not vague tidy):\n");
for (const file of hot) {
  const over = file.lines > MAX;
  console.log(
    `- Review ${file.path} (${file.lines} LOC${over ? ` — OVER ${MAX}` : ""}): split by capability if it mixes IO, policy, and UI; keep contracts tested.`,
  );
}

const fanInHints = [
  "packages/agent/src/loop.ts",
  "apps/kimi-next/src/cli/host.ts",
  "packages/ext/src/toolBridge.ts",
];
console.log("\nCoupling hotspots to keep narrow:");
for (const path of fanInHints) {
  if (existsSync(join(root, path))) {
    console.log(`- Keep ${path} as an orchestrator; push leaves into siblings under 800 LOC.`);
  }
}

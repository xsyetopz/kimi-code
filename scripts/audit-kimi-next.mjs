#!/usr/bin/env node
/**
 * Fail-closed kimi-next architecture audit (local gate).
 * Complements scripts/check-boundaries.mjs and check-loc.mjs.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const required = [
  "apps/kimi-next",
  "packages/ir",
  "packages/discover",
  "packages/model",
  "packages/adapters",
  "packages/agent",
  "packages/session",
  "packages/exec",
  "packages/tui",
  "packages/ext",
  "packages/auth",
  "packages/bash-parse",
];

let failed = false;

for (const path of required) {
  if (!existsSync(join(root, path, "package.json"))) {
    console.error(`FAIL: missing required package ${path}`);
    failed = true;
  }
}

const forbiddenLegacy = [
  "apps/kimi-code",
  "packages/agent-core-v2",
  "packages/klient",
  "packages/node-sdk",
  "packages/kosong",
  "packages/kaos",
  "packages/protocol",
  "packages/acp-server",
  "packages/oauth",
  "packages/kimi-tui",
  "packages/transcript",
  "packages/tree-sitter-bash",
];

for (const path of forbiddenLegacy) {
  if (existsSync(join(root, path))) {
    console.error(`FAIL: deleted product path reintroduced: ${path}`);
    failed = true;
  }
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const srcRoots = [
  join(root, "apps/kimi-next/src"),
  ...readdirSync(join(root, "packages")).map((d) =>
    join(root, "packages", d, "src"),
  ),
];

for (const src of srcRoots) {
  for (const file of walk(src)) {
    const text = readFileSync(file, "utf8");
    if (
      /\bwin32\b/.test(text) &&
      !text.includes("supports macOS and Linux only") &&
      !text.includes("assertPosix") &&
      !text.includes("platform === \"win32\"")
    ) {
      // allow explicit rejection of win32
    }
    // Flag Windows support code that isn't a rejection
    if (/Git Bash|WSL_DISTRO|LOCALAPPDATA|windowsHide/.test(text)) {
      console.error(`FAIL: Windows-support residue in ${file}`);
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log("OK: kimi-next architecture audit");

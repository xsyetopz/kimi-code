#!/usr/bin/env node
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const MAX = 800;
const VENDOR = new Set([
  "packages/bash-parse/src/parser.ts",
]);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist" || e === ".git") continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e) && !e.endsWith(".test.ts") && !e.endsWith(".spec.ts")) out.push(p);
  }
  return out;
}

const roots = [
  join(root, "apps/kimi-next/src"),
  ...readdirSync(join(root, "packages"))
    .filter((d) => existsSync(join(root, "packages", d, "src")))
    .map((d) => join(root, "packages", d, "src")),
];

let failed = false;
for (const r of roots) {
  for (const file of walk(r)) {
    const rel = relative(root, file);
    if (VENDOR.has(rel)) continue;
    const lines = readFileSync(file, "utf8").split("\n").length;
    if (lines > MAX) {
      console.error(`FAIL: ${rel} has ${lines} LOC (max ${MAX})`);
      failed = true;
    }
  }
}
if (failed) process.exit(1);
console.log(`OK: all authored product files ≤${MAX} LOC`);

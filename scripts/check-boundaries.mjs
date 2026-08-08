#!/usr/bin/env node
/**
 * Fail-closed package dependency boundary check for kimi-next.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const forbidden = [
  ["@kimi-next/tui", "@kimi-next/agent"],
  ["@kimi-next/adapters", "@kimi-next/agent"],
  ["@kimi-next/ir", "@kimi-next/"],
  ["@kimi-next/agent", "@kimi-next/tui"],
];

function pkgDeps(name) {
  const p = join(root, name.startsWith("apps/") ? name : `packages/${name.replace("@kimi-next/", "")}`, "package.json");
  if (!existsSync(p)) return [];
  const j = JSON.parse(readFileSync(p, "utf8"));
  return Object.keys({ ...j.dependencies, ...j.devDependencies });
}

const packages = readdirSync(join(root, "packages")).filter((d) =>
  existsSync(join(root, "packages", d, "package.json")),
);

let failed = false;
for (const dir of packages) {
  const name = `@kimi-next/${dir}`;
  const deps = pkgDeps(dir);
  if (name === "@kimi-next/ir") {
    for (const d of deps) {
      if (d.startsWith("@kimi-next/")) {
        console.error(`FAIL: ir must be a leaf; depends on ${d}`);
        failed = true;
      }
    }
  }
  for (const [from, toPrefix] of forbidden) {
    if (name !== from) continue;
    for (const d of deps) {
      if (toPrefix.endsWith("/") ? d.startsWith(toPrefix) && d !== from : d === toPrefix) {
        // ir special: forbid any @kimi-next/ except itself
        if (from === "@kimi-next/ir" && d.startsWith("@kimi-next/")) {
          console.error(`FAIL: ${from} must not depend on ${d}`);
          failed = true;
        } else if (from !== "@kimi-next/ir" && d === toPrefix) {
          console.error(`FAIL: forbidden edge ${from} -> ${d}`);
          failed = true;
        }
      }
    }
  }
  if (name === "@kimi-next/tui" && deps.includes("@kimi-next/agent")) {
    console.error("FAIL: tui must not depend on agent");
    failed = true;
  }
  if (name === "@kimi-next/agent" && deps.includes("@kimi-next/tui")) {
    console.error("FAIL: agent must not depend on tui");
    failed = true;
  }
  if (name === "@kimi-next/adapters" && deps.includes("@kimi-next/agent")) {
    console.error("FAIL: adapters must not depend on agent");
    failed = true;
  }
}

if (failed) process.exit(1);
console.log("OK: package boundaries");

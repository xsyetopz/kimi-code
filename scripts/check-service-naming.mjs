#!/usr/bin/env node
/**
 * Enforce camelCase naming for legacy `packages/services` domain dirs (if present).
 * The harness product line no longer ships `packages/services` or `packages/kap-server`;
 * this script remains as a no-op guard when those trees are absent.
 *
 * Exit code 0 if clean, 1 with an actionable report otherwise.
 */

import { readdirSync, statSync, existsSync } from "node:fs";
import { resolve, join, relative } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SERVICES_SRC = join(ROOT, "packages/services/src");

/** @type {Array<{ kind: string, path: string }>} */
const violations = [];

function isKebab(name) {
  return name.includes("-");
}

function report(kind, absPath) {
  violations.push({ kind, path: relative(ROOT, absPath) });
}

/**
 * Organised as <domain>/<files>.ts plus a few top-level files.
 * Flag kebab in dir names and in any .ts file directly under a domain dir.
 */
function scanServicesSrc(srcRoot = SERVICES_SRC) {
  if (!existsSync(srcRoot)) return;
  for (const entry of readdirSync(srcRoot)) {
    const abs = join(srcRoot, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (isKebab(entry)) report("kebab-dir", abs);
      for (const f of readdirSync(abs)) {
        if (!f.endsWith(".ts")) continue;
        if (isKebab(f)) report("kebab-file", join(abs, f));
      }
    } else if (entry.endsWith(".ts") && isKebab(entry)) {
      report("kebab-file", abs);
    }
  }
}

scanServicesSrc();

if (violations.length > 0) {
  console.error(
    "Service naming violations (no kebab-case allowed for service files/dirs):",
  );
  for (const v of violations) console.error(`  [${v.kind}] ${v.path}`);
  console.error(
    "\nRename to camelCase per VS Code convention: <domain>.ts + <domain>Service.ts.",
  );
  process.exit(1);
}

console.log("Service naming check passed.");

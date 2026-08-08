#!/usr/bin/env node
/**
 * Golden vault check. Agents must not rewrite goldens unless ALLOW_GOLDEN_UPDATE=1.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const vaultDir = join(root, "testdata", "golden");
const manifestPath = join(vaultDir, "MANIFEST.sha256");
const allow = process.env.ALLOW_GOLDEN_UPDATE === "1";

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function listVaultFiles() {
  /** @type {string[]} */
  const out = [];
  function walk(dir) {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name !== "MANIFEST.sha256") out.push(path);
    }
  }
  walk(vaultDir);
  return out.sort();
}

const files = listVaultFiles();
if (files.length === 0) {
  console.error("FAIL: testdata/golden is empty");
  process.exit(1);
}

/** @type {Record<string, string>} */
const current = {};
for (const path of files) {
  const rel = path.slice(vaultDir.length + 1);
  current[rel] = hashFile(path);
}

if (!existsSync(manifestPath) || allow) {
  mkdirSync(dirname(manifestPath), { recursive: true });
  const body = Object.entries(current)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([rel, hash]) => `${hash}  ${rel}`)
    .join("\n");
  writeFileSync(manifestPath, `${body}\n`, "utf8");
  console.log(
    allow
      ? `Updated golden manifest (${files.length} files) because ALLOW_GOLDEN_UPDATE=1`
      : `Wrote/updated golden manifest (${files.length} files)`,
  );
}

const expectedLines = readFileSync(manifestPath, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean);
/** @type {Record<string, string>} */
const expected = {};
for (const line of expectedLines) {
  const hash = line.slice(0, 64);
  const rel = line.slice(66);
  expected[rel] = hash;
}

let failed = false;
for (const [rel, hash] of Object.entries(expected)) {
  if (current[rel] !== hash) {
    console.error(`FAIL: golden drift in ${rel}`);
    failed = true;
  }
}
for (const rel of Object.keys(current)) {
  if (!(rel in expected)) {
    console.error(
      `FAIL: unexpected golden file ${rel} (update with ALLOW_GOLDEN_UPDATE=1)`,
    );
    failed = true;
  }
}

if (failed) {
  console.error(
    "Golden vault is sacred. Fix the code, or set ALLOW_GOLDEN_UPDATE=1 intentionally.",
  );
  process.exit(1);
}

console.log(`OK: golden vault (${files.length} files)`);

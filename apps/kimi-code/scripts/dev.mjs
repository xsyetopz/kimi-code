#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { startPluginMarketplaceServer } from "./dev-plugin-marketplace-server.mjs";

const require = createRequire(import.meta.url);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(SCRIPT_DIR, "..");
// Monorepo root. Used as the dev CLI's working directory so `make dev` opens
// the whole repo instead of just apps/kimi-code.
const REPO_ROOT = resolve(APP_ROOT, "../..");
// Runtime variable the CLI reads to locate the marketplace JSON.
const MARKETPLACE_ENV = "KIMI_CODE_PLUGIN_MARKETPLACE_URL";
// Opt-in for dev: point this run at an external marketplace instead of a local one.
const EXTERNAL_MARKETPLACE_ENV = "KIMI_CODE_DEV_MARKETPLACE_URL";

let marketplaceServer;
const env = { ...process.env };

loadRepoDotenv(REPO_ROOT, env);
applySyntheticDevModelEnv(env);

const externalUrl = process.env[EXTERNAL_MARKETPLACE_ENV]?.trim();
if (externalUrl !== undefined && externalUrl.length > 0) {
  // Explicitly asked to use an external marketplace; don't start a local server.
  env[MARKETPLACE_ENV] = externalUrl;
  console.error(`Using external plugin marketplace: ${externalUrl}`);
} else {
  // Default: every `bun run dev:cli` runs its own isolated marketplace server on a
  // random port, so multiple concurrent dev instances never collide. Overwrite any
  // inherited MARKETPLACE_ENV so a stale URL from a dead instance can't break this run.
  const inherited = process.env[MARKETPLACE_ENV]?.trim();
  marketplaceServer = await startPluginMarketplaceServer();
  env[MARKETPLACE_ENV] = marketplaceServer.marketplaceUrl;
  console.error(
    `Plugin marketplace dev server: ${marketplaceServer.marketplaceUrl}`,
  );
  if (
    inherited !== undefined &&
    inherited.length > 0 &&
    inherited !== marketplaceServer.marketplaceUrl
  ) {
    console.error(
      `(ignored inherited ${MARKETPLACE_ENV}=${inherited}; set ${EXTERNAL_MARKETPLACE_ENV} to use an external marketplace)`,
    );
  }
}

function resolveNodeExecutable() {
  if (!process.versions.bun) {
    return process.execPath;
  }
  return process.env.NODE ?? "node";
}

const tsxCli = require.resolve("tsx/cli");
const rawTextLoader = pathToFileURL(
  resolve(REPO_ROOT, "build/register-raw-text-loader.mjs"),
).href;
const bunStubsLoader = pathToFileURL(
  resolve(REPO_ROOT, "build/register-bun-stubs.mjs"),
).href;
const cliArgs = process.argv.slice(2);
if (cliArgs[0] === "--") cliArgs.shift();
const child = spawn(
  resolveNodeExecutable(),
  [
    tsxCli,
    // tsx + Node resolve package.json imports and decorators via tsconfig.dev.json.
    // bun:sqlite is stubbed for the Node child; Bun 1.3.14 cannot execute the
    // monorepo source graph directly because it rejects `#/*` package imports.
    "--tsconfig",
    resolve(APP_ROOT, "tsconfig.dev.json"),
    "--import",
    rawTextLoader,
    "--import",
    bunStubsLoader,
    resolve(APP_ROOT, "src/main.ts"),
    ...cliArgs,
  ],
  {
    cwd: REPO_ROOT,
    env,
    stdio: "inherit",
  },
);

child.on("error", async (error) => {
  console.error(`Failed to start Kimi Code dev CLI: ${error.message}`);
  await marketplaceServer?.close();
  process.exit(1);
});

child.on("exit", async (code, signal) => {
  await marketplaceServer?.close();
  if (signal !== null) {
    process.exit(1);
  }
  process.exit(code ?? 0);
});

/** Load repo-root `.env` without overriding variables already set in the shell. */
function loadRepoDotenv(repoRoot, target) {
  const dotenvPath = resolve(repoRoot, ".env");
  if (!existsSync(dotenvPath)) return;
  for (const line of readFileSync(dotenvPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key.length === 0 || target[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    target[key] = value;
  }
}

/**
 * Map SYNTHETIC_API_KEY from `.env` into the KIMI_MODEL_* overlay channel so
 * `bun run dev -- -p` can hit synthetic.new without editing config.toml.
 */
function applySyntheticDevModelEnv(target) {
  const syntheticKey = target.SYNTHETIC_API_KEY?.trim();
  if (syntheticKey === undefined || syntheticKey.length === 0) return;
  if (target.KIMI_MODEL_API_KEY === undefined) {
    target.KIMI_MODEL_API_KEY = syntheticKey;
  }
  if (target.KIMI_MODEL_NAME === undefined) {
    target.KIMI_MODEL_NAME = "syn:large:text";
  }
  if (target.KIMI_MODEL_BASE_URL === undefined) {
    target.KIMI_MODEL_BASE_URL = "https://api.synthetic.new/v1";
  }
  if (target.KIMI_MODEL_PROVIDER_TYPE === undefined) {
    target.KIMI_MODEL_PROVIDER_TYPE = "openai";
  }
}

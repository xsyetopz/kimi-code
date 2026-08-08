#!/usr/bin/env node
/**
 * Fetch the public models.dev catalog and write a slim snapshot for @kimi-next/model.
 *
 * Default source: https://models.dev/api.json
 * Override with MODELS_DEV_CATALOG_URL.
 *
 * Usage (from repo root or packages/model):
 *   node packages/model/scripts/refresh-catalog.mjs
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_URL = "https://models.dev/api.json";
const OUTPUT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../src/catalog-snapshot.json",
);

/** First-party providers whose models become kimi-next catalog entries. */
const FIRST_PARTY_PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "moonshotai",
];

const EXCLUDED_STATUSES = new Set(["deprecated", "alpha"]);

/**
 * @param {string} providerId
 * @param {string | undefined} npm
 * @param {string} wireModel
 * @returns {"openai-chat" | "openai-responses" | "anthropic" | "gemini"}
 */
function inferTransport(providerId, npm, wireModel) {
  if (providerId === "anthropic" || npm === "@ai-sdk/anthropic") {
    return "anthropic";
  }
  if (providerId === "google" || npm === "@ai-sdk/google") {
    return "gemini";
  }
  if (providerId === "openai" || npm === "@ai-sdk/openai") {
    if (wireModel === "gpt-4.1") {
      return "openai-responses";
    }
    return "openai-chat";
  }
  return "openai-chat";
}

/**
 * @param {string} providerId
 * @param {string} modelId
 */
function toKimiNextId(providerId, modelId) {
  if (modelId.includes("/")) {
    return modelId;
  }
  return `${providerId}/${modelId}`;
}

/**
 * @param {Record<string, unknown>} catalog
 */
function slimSnapshot(catalog) {
  /** @type {import("../src/snapshot-types.ts").CatalogSnapshotModel[]} */
  const models = [];

  for (const providerId of FIRST_PARTY_PROVIDERS) {
    const provider = catalog[providerId];
    if (!provider || typeof provider !== "object") {
      continue;
    }

    const npm =
      typeof provider.npm === "string" ? provider.npm : undefined;
    const providerModels = provider.models;
    if (!providerModels || typeof providerModels !== "object") {
      continue;
    }

    for (const [wireModel, raw] of Object.entries(providerModels)) {
      if (!raw || typeof raw !== "object") {
        continue;
      }

      const model = /** @type {Record<string, unknown>} */ (raw);
      const status =
        typeof model.status === "string" ? model.status : undefined;
      if (status && EXCLUDED_STATUSES.has(status)) {
        continue;
      }

      const limit =
        model.limit && typeof model.limit === "object"
          ? /** @type {{ context?: number; output?: number }} */ (model.limit)
          : {};
      const modalities =
        model.modalities && typeof model.modalities === "object"
          ? /** @type {{ input?: string[] }} */ (model.modalities)
          : {};
      const inputModalities = Array.isArray(modalities.input)
        ? modalities.input
        : [];

      const id = toKimiNextId(providerId, wireModel);
      models.push({
        id,
        displayName:
          typeof model.name === "string" ? model.name : wireModel,
        wireModel:
          typeof model.id === "string" ? model.id : wireModel,
        transport: inferTransport(providerId, npm, wireModel),
        contextTokens: limit.context ?? 128_000,
        maxOutputTokens: limit.output ?? 16_384,
        images:
          model.attachment === true ||
          inputModalities.includes("image"),
        toolCalls: model.tool_call === true,
        reasoning: model.reasoning === true,
        temperature: model.temperature !== false,
      });
    }
  }

  models.sort((a, b) => a.id.localeCompare(b.id));

  return {
    version: 1,
    fetchedAt: new Date().toISOString(),
    source: process.env.MODELS_DEV_CATALOG_URL ?? DEFAULT_URL,
    models,
  };
}

async function main() {
  const url = process.env.MODELS_DEV_CATALOG_URL ?? DEFAULT_URL;

  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    console.error(`Failed to fetch models.dev catalog from ${url}: ${message}`);
    process.exit(1);
  }

  if (!response.ok) {
    console.error(
      `Failed to fetch models.dev catalog from ${url}: HTTP ${response.status} ${response.statusText}`,
    );
    process.exit(1);
  }

  let catalog;
  try {
    catalog = await response.json();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    console.error(`Failed to parse models.dev catalog JSON: ${message}`);
    process.exit(1);
  }

  if (!catalog || typeof catalog !== "object") {
    console.error("models.dev catalog response was not a JSON object");
    process.exit(1);
  }

  const snapshot = slimSnapshot(catalog);
  writeFileSync(OUTPUT, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(
    `Wrote ${snapshot.models.length} models to ${OUTPUT} (fetched ${url})`,
  );
}

main();

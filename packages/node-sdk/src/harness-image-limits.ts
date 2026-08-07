import { readFileSync } from "node:fs";

import { parse as parseToml } from "smol-toml";

import {
  IMAGE_READ_BYTE_BUDGET_ENV,
  IMAGE_MAX_EDGE_ENV,
} from "@moonshot-ai/agent-core-v2/agent/media/configSection";
import {
  MAX_IMAGE_EDGE_PX,
  READ_IMAGE_BYTE_BUDGET,
} from "@moonshot-ai/agent-core-v2/agent/media/image-compress";

import { ImageLimits } from "#/compat";

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value.length === 0 || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function readImageSection(
  configPath: string,
): { maxEdgePx?: number; readByteBudget?: number } {
  try {
    const data = parseToml(readFileSync(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    const image = data["image"];
    if (image === null || typeof image !== "object" || Array.isArray(image)) {
      return {};
    }
    const record = image as Record<string, unknown>;
    const maxEdgePx =
      typeof record["max_edge_px"] === "number"
        ? record["max_edge_px"]
        : undefined;
    const readByteBudget =
      typeof record["read_byte_budget"] === "number"
        ? record["read_byte_budget"]
        : undefined;
    return { maxEdgePx, readByteBudget };
  } catch {
    return {};
  }
}

/** Sync [image] limits for harness prompt-ingestion paths (config + env). */
export function resolveHarnessImageLimits(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
): ImageLimits {
  const file = readImageSection(configPath);
  const maxEdgePx =
    parsePositiveInt(env[IMAGE_MAX_EDGE_ENV]) ??
    file.maxEdgePx ??
    MAX_IMAGE_EDGE_PX;
  const readByteBudget =
    parsePositiveInt(env[IMAGE_READ_BYTE_BUDGET_ENV]) ??
    file.readByteBudget ??
    READ_IMAGE_BYTE_BUDGET;
  return new ImageLimits(env, { maxEdgePx, readByteBudget });
}

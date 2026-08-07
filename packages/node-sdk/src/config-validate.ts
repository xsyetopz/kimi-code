/**
 * config.toml validation for the public SDK config RPC surface.
 *
 * Mirrors the v2 engine section registry (import side effects from agent-core)
 * so `kimi doctor` and external hosts validate the same shapes as runtime.
 */

import { parse as parseToml } from "smol-toml";
import { z } from "zod";

import { ConfigRegistry } from "@moonshot-ai/agent-core-v2";
import {
  describeTomlSyntaxError,
  transformTomlData,
} from "@moonshot-ai/agent-core-v2/app/config/toml";

import { ErrorCodes, KimiError } from "#/compat";
import type { KimiConfigValidationIssue } from "#/config-rpc";

const SCHEMALESS_DOMAINS: ReadonlySet<string> = new Set([
  "defaultModel",
  "defaultProvider",
  "modelOverrides",
]);

export function parseConfigString(
  text: string,
  filePath = "config.toml",
): Record<string, unknown> {
  let data: Record<string, unknown> = {};
  if (text.trim().length > 0) {
    try {
      data = parseToml(text) as Record<string, unknown>;
    } catch (error) {
      throw new KimiError(
        ErrorCodes.CONFIG_INVALID,
        `Invalid TOML in ${filePath}: ${describeTomlSyntaxError(error)}`,
        { cause: error },
      );
    }
  }

  const registry = new ConfigRegistry();
  const transformed = transformTomlData(data, registry);
  const issues: KimiConfigValidationIssue[] = [];

  for (const [domain, value] of Object.entries(transformed)) {
    if (registry.getSection(domain) === undefined) {
      if (!SCHEMALESS_DOMAINS.has(domain)) continue;
      continue;
    }
    try {
      registry.validate(domain, value);
    } catch (error) {
      if (!(error instanceof z.ZodError)) throw error;
      for (const issue of error.issues) {
        issues.push({
          path: [
            domain,
            ...issue.path.map((segment) =>
              typeof segment === "number" ? segment : String(segment),
            ),
          ],
          message: issue.message,
        });
      }
    }
  }

  if (issues.length > 0) {
    throw new KimiError(ErrorCodes.CONFIG_INVALID, "config validation failed", {
      details: { validationIssues: issues },
    });
  }

  return transformed;
}

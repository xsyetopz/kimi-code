/**
 * Pure mapping between the agent-core-v2 session shapes and the v1 SDK wire
 * shapes. Two gaps are bridged here:
 * - the v2 `ISessionIndex` summary carries no filesystem facts, so the v1
 *   `SessionSummary`'s `workDir` / `sessionDir` come in as pre-resolved
 *   `SessionSummaryFacts` (the caller derives them from `ISessionContext`,
 *   `IBootstrapService.sessionDir`, and the workspace catalog);
 * - the v2 `SessionMeta` document keeps epoch-ms timestamps and a `cwd` field
 *   where the v1 `SessionMeta` keeps ISO strings and `workDir`.
 * Everything else is a field rename (`custom` ↔ `metadata`).
 */
import type { AgentMeta, SessionMeta } from "#/compat";
import type {
  AgentMeta as V2AgentMeta,
  SessionMeta as V2SessionMeta,
} from "@moonshot-ai/agent-core-v2/session/sessionMetadata/sessionMetadata";
import type { SessionSummary as V2SessionSummary } from "@moonshot-ai/agent-core-v2/app/sessionIndex/sessionIndex";

import { resolve, win32 } from "node:path";

import type { JsonObject, SessionSummary } from "#/types";

/**
 * Mirror of v1's `normalizeWorkDir` (`agent-core/session/store/workdir-key`):
 * Windows-shaped paths resolve through `win32` and fold to forward slashes,
 * everything else resolves against the process cwd. Duplicated here because
 * the SDK test config aliases `@moonshot-ai/kimi-code-sdk` to its index, which
 * blocks the deep import — keep it byte-identical to the v1 original.
 */
export function normalizeWorkDir(workDir: string): string {
  if (
    /^[A-Za-z]:[\\/]/.test(workDir) ||
    /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(workDir)
  ) {
    return win32.resolve(workDir).replaceAll("\\", "/");
  }
  return resolve(workDir);
}

/** v1 summary fields the v2 index summary does not carry, resolved by the caller. */
export interface SessionSummaryFacts {
  readonly workDir: string;
  readonly sessionDir: string;
  readonly additionalDirs?: readonly string[];
}

export function v2SummaryToSessionSummary(
  summary: V2SessionSummary,
  facts: SessionSummaryFacts,
): SessionSummary {
  const mapped = {
    id: summary.id,
    workDir: facts.workDir,
    sessionDir: facts.sessionDir,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    archived: summary.archived,
  };
  return {
    ...mapped,
    ...(summary.title !== undefined ? { title: summary.title } : {}),
    ...(summary.lastPrompt !== undefined
      ? { lastPrompt: summary.lastPrompt }
      : {}),
    ...(summary.custom !== undefined
      ? { metadata: summary.custom as JsonObject }
      : {}),
    ...(facts.additionalDirs !== undefined
      ? { additionalDirs: facts.additionalDirs }
      : {}),
  } satisfies SessionSummary;
}

/**
 * v1's `SessionMeta` types `title` / `isCustomTitle` / `custom` as required;
 * a v2 document that never set them reports the same neutral values v1's
 * defaults produce (`''` / `false` / `{}`). Timestamps convert epoch ms → ISO.
 */
export function v2MetaToSessionMeta(meta: V2SessionMeta): SessionMeta {
  const mapped = {
    createdAt: new Date(meta.createdAt).toISOString(),
    updatedAt: new Date(meta.updatedAt).toISOString(),
    title: meta.title ?? "",
    isCustomTitle: meta.isCustomTitle ?? false,
    agents: v2AgentsToV1(meta.agents ?? {}),
    custom: (meta.custom ?? {}) as Record<string, unknown>,
  };
  return {
    ...mapped,
    ...(meta.lastPrompt !== undefined ? { lastPrompt: meta.lastPrompt } : {}),
    ...(meta.forkedFrom !== undefined
      ? { forkedFrom: meta.forkedFrom }
      : {}),
    ...(meta.cwd !== undefined ? { workDir: meta.cwd } : {}),
  } satisfies SessionMeta;
}

function v2AgentsToV1(
  agents: Readonly<Record<string, V2AgentMeta>>,
): Record<string, AgentMeta> {
  const mapped: Record<string, AgentMeta> = {};
  for (const [agentId, agent] of Object.entries(agents)) {
    const v1 = {
      // v2 registers every agent with a type; the fallbacks only cover
      // documents written before that registration existed.
      type: agent.type ?? (agentId === "main" ? "main" : "sub"),
      // v1 persists an explicit null for a parentless agent where v2 leaves
      // the field unset.
      parentAgentId: agent.parentAgentId ?? null,
    };
    mapped[agentId] = {
      ...v1,
      ...(agent.homedir !== undefined ? { homedir: agent.homedir } : {}),
      ...(agent.swarmItem !== undefined ? { swarmItem: agent.swarmItem } : {}),
    } satisfies AgentMeta;
  }
  return mapped;
}

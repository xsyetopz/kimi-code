/**
 * `sessionSwarm` domain — swarm worker-pool configuration section.
 *
 * Owns the `[swarm]` configuration section (`max_concurrent_workers` on disk)
 * together with the `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY` env override
 * (precedence: env > config.toml > default 3). While the env var is set,
 * `stripEnvBoundFields` restores the env-free raw value before persistence.
 * `resolveSwarmMaxConcurrency` is the single resolver used by
 * `SessionSwarmService`.
 */

import { z } from "zod";

import {
  envBindings,
  stripEnvBoundFields,
  type EnvBindings,
  type IConfigService,
} from "#/app/config/config";
import { registerConfigSection } from "#/app/config/configSectionContributions";

import {
  AGENT_SWARM_MAX_CONCURRENCY_ENV,
  DEFAULT_SWARM_MAX_CONCURRENCY,
  resolveSwarmMaxConcurrencyFromEnv,
} from "./agentRunBatch";

export const SWARM_SECTION = "swarm";

export const DEFAULT_ORCHESTRATOR_PROFILE_NAME = "orchestrator";
export const DEFAULT_PLAN_LANE_RESERVED_SLOTS = 1;

export const SwarmConfigSchema = z.object({
  maxConcurrentWorkers: z.number().int().positive().optional(),
  orchestratorProfile: z.string().min(1).optional(),
  planLaneReservedSlots: z.number().int().nonnegative().optional(),
});

export type SwarmConfig = z.infer<typeof SwarmConfigSchema>;

function parseMaxConcurrencyEnv(raw: string): number | undefined {
  const parsed = Number(raw.trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export const swarmEnvBindings: EnvBindings<SwarmConfig> = envBindings(
  SwarmConfigSchema,
  {
    maxConcurrentWorkers: {
      env: AGENT_SWARM_MAX_CONCURRENCY_ENV,
      parse: parseMaxConcurrencyEnv,
    },
  },
);

export const stripSwarmEnv = stripEnvBoundFields(swarmEnvBindings);

registerConfigSection(SWARM_SECTION, SwarmConfigSchema, {
  defaultValue: {
    maxConcurrentWorkers: DEFAULT_SWARM_MAX_CONCURRENCY,
    orchestratorProfile: DEFAULT_ORCHESTRATOR_PROFILE_NAME,
    planLaneReservedSlots: DEFAULT_PLAN_LANE_RESERVED_SLOTS,
  },
  env: swarmEnvBindings,
  stripEnv: stripSwarmEnv,
});

export function resolveSwarmMaxConcurrency(config: IConfigService): number {
  const envValue = resolveSwarmMaxConcurrencyFromEnv();
  if (envValue !== undefined) return envValue;
  const section = config.get<SwarmConfig | undefined>(SWARM_SECTION);
  return section?.maxConcurrentWorkers ?? DEFAULT_SWARM_MAX_CONCURRENCY;
}

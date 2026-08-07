/**
 * `sessionSwarm` domain — orchestrator profile and plan-lane helpers.
 *
 * Resolves the configured orchestrator profile name, detects orchestrator
 * callers, and computes how many worker-pool slots to reserve while the
 * orchestrator is in plan mode or running an active goal.
 */

import type { IAgentScopeHandle } from "#/_base/di/scope";
import { IAgentGoalService } from "#/agent/goal/goal";
import { IAgentPlanService } from "#/agent/plan/plan";
import { IAgentProfileService } from "#/agent/profile/profile";
import type { IConfigService } from "#/app/config/config";
import { IAgentLifecycleService } from "#/session/agentLifecycle/agentLifecycle";

import {
  DEFAULT_ORCHESTRATOR_PROFILE_NAME,
  DEFAULT_PLAN_LANE_RESERVED_SLOTS,
  SWARM_SECTION,
  type SwarmConfig,
} from "./configSection";

export {
  DEFAULT_ORCHESTRATOR_PROFILE_NAME,
  DEFAULT_PLAN_LANE_RESERVED_SLOTS,
};

export function resolveOrchestratorProfileName(config: IConfigService): string {
  const section = config.get<SwarmConfig | undefined>(SWARM_SECTION);
  return section?.orchestratorProfile ?? DEFAULT_ORCHESTRATOR_PROFILE_NAME;
}

export function isOrchestratorProfileName(
  profileName: string | undefined,
  config: IConfigService,
): boolean {
  if (profileName === undefined) return false;
  return profileName === resolveOrchestratorProfileName(config);
}

export function resolvePlanLaneReservedSlots(config: IConfigService): number {
  const section = config.get<SwarmConfig | undefined>(SWARM_SECTION);
  return section?.planLaneReservedSlots ?? DEFAULT_PLAN_LANE_RESERVED_SLOTS;
}

export async function resolveOrchestratorLaneReservation(
  lifecycle: IAgentLifecycleService,
  callerAgentId: string,
  config: IConfigService,
): Promise<number> {
  const handle = lifecycle.get(callerAgentId);
  if (handle === undefined) return 0;
  return resolveOrchestratorLaneReservationForHandle(handle, config);
}

export async function resolveOrchestratorLaneReservationForHandle(
  handle: IAgentScopeHandle,
  config: IConfigService,
): Promise<number> {
  const profileName = handle.accessor.get(IAgentProfileService)?.data().profileName;
  if (!isOrchestratorProfileName(profileName, config)) return 0;

  const planService = handle.accessor.get(IAgentPlanService);
  const planActive =
    planService !== undefined && (await planService.status()) !== null;

  const goalService = handle.accessor.get(IAgentGoalService);
  const goalActive = goalService?.getGoal().goal?.status === "active";

  if (!planActive && !goalActive) return 0;
  return resolvePlanLaneReservedSlots(config);
}

export function effectiveSwarmWorkerConcurrency(
  maxWorkers: number,
  reservedLanes: number,
): number {
  if (reservedLanes <= 0) return maxWorkers;
  return Math.max(1, maxWorkers - reservedLanes);
}

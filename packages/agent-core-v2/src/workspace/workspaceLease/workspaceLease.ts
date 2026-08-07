/**
 * `workspaceLease` domain — swarm path ownership lease contract.
 *
 * Defines `IWorkspaceLeaseService`, the Workspace-scope owner of short-lived
 * exclusive write leases over workspace paths. Each lease records the owning
 * agent id and an expiry time; callers acquire before a swarm worker touches a
 * `swarmItem` path and release when the worker task ends. Workspace-scoped.
 */

import {
  createDecorator,
  type ServiceIdentifier,
} from "#/_base/di/instantiation";

export interface WorkspaceLeaseAcquireInput {
  readonly path: string;
  readonly ownerAgentId: string;
  readonly ttlMs: number;
}

export interface WorkspaceLeaseRecord {
  readonly path: string;
  readonly ownerAgentId: string;
  readonly expiresAt: number;
}

export interface IWorkspaceLeaseService {
  readonly _serviceBrand: undefined;

  acquire(input: WorkspaceLeaseAcquireInput): void;
  release(path: string, ownerAgentId: string): void;
  releaseAll(ownerAgentId: string): void;
  ownerForPath(path: string): string | undefined;
  isWriteAllowed(agentId: string, path: string): boolean;
  snapshot(): readonly WorkspaceLeaseRecord[];
}

export const IWorkspaceLeaseService: ServiceIdentifier<IWorkspaceLeaseService> =
  createDecorator<IWorkspaceLeaseService>("workspaceLeaseService");

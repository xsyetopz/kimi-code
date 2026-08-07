/**
 * `workspaceLease` domain — `IWorkspaceLeaseService` implementation.
 *
 * Holds in-memory exclusive path leases keyed by normalized absolute paths.
 * Expired entries are pruned on every read and write. Path containment uses
 * the shared lexical `isWithinDirectory` guard so a lease on a directory
 * covers descendants. Bound at Workspace scope.
 */

import { resolve } from "node:path";

import {
  LifecycleScope,
  ScopeActivation,
  registerScopedService,
} from "#/_base/di/scope";
import { Error2, ErrorCodes } from "#/errors";
import { isWithinDirectory } from "#/tool/path-access";
import { IWorkspaceContext } from "#/workspace/workspaceContext/workspaceContext";

import {
  IWorkspaceLeaseService,
  type WorkspaceLeaseAcquireInput,
  type WorkspaceLeaseRecord,
} from "./workspaceLease";

export class WorkspaceLeaseService implements IWorkspaceLeaseService {
  declare readonly _serviceBrand: undefined;

  private readonly leases = new Map<string, WorkspaceLeaseRecord>();

  constructor(
    @IWorkspaceContext private readonly workspace: IWorkspaceContext,
  ) {}

  acquire(input: WorkspaceLeaseAcquireInput): void {
    this.pruneExpired();
    const path = this.normalize(input.path);
    const existing = this.leases.get(path);
    const now = Date.now();
    if (
      existing !== undefined &&
      existing.ownerAgentId !== input.ownerAgentId &&
      existing.expiresAt > now
    ) {
      throw new Error2(
        ErrorCodes.VALIDATION_FAILED,
        `Path "${path}" is already leased to another agent.`,
        {
          details: {
            path,
            ownerAgentId: existing.ownerAgentId,
            requestedOwnerAgentId: input.ownerAgentId,
          },
        },
      );
    }
    this.leases.set(path, {
      path,
      ownerAgentId: input.ownerAgentId,
      expiresAt: now + input.ttlMs,
    });
  }

  release(path: string, ownerAgentId: string): void {
    const normalized = this.normalize(path);
    const existing = this.leases.get(normalized);
    if (existing?.ownerAgentId === ownerAgentId) {
      this.leases.delete(normalized);
    }
  }

  releaseAll(ownerAgentId: string): void {
    for (const [path, lease] of this.leases) {
      if (lease.ownerAgentId === ownerAgentId) {
        this.leases.delete(path);
      }
    }
  }

  ownerForPath(path: string): string | undefined {
    this.pruneExpired();
    const target = this.normalize(path);
    let match: WorkspaceLeaseRecord | undefined;
    for (const lease of this.leases.values()) {
      if (!isWithinDirectory(target, lease.path)) continue;
      if (match === undefined || lease.path.length > match.path.length) {
        match = lease;
      }
    }
    return match?.ownerAgentId;
  }

  isWriteAllowed(agentId: string, path: string): boolean {
    const owner = this.ownerForPath(path);
    return owner === undefined || owner === agentId;
  }

  snapshot(): readonly WorkspaceLeaseRecord[] {
    this.pruneExpired();
    return [...this.leases.values()];
  }

  private normalize(path: string): string {
    return resolve(path);
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [path, lease] of this.leases) {
      if (lease.expiresAt <= now) {
        this.leases.delete(path);
      }
    }
  }
}

registerScopedService(
  LifecycleScope.Workspace,
  IWorkspaceLeaseService,
  WorkspaceLeaseService,
  ScopeActivation.OnScopeCreated,
  "workspaceLease",
);

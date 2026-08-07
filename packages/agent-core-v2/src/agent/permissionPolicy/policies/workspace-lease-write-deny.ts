import type { ResolvedToolExecutionHookContext } from "#/agent/toolExecutor/toolHooks";
import { IAgentScopeContext } from "#/agent/scopeContext/scopeContext";
import { IWorkspaceLeaseService } from "#/workspace/workspaceLease/workspaceLease";
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from "#/agent/permissionPolicy/types";
import { writeFileAccesses } from "./path-utils";

export class WorkspaceLeaseWriteDenyPermissionPolicyService
  implements PermissionPolicy
{
  readonly name = "workspace-lease-write-deny";

  constructor(
    @IAgentScopeContext private readonly scope: IAgentScopeContext,
    @IWorkspaceLeaseService private readonly leases: IWorkspaceLeaseService,
  ) {}

  evaluate(
    context: ResolvedToolExecutionHookContext,
  ): PermissionPolicyResult | undefined {
    const toolName = context.toolCall.name;
    if (toolName !== "Write" && toolName !== "Edit") return undefined;

    const deniedPath = writeFileAccesses(context).find(
      (access) =>
        !this.leases.isWriteAllowed(this.scope.agentId, access.path),
    );
    if (deniedPath === undefined) return undefined;

    return {
      kind: "deny",
      message:
        "This path is leased to another swarm worker and cannot be written by this agent.",
      reason: { path: deniedPath.path },
    };
  }
}

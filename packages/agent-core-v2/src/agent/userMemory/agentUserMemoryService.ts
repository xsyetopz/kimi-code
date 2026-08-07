/**
 * `agentUserMemory` domain — `IAgentUserMemoryService` implementation.
 *
 * Registers a `contextInjector` provider on the main agent that recalls the
 * App-scope `IUserMemoryService` buffer once per session (first injection
 * only). Bound at Agent scope.
 */

import { Disposable } from "#/_base/di/lifecycle";
import { LifecycleScope, ScopeActivation, registerScopedService } from "#/_base/di/scope";
import { IAgentContextInjectorService } from "#/agent/contextInjector/contextInjector";
import { IAgentScopeContext } from "#/agent/scopeContext/scopeContext";
import { IUserMemoryService } from "#/app/userMemory/userMemory";

import { IAgentUserMemoryService } from "./agentUserMemory";

const MAIN_AGENT_ID = "main";
const USER_MEMORY_INJECTION_VARIANT = "user_memory_recall";

export class AgentUserMemoryService extends Disposable implements IAgentUserMemoryService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
    @IUserMemoryService private readonly memory: IUserMemoryService,
  ) {
    super();
    if (scopeContext.agentId !== MAIN_AGENT_ID) return;
    this._register(
      injector.register(USER_MEMORY_INJECTION_VARIANT, async ({ injectedPositions }) => {
        if (injectedPositions.length > 0) return undefined;
        return this.memory.formatRecallForInjection();
      }),
    );
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentUserMemoryService,
  AgentUserMemoryService,
  ScopeActivation.OnScopeCreated,
  "userMemory",
);

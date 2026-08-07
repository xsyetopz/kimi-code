/**
 * `harnessInterceptor` domain — drains the App-scope interceptor registry
 * into live agent hook slots.
 *
 * Reads `IHarnessInterceptorRegistry` once at agent scope creation and wires
 * each interceptor's `onBeforeSubmitPrompt` handler into the prompt
 * `OrderedHookSlot` and `onBeforeExecuteTool` listener into the tool
 * executor veto event — reusing the existing pipelines instead of adding a
 * parallel dispatch path. Bound at Agent scope.
 */

import { IInstantiationService } from "#/_base/di/instantiation";
import { Disposable } from "#/_base/di/lifecycle";
import {
  LifecycleScope,
  ScopeActivation,
  registerScopedService,
} from "#/_base/di/scope";
import { IHarnessInterceptorRegistry } from "#/app/harnessInterceptor/harnessInterceptorRegistry";
import { IAgentPromptService } from "#/agent/prompt/prompt";
import { IAgentToolExecutorService } from "#/agent/toolExecutor/toolExecutor";

import { IAgentHarnessInterceptorService } from "./harnessInterceptor";

function hookId(name: string): string {
  return `harness:${name}`;
}

export class AgentHarnessInterceptorService
  extends Disposable
  implements IAgentHarnessInterceptorService
{
  declare readonly _serviceBrand: undefined;

  constructor(
    @IHarnessInterceptorRegistry
    private readonly registry: IHarnessInterceptorRegistry,
    @IInstantiationService private readonly instantiation: IInstantiationService,
  ) {
    super();
    this.wireInterceptors();
  }

  private wireInterceptors(): void {
    const interceptors = this.registry.list();
    if (interceptors.length === 0) return;

    const needsPrompt = interceptors.some(
      (interceptor) => interceptor.hooks.onBeforeSubmitPrompt !== undefined,
    );
    const needsToolExecutor = interceptors.some(
      (interceptor) => interceptor.hooks.onBeforeExecuteTool !== undefined,
    );

    const prompt = needsPrompt
      ? this.instantiation.invokeFunction((accessor) =>
          accessor.get(IAgentPromptService),
        )
      : undefined;
    const toolExecutor = needsToolExecutor
      ? this.instantiation.invokeFunction((accessor) =>
          accessor.get(IAgentToolExecutorService),
        )
      : undefined;

    for (const interceptor of interceptors) {
      const id = hookId(interceptor.name);
      const { hooks } = interceptor;

      if (hooks.onBeforeSubmitPrompt !== undefined) {
        this._register(
          prompt!.hooks.onBeforeSubmitPrompt.register(
            id,
            hooks.onBeforeSubmitPrompt,
          ),
        );
      }

      if (hooks.onBeforeExecuteTool !== undefined) {
        this._register(
          toolExecutor!.onBeforeExecuteTool(hooks.onBeforeExecuteTool),
        );
      }
    }
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentHarnessInterceptorService,
  AgentHarnessInterceptorService,
  ScopeActivation.OnScopeCreated,
  "harnessInterceptor",
);

/**
 * `harnessInterceptor` domain — shared interceptor hook shapes.
 *
 * Harness interceptors plug into the engine's existing hook slots and veto
 * events; these types describe the per-interceptor hook bundle without
 * pulling in scoped services.
 */

import type { PromptSubmitContext } from "#/agent/prompt/prompt";
import type { BeforeToolExecuteEvent } from "#/agent/toolExecutor/toolHooks";
import type { HookHandler } from "#/hooks";

export interface HarnessInterceptorHooks {
  readonly onBeforeSubmitPrompt?: HookHandler<PromptSubmitContext>;
  readonly onBeforeExecuteTool?: (
    event: BeforeToolExecuteEvent,
  ) => void | Promise<void>;
}

export interface HarnessInterceptorDefinition {
  readonly name: string;
  /**
   * Lower values run earlier in the ordered hook pipeline. Ties break on
   * `name` lexicographically.
   */
  readonly priority: number;
  readonly hooks: HarnessInterceptorHooks;
}

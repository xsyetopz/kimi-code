/**
 * `harnessInterceptor` domain — Agent-scope harness interceptor wiring
 * contract.
 *
 * The implementation drains the App-scope registry when an agent scope is
 * created and registers each interceptor into the existing hook slots /
 * veto events owned by `prompt` and `toolExecutor`.
 */

import { createDecorator } from "#/_base/di/instantiation";

export interface IAgentHarnessInterceptorService {
  readonly _serviceBrand: undefined;
}

export const IAgentHarnessInterceptorService =
  createDecorator<IAgentHarnessInterceptorService>(
    "agentHarnessInterceptorService",
  );

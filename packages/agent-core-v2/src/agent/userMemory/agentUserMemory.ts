/**
 * `agentUserMemory` domain — Agent-scope user-memory recall bridge.
 *
 * Registers a `contextInjector` provider that injects a bounded recall of the
 * App-scope `IUserMemoryService` buffer on the first turn of a session.
 */

import {
  createDecorator,
  type ServiceIdentifier,
} from "#/_base/di/instantiation";

export interface IAgentUserMemoryService {
  readonly _serviceBrand: undefined;
}

export const IAgentUserMemoryService: ServiceIdentifier<IAgentUserMemoryService> =
  createDecorator<IAgentUserMemoryService>("agentUserMemoryService");

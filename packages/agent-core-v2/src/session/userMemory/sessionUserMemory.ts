/**
 * `sessionUserMemory` domain — Session-scope user-memory lifecycle bridge.
 *
 * Registers `onWillCloseSession` to stage a rule-based session summary into
 * the App-scope `IUserMemoryService` `CURRENT` buffer.
 */

import {
  createDecorator,
  type ServiceIdentifier,
} from "#/_base/di/instantiation";

export interface ISessionUserMemoryService {
  readonly _serviceBrand: undefined;
}

export const ISessionUserMemoryService: ServiceIdentifier<ISessionUserMemoryService> =
  createDecorator<ISessionUserMemoryService>("sessionUserMemoryService");

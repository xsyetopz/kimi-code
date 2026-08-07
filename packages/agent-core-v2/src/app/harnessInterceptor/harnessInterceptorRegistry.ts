/**
 * `harnessInterceptor` domain — App-scope harness interceptor registry
 * contract.
 *
 * In-process harness hosts register ordered interceptors here; each live
 * agent scope drains the registry at creation time and wires the hooks into
 * the existing `onBeforeSubmitPrompt` / `onBeforeExecuteTool` surfaces.
 * App-scoped.
 */

import {
  createDecorator,
  type ServiceIdentifier,
} from "#/_base/di/instantiation";
import type { IDisposable } from "#/_base/di/lifecycle";

import type { HarnessInterceptorDefinition } from "./types";

export interface IHarnessInterceptorRegistry {
  readonly _serviceBrand: undefined;

  register(definition: HarnessInterceptorDefinition): IDisposable;
  unregister(name: string): boolean;
  list(): readonly HarnessInterceptorDefinition[];
}

export const IHarnessInterceptorRegistry: ServiceIdentifier<IHarnessInterceptorRegistry> =
  createDecorator<IHarnessInterceptorRegistry>("harnessInterceptorRegistry");

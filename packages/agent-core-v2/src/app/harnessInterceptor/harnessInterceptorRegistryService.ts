/**
 * `harnessInterceptor` domain — `IHarnessInterceptorRegistry` implementation.
 *
 * Holds ordered harness interceptor definitions for in-process hosts. Each
 * agent scope drains this registry once at creation and wires hooks into the
 * existing prompt / tool-executor surfaces. Bound at App scope.
 */

import { Disposable, type IDisposable } from "#/_base/di/lifecycle";
import {
  LifecycleScope,
  ScopeActivation,
  registerScopedService,
} from "#/_base/di/scope";
import { BugIndicatingError } from "#/errors";

import { IHarnessInterceptorRegistry } from "./harnessInterceptorRegistry";
import type { HarnessInterceptorDefinition } from "./types";

function compareInterceptors(
  a: HarnessInterceptorDefinition,
  b: HarnessInterceptorDefinition,
): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.name.localeCompare(b.name);
}

export class HarnessInterceptorRegistryService
  extends Disposable
  implements IHarnessInterceptorRegistry
{
  declare readonly _serviceBrand: undefined;
  private readonly byName = new Map<string, HarnessInterceptorDefinition>();

  register(definition: HarnessInterceptorDefinition): IDisposable {
    if (this.byName.has(definition.name)) {
      throw new BugIndicatingError(
        `Harness interceptor '${definition.name}' is already registered`,
      );
    }
    this.byName.set(definition.name, definition);
    return this._register({
      dispose: () => {
        this.byName.delete(definition.name);
      },
    });
  }

  unregister(name: string): boolean {
    return this.byName.delete(name);
  }

  list(): readonly HarnessInterceptorDefinition[] {
    return [...this.byName.values()].toSorted(compareInterceptors);
  }
}

registerScopedService(
  LifecycleScope.App,
  IHarnessInterceptorRegistry,
  HarnessInterceptorRegistryService,
  ScopeActivation.OnScopeCreated,
  "harnessInterceptor",
);

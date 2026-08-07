/**
 * `auth` domain — App-scope registration of the OpenCode account adapter.
 *
 * Creates the provider-owned adapter with Kimi-owned protected credential
 * storage rooted by `bootstrap`, registers it with the auth integration
 * catalog, and removes that registration when the App scope is disposed.
 * Bound at App scope.
 */

import { FileTokenStorage } from "@moonshot-ai/kimi-code-oauth";
import { join } from "pathe";

import {
  createDecorator,
  type ServiceIdentifier,
} from "#/_base/di/instantiation";
import { Disposable, toDisposable } from "#/_base/di/lifecycle";
import {
  LifecycleScope,
  ScopeActivation,
  registerScopedService,
} from "#/_base/di/scope";
import { IBootstrapService } from "#/app/bootstrap/bootstrap";

import { OpenCodeAuthAdapter } from "./opencodeAuthAdapter";
import {
  getProviderAuthAdapter,
  registerProviderAuthAdapter,
} from "./providerAuth";

export interface IOpenCodeAuthAdapterRegistration {
  readonly _serviceBrand: undefined;
}

export const IOpenCodeAuthAdapterRegistration: ServiceIdentifier<IOpenCodeAuthAdapterRegistration> =
  createDecorator<IOpenCodeAuthAdapterRegistration>(
    "opencodeAuthAdapterRegistration",
  );

export class OpenCodeAuthAdapterRegistration
  extends Disposable
  implements IOpenCodeAuthAdapterRegistration
{
  declare readonly _serviceBrand: undefined;

  constructor(@IBootstrapService bootstrap: IBootstrapService) {
    super();
    // The registry is process-wide while App scopes may be created more than
    // once by hosts/tests. Reuse the first official adapter rather than
    // failing a second scope during construction.
    if (getProviderAuthAdapter("opencode") !== undefined) return;
    const adapter = new OpenCodeAuthAdapter({
      storage: new FileTokenStorage(
        join(bootstrap.homeDir, bootstrap.scope("credentials")),
      ),
    });
    this._register(toDisposable(registerProviderAuthAdapter(adapter)));
  }
}

registerScopedService(
  LifecycleScope.App,
  IOpenCodeAuthAdapterRegistration,
  OpenCodeAuthAdapterRegistration,
  ScopeActivation.OnScopeCreated,
  "auth",
);

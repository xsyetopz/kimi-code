/**
 * `auth` domain — App-scope registration of the GitHub Copilot account adapter.
 *
 * Creates the provider-owned adapter with Kimi-owned protected credential
 * storage rooted by `bootstrap`, registers it with the auth integration
 * catalog when the experimental flag is enabled, and removes that
 * registration when the App scope is disposed. Bound at App scope.
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
import { IFlagService } from "#/app/flag/flag";

import { CopilotAuthAdapter } from "./copilotAuthAdapter";
import { COPILOT_OAUTH_FLAG_ID } from "./flag";
import {
  getProviderAuthAdapter,
  registerProviderAuthAdapter,
} from "./providerAuth";

export interface ICopilotAuthAdapterRegistration {
  readonly _serviceBrand: undefined;
}

export const ICopilotAuthAdapterRegistration: ServiceIdentifier<ICopilotAuthAdapterRegistration> =
  createDecorator<ICopilotAuthAdapterRegistration>(
    "copilotAuthAdapterRegistration",
  );

export class CopilotAuthAdapterRegistration
  extends Disposable
  implements ICopilotAuthAdapterRegistration
{
  declare readonly _serviceBrand: undefined;

  constructor(
    @IBootstrapService bootstrap: IBootstrapService,
    @IFlagService flags: IFlagService,
  ) {
    super();
    if (!flags.enabled(COPILOT_OAUTH_FLAG_ID)) return;
    // The registry is process-wide while App scopes may be created more than
    // once by hosts/tests. Reuse the first official adapter rather than
    // failing a second scope during construction.
    if (getProviderAuthAdapter("github-copilot") !== undefined) return;
    const adapter = new CopilotAuthAdapter({
      storage: new FileTokenStorage(
        join(bootstrap.homeDir, bootstrap.scope("credentials")),
      ),
    });
    this._register(toDisposable(registerProviderAuthAdapter(adapter)));
  }
}

registerScopedService(
  LifecycleScope.App,
  ICopilotAuthAdapterRegistration,
  CopilotAuthAdapterRegistration,
  ScopeActivation.OnScopeCreated,
  "auth",
);

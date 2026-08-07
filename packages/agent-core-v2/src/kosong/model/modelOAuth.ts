/**
 * `kosong/model` domain — the OAuth token port.
 *
 * Kosong needs OAuth tokens at model-assembly time: probing the cached
 * credential state (catalog listings) and building the refreshable request
 * auth closure. The port is owned here so kosong stays free of the
 * `app/auth` service; the implementation lives in the upper layer, which
 * delegates to `IOAuthService` and owns the `auth.login_required` error
 * contract.
 */

import {
  createDecorator,
  type ServiceIdentifier,
} from "#/_base/di/instantiation";

import type { OAuthRef } from "../provider/provider";

export interface IModelOAuthTokens {
  readonly _serviceBrand: undefined;

  hasCachedAccessToken(provider: string, oauthRef: OAuthRef): Promise<boolean>;
  getAccessToken(
    provider: string,
    oauthRef: OAuthRef,
    options?: { readonly force?: boolean },
  ): Promise<string>;

  /**
   * Resolve a provider-owned token when its official SDK keeps credentials
   * outside kimi's serialized OAuthRef config (for example OpenCode account
   * OAuth, Codex, or Copilot). Optional so existing hosts can remain key-only.
   */
  getExternalAccessToken?(
    provider: string,
    providerType?: string,
    options?: { readonly force?: boolean },
  ): Promise<string | undefined>;

  /**
   * Resolve provider-owned per-request headers when external OAuth is active
   * (for example Codex `ChatGPT-Account-Id`).
   */
  getExternalRequestHeaders?(
    provider: string,
    providerType?: string,
  ): Promise<Record<string, string> | undefined>;
}

export const IModelOAuthTokens: ServiceIdentifier<IModelOAuthTokens> =
  createDecorator<IModelOAuthTokens>("modelOAuthTokens");

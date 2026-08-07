/**
 * `auth` domain — `IAuthSummaryService` implementation.
 *
 * Summarizes OAuth provider login state and validates model auth readiness
 * before a session starts. Bound at App scope.
 */

import {
  LifecycleScope,
  ScopeActivation,
  registerScopedService,
} from "#/_base/di/scope";
import { ILogService } from "#/_base/log/log";
import { IConfigService } from "#/app/config/config";
import {
  effectiveModelConfig,
  nonEmpty,
  resolveModelAuthMaterial,
} from "#/kosong/model/modelAuth";
import { IModelService } from "#/kosong/model/model";
import { IProviderService } from "#/kosong/provider/provider";
import {
  getProviderAuthAdapter,
  getProviderAuthIntegration,
} from "./providerAuth";
import {
  AuthModelNotResolvedError,
  AuthProvisioningRequiredError,
  AuthTokenMissingError,
  type AuthStatus,
  IAuthSummaryService,
  IOAuthService,
} from "./auth";
import {
  isProviderlessModel,
  providerNameFromFlatModel,
} from "./authService.catalog";

export class AuthSummaryService implements IAuthSummaryService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IProviderService private readonly providerService: IProviderService,
    @IModelService private readonly modelService: IModelService,
    @IConfigService private readonly config: IConfigService,
    @IOAuthService private readonly oauth: IOAuthService,
    @ILogService private readonly log: ILogService,
  ) {}

  async summarize(): Promise<readonly AuthStatus[]> {
    const providers = this.providerService.list();
    const oauthProviders = Object.entries(providers).filter(
      ([name, config]) => {
        if (config.oauth !== undefined) return true;
        const integration = getProviderAuthIntegration(name, config.type);
        return (
          integration?.kind === "external-oauth" &&
          getProviderAuthAdapter(name, config.type) !== undefined
        );
      },
    );
    this.log.info("auth summarize: enter", {
      total: Object.keys(providers).length,
      oauthProviders: oauthProviders.map(([name]) => name),
    });
    const statuses: AuthStatus[] = [];
    for (const [name] of oauthProviders) {
      try {
        statuses.push(await this.oauth.status(name));
      } catch (error) {
        this.log.warn("auth summarize: status threw", {
          provider: name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return statuses;
  }

  async ensureReady(modelOverride?: string): Promise<void> {
    await this.config.reload();
    const providers = this.providerService.list();
    const models = this.modelService.list();
    const modelId = modelOverride ?? this.modelService.getDefaultModel();
    const configured =
      modelId === undefined || modelId === "" ? undefined : models[modelId];
    if (
      Object.keys(providers).length === 0 &&
      !isProviderlessModel(configured)
    ) {
      throw new AuthProvisioningRequiredError();
    }
    if (modelId === undefined || modelId === "") {
      throw new AuthModelNotResolvedError(undefined);
    }
    if (configured === undefined) {
      throw new AuthModelNotResolvedError(modelId);
    }

    const model = effectiveModelConfig(configured);
    const providerId = model.providerId ?? model.provider;
    const provider =
      providerId === undefined
        ? undefined
        : this.providerService.get(providerId);
    if (providerId !== undefined && provider === undefined) {
      throw new AuthModelNotResolvedError(modelId, providerId);
    }

    const providerName = providerId ?? providerNameFromFlatModel(model);
    if (providerName === undefined) {
      throw new AuthModelNotResolvedError(modelId);
    }

    const auth = resolveModelAuthMaterial({
      modelId,
      model,
      provider,
      providerName,
    });
    if (auth.apiKey !== undefined) return;
    if (auth.oauth !== undefined) {
      const providerKey = auth.oauthProviderKey ?? providerName;
      const token = await this.oauth.getCachedAccessToken(
        providerKey,
        auth.oauth,
      );
      if (nonEmpty(token) !== undefined) return;
      throw new AuthTokenMissingError(providerKey);
    }

    const integration = getProviderAuthIntegration(
      providerName,
      provider?.type,
    );
    if (integration?.kind === "external-oauth") {
      const token = await this.oauth.getCachedAccessToken(providerName);
      if (nonEmpty(token) !== undefined) return;
    }
    throw new AuthTokenMissingError(providerName);
  }
}

registerScopedService(
  LifecycleScope.App,
  IAuthSummaryService,
  AuthSummaryService,
  ScopeActivation.OnScopeCreated,
  "auth",
);

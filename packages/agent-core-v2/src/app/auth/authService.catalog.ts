/**
 * `auth` domain — managed OAuth provider catalog helpers.
 *
 * Pure helpers for refreshing the managed Kimi Code provider model catalog
 * and reconciling user-config aliases during OAuth provisioning.
 */

import {
  DeviceCodeTimeoutError,
  OAuthError,
  type ManagedKimiConfigShape,
} from "@moonshot-ai/kimi-code-oauth";
import type { OAuthFlowStatus } from "./oauthProtocol";
import {
  deriveProviderId,
  effectiveModelConfig,
  nonEmpty,
} from "#/kosong/model/modelAuth";
import type { ModelRecord } from "#/kosong/model/model";
import type { OAuthRef, ProviderConfig } from "#/kosong/provider/provider";
import { isOAuthCatalogVendor } from "#/kosong/provider/providerDefinition";

export function classifyFailure(err: unknown): OAuthFlowStatus {
  if (err instanceof DeviceCodeTimeoutError) return "expired";
  if (err instanceof OAuthError) {
    return err.message.toLowerCase().includes("aborted")
      ? "cancelled"
      : "denied";
  }
  return "denied";
}

export function isProviderlessModel(model: ModelRecord | undefined): boolean {
  if (model === undefined) return false;
  const effective = effectiveModelConfig(model);
  return (
    effective.providerId === undefined &&
    effective.provider === undefined &&
    providerNameFromFlatModel(effective) !== undefined
  );
}

export function providerNameFromFlatModel(
  model: ModelRecord,
): string | undefined {
  const baseUrl = nonEmpty(model.baseUrl);
  return baseUrl === undefined ? undefined : deriveProviderId(baseUrl);
}

export interface ManagedModel {
  readonly provider: string;
  readonly model: string;
  readonly maxContextSize: number;
  readonly capabilities?: readonly string[];
  readonly displayName?: string;
}

export function isOAuthCatalogProvider(
  provider: ProviderConfig | Record<string, unknown> | undefined,
): provider is ProviderConfig & { oauth: OAuthRef } {
  const type = (provider as ProviderConfig | undefined)?.type;
  return (
    provider !== undefined &&
    isOAuthCatalogVendor(type) &&
    (provider as ProviderConfig).oauth !== undefined
  );
}

export function collectModelIdsForAliases(
  config: ManagedKimiConfigShape,
  aliasKeys: ReadonlySet<string>,
): Set<string> {
  const ids = new Set<string>();
  for (const aliasKey of aliasKeys) {
    const alias = managedModel(config, aliasKey);
    if (alias !== undefined && alias.model.length > 0) ids.add(alias.model);
  }
  return ids;
}

export function providerAliasKeys(
  config: ManagedKimiConfigShape,
  providerId: string,
): Set<string> {
  const keys = new Set<string>();
  for (const [alias, model] of Object.entries(config.models ?? {})) {
    if ((model as ManagedModel).provider === providerId) keys.add(alias);
  }
  return keys;
}

export function generatedProviderAliasKeys(
  config: ManagedKimiConfigShape,
  providerId: string,
  aliasPrefix: string,
): Set<string> {
  const keys = new Set<string>();
  for (const [alias, model] of Object.entries(config.models ?? {})) {
    if (
      (model as ManagedModel).provider === providerId &&
      alias.startsWith(aliasPrefix)
    ) {
      keys.add(alias);
    }
  }
  return keys;
}

export function computeChanges(
  oldIds: Set<string>,
  newIds: Set<string>,
): { added: number; removed: number } {
  let added = 0;
  for (const id of newIds) {
    if (!oldIds.has(id)) added++;
  }
  let removed = 0;
  for (const id of oldIds) {
    if (!newIds.has(id)) removed++;
  }
  return { added, removed };
}

export function providerModelsEqual(
  config: ManagedKimiConfigShape,
  nextConfig: ManagedKimiConfigShape,
  providerId: string,
  aliasKeys: ReadonlySet<string>,
): boolean {
  return (
    providerModelSnapshot(config, providerId, aliasKeys) ===
    providerModelSnapshot(nextConfig, providerId, aliasKeys)
  );
}

export function providerModelSnapshot(
  config: ManagedKimiConfigShape,
  providerId: string,
  aliasKeys: ReadonlySet<string>,
): string {
  const snapshots: Array<{ alias: string; model: ManagedModel }> = [];
  for (const alias of aliasKeys) {
    const model = managedModel(config, alias);
    if (model === undefined || model.provider !== providerId) continue;
    snapshots.push({
      alias,
      model: {
        ...model,
        capabilities:
          model.capabilities === undefined
            ? undefined
            : model.capabilities.toSorted(),
      },
    });
  }
  snapshots.sort((a, b) => a.alias.localeCompare(b.alias));
  return JSON.stringify(snapshots);
}

export function providerRefreshAliasKeys(
  config: ManagedKimiConfigShape,
  nextConfig: ManagedKimiConfigShape,
  providerId: string,
  aliasPrefix: string,
): Set<string> {
  const keys = generatedProviderAliasKeys(config, providerId, aliasPrefix);
  for (const key of providerAliasKeys(nextConfig, providerId)) keys.add(key);
  return keys;
}

export function preserveUserProviderAliases(
  config: ManagedKimiConfigShape,
  providerId: string,
  refreshedAliasKeys: ReadonlySet<string>,
): Record<string, ManagedModel> {
  const preserved: Record<string, ManagedModel> = {};
  for (const [alias, model] of Object.entries(config.models ?? {})) {
    const entry = model as ManagedModel;
    if (entry.provider !== providerId || refreshedAliasKeys.has(alias))
      continue;
    preserved[alias] = structuredClone(entry);
  }
  return preserved;
}

export function restoreProviderAliases(
  config: ManagedKimiConfigShape,
  aliases: Record<string, ManagedModel>,
): void {
  if (Object.keys(aliases).length === 0) return;
  config.models = {
    ...config.models,
    ...aliases,
  } as ManagedKimiConfigShape["models"];
}

export function restoreDefaultSelection(
  config: ManagedKimiConfigShape,
  defaultModel: string | undefined,
  defaultEnabled: boolean | undefined,
): void {
  if (defaultModel === undefined || config.models?.[defaultModel] === undefined)
    return;
  config.defaultModel = defaultModel;
  const capabilities = managedModel(config, defaultModel)?.capabilities ?? [];
  const enabled = capabilities.includes("always_thinking")
    ? true
    : defaultEnabled;
  if (enabled !== undefined) {
    config.thinking = { ...config.thinking, enabled };
  }
}

export function clampDanglingDefault(config: ManagedKimiConfigShape): void {
  if (
    config.defaultModel !== undefined &&
    config.models?.[config.defaultModel] === undefined
  ) {
    config.defaultModel = undefined;
    config.thinking = undefined;
  }
}

export function managedModel(
  config: ManagedKimiConfigShape,
  alias: string,
): ManagedModel | undefined {
  return config.models?.[alias] as ManagedModel | undefined;
}

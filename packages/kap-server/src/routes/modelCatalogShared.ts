import {
  IConfigService,
  IKosongConfigService,
  IModelCatalog,
  IOAuthService,
  IProviderDiscoveryService,
  isError2,
  ModelsDevImportErrors,
  type Scope,
} from "@moonshot-ai/agent-core-v2";
import {
  DEFAULT_MODEL_SECTION,
  MODELS_SECTION,
  PROVIDERS_SECTION,
} from "@moonshot-ai/agent-core-v2/app/kosongConfig/configSection";
import { z } from "zod";

import { errEnvelope } from "../envelope";
import { ErrorCode } from "../protocol/error-codes";
import type { ProviderCollectionActionBody } from "../protocol/rest-modelCatalog";

export interface ModelCatalogRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  put(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  delete(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

export interface StatusReply {
  code(status: number): StatusReply;
  send(payload?: unknown): unknown;
}

export const providerIdParamSchema = z.object({
  provider_id: z.string().min(1),
});

export const modelActionTailParamSchema = z.object({
  tail: z.string().min(1),
});

export const providerActionTailParamSchema = z.object({
  tail: z.string().min(1),
});

export const providerCollectionActionParamSchema = z.object({
  action: z.string().min(1),
});

export const catalogIdParamSchema = z.object({
  catalog_id: z.string().min(1),
});

export async function loadCatalog(core: Scope): Promise<IModelCatalog> {
  await core.accessor.get(IConfigService).ready;
  return core.accessor.get(IModelCatalog);
}

/**
 * Resolve the config service for the write routes once the kosong persistence
 * bridge is also ready. The bridge subscribes to section changes after the
 * initial hydration; awaiting it guarantees a write below reaches the kosong
 * registries (and the catalog-cache invalidation riding them) before the
 * handler reads back or returns.
 */
export async function loadConfig(core: Scope): Promise<IConfigService> {
  const config = core.accessor.get(IConfigService);
  await config.ready;
  await core.accessor.get(IKosongConfigService).ready;
  return config;
}

export async function loadDiscovery(core: Scope): Promise<IProviderDiscoveryService> {
  await core.accessor.get(IConfigService).ready;
  return core.accessor.get(IProviderDiscoveryService);
}

export async function loadOAuth(core: Scope): Promise<IOAuthService> {
  await core.accessor.get(IConfigService).ready;
  return core.accessor.get(IOAuthService);
}

/**
 * Serializes the provider write routes' multi-step sequences (inspect → build
 * → replace × N). The config service only serializes individual writes, so
 * two interleaved edits could otherwise lose each other's section rebuilds
 * (or land a half-migrated rename). The refresh routes are excluded — the
 * discovery service chains its own runs.
 */
let providerWriteChain: Promise<unknown> = Promise.resolve();

export function enqueueProviderWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = providerWriteChain.then(task, task);
  providerWriteChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Seed the global default model when — and only when — none is configured.
 * Provider writes otherwise never move the default pointers, but a fresh
 * setup has no pointer at all: the first provider added must leave the
 * daemon usable (GET /auth's readiness requires a default model). An
 * existing pointer is never rewritten here, not even a dangling one — it is
 * the user's setting, not this route's to second-guess.
 */
export async function seedDefaultModelWhenUnset(
  config: IConfigService,
  alias: string,
): Promise<void> {
  const current = config.inspect<string>(DEFAULT_MODEL_SECTION).userValue;
  if (current !== undefined && current.trim() !== "") return;
  await config.replace(DEFAULT_MODEL_SECTION, alias);
}

/** Map a coded domain error to the numeric protocol envelope. Returns true if handled. */
export function sendMappedError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
): boolean {
  if (!isError2(err)) return false;
  if (err.code === "provider.not_found") {
    reply.send(
      errEnvelope(
        ErrorCode.PROVIDER_NOT_FOUND,
        err.message,
        requestId,
        err.stack,
      ),
    );
    return true;
  }
  if (err.code === "model.not_found") {
    reply.send(
      errEnvelope(ErrorCode.MODEL_NOT_FOUND, err.message, requestId, err.stack),
    );
    return true;
  }
  return false;
}

/** The engine's provider-import error codes mapped onto the numeric protocol codes. */
const MODELS_DEV_IMPORT_ERROR_CODES: Record<string, number> = {
  [ModelsDevImportErrors.codes.CATALOG_UNAVAILABLE]:
    ErrorCode.CATALOG_UNAVAILABLE,
  [ModelsDevImportErrors.codes.CATALOG_ENTRY_NOT_FOUND]:
    ErrorCode.CATALOG_ENTRY_NOT_FOUND,
  [ModelsDevImportErrors.codes.CATALOG_IMPORT_INVALID]:
    ErrorCode.CATALOG_IMPORT_INVALID,
  [ModelsDevImportErrors.codes.REGISTRY_IMPORT_INVALID]:
    ErrorCode.REGISTRY_IMPORT_INVALID,
  [ModelsDevImportErrors.codes.PROVIDER_OAUTH_MANAGED]:
    ErrorCode.PROVIDER_OAUTH_MANAGED,
};

/** Map a provider-import domain error to the numeric protocol envelope. Returns true if handled. */
export function sendModelsDevImportError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
): boolean {
  if (!isError2(err)) return false;
  const numeric = MODELS_DEV_IMPORT_ERROR_CODES[err.code];
  if (numeric === undefined) return false;
  reply.send(errEnvelope(numeric, err.message, requestId, err.stack));
  return true;
}

import { IModelsDevImportService, type Scope } from "@moonshot-ai/agent-core-v2";

import { okEnvelope } from "../envelope";
import { ErrorCode } from "../protocol/error-codes";
import { errEnvelope } from "../envelope";
import type { ProviderCollectionActionBody } from "../protocol/rest-modelCatalog";
import {
  type StatusReply,
  sendModelsDevImportError,
} from "./modelCatalogShared";

/**
 * The `:import_catalog` collection action. Lives behind `/providers:action`
 * because find-my-way cannot register a static `/providers:import_catalog`
 * next to the in-segment `:action` parameter.
 */
export async function handleImportCatalog(
  req: { id: string; body: ProviderCollectionActionBody | undefined },
  reply: { send(payload: unknown): unknown },
  core: Scope,
): Promise<void> {
  try {
    const body = req.body;
    if (body?.catalog_id === undefined) {
      reply.send(
        errEnvelope(
          ErrorCode.VALIDATION_FAILED,
          "catalog_id is required for :import_catalog",
          req.id,
        ),
      );
      return;
    }

    const result = await core.accessor
      .get(IModelsDevImportService)
      .importModelsDevProvider({
        catalogId: body.catalog_id,
        id: body.id,
        apiKey: body.api_key,
        baseUrl: body.base_url,
      });
    (reply as unknown as StatusReply)
      .code(201)
      .send(
        okEnvelope(
          { provider: result.provider, models_imported: result.modelsImported },
          req.id,
        ),
      );
  } catch (err) {
    if (sendModelsDevImportError(reply, req.id, err)) return;
    throw err;
  }
}

/**
 * The `:import_registry` collection action: fetch a models.dev-shaped private
 * registry (api.json) and apply every entry. The orchestration (fetch +
 * validation + the two persisted remove/apply passes) lives in the engine's
 * `IModelsDevImportService`; this edge only validates the wire body and maps
 * the result and errors.
 */
export async function handleImportRegistry(
  req: { id: string; body: ProviderCollectionActionBody | undefined },
  reply: { send(payload: unknown): unknown },
  core: Scope,
): Promise<void> {
  try {
    const body = req.body;
    if (body?.url === undefined) {
      reply.send(
        errEnvelope(
          ErrorCode.VALIDATION_FAILED,
          "url is required for :import_registry",
          req.id,
        ),
      );
      return;
    }
    const result = await core.accessor
      .get(IModelsDevImportService)
      .importCustomRegistry({
        url: body.url,
        apiKey: body.api_key,
      });
    (reply as unknown as StatusReply)
      .code(201)
      .send(
        okEnvelope(
          {
            providers: result.providers,
            models_imported: result.modelsImported,
          },
          req.id,
        ),
      );
  } catch (err) {
    if (sendModelsDevImportError(reply, req.id, err)) return;
    throw err;
  }
}

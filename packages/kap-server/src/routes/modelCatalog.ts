/**
 * `/models` + `/providers` catalog route handlers — server-v2 port.
 *
 * Implements the v1 model/provider catalog wire contract on top of
 * `agent-core-v2`'s `IModelCatalog` (the remote-discovery refresh lives on
 * `IProviderDiscoveryService`; the OAuth-only managed refresh additionally
 * lives on `IOAuthService`; the models.dev directory browse and the
 * catalog/registry imports live on `IModelsDevImportService`):
 *   GET    /models                       — list configured model aliases
 *   GET    /providers                    — list configured providers
 *   GET    /providers/{provider_id}      — get a configured provider by id
 *   POST   /providers                    — create a provider manually
 *   PUT    /providers/{provider_id}      — replace a provider + rebuild its model aliases
 *   DELETE /providers/{provider_id}      — delete a provider + its model aliases
 *   GET    /catalog/providers            — browse the models.dev directory (proxied)
 *   GET    /catalog/providers/{catalog_id} — get one directory entry
 *   POST   /providers:import_catalog     — import a directory entry as a provider
 *   POST   /models/{tail} (:set_default) — set the global default model alias
 *   POST   /providers:refresh            — refresh ALL refreshable providers
 *   POST   /providers:refresh_oauth      — refresh OAuth-backed provider models
 *   POST   /providers/{tail} (:refresh)  — refresh a single provider by id
 *
 * **Wire fidelity**: reuses agent-core-v2's catalog schemas and the local
 * numeric `ErrorCode` envelope verbatim, so the response shape and error codes
 * (`40412` provider-not-found, `40413` model-not-found, `40001` validation) are
 * byte-for-byte compatible with v1's `routes/modelCatalog.ts`. The v2 domain
 * throws coded `Error2`s (`provider.not_found` / `model.not_found` /
 * `provider.catalog_*` / `provider.*_import_invalid` / `provider.oauth_managed`);
 * this edge maps them to the numeric protocol codes by `code` (never
 * `instanceof`).
 *
 * **Write surface**: create/replace/delete write the user config layer through
 * `IConfigService` (the catalog/registry imports write through
 * `IModelsDevImportService` in the engine — this edge only maps the wire).
 * Replace and delete use whole-section `replace` (deep-merge
 * `set` can never drop a key). One subtlety shapes all the write code below:
 * the providers/models TOML transforms rebuild each section's entries but
 * overlay each entry's fields onto the old on-disk raw — so an entry id
 * absent from the replacement truly disappears, while a FIELD absent from a
 * kept entry would silently survive on disk (and resurrect on the next boot).
 * Field-level clears therefore always assign an explicit `undefined` (the
 * transform's `setDefined` drops those). The kosong
 * persistence bridge then pushes the change into the registries, which is
 * also what invalidates the catalog cache. Multi-step sequences are
 * serialized through `enqueueProviderWrite`.
 */
import {
  IModelsDevImportService,
  SECONDARY_DERIVED_MODEL_ID,
  type Scope,
} from "@moonshot-ai/agent-core-v2";
import { setDefaultModelResponseSchema } from "@moonshot-ai/agent-core-v2/kosong/model/catalog";
import { z } from "zod";

import { errEnvelope, okEnvelope } from "../envelope";
import { defineRoute } from "../middleware/defineRoute";
import { ErrorCode } from "../protocol/error-codes";
import {
  getCatalogProviderResponseSchema,
  listCatalogProvidersResponseSchema,
  listModelsResponseSchema,
  listProvidersResponseSchema,
} from "../protocol/rest-modelCatalog";
import { parseActionSuffix } from "./action-suffix";
import {
  catalogIdParamSchema,
  loadCatalog,
  modelActionTailParamSchema,
  sendMappedError,
  sendModelsDevImportError,
  type ModelCatalogRouteHost,
} from "./modelCatalogShared";
import { registerModelCatalogProviderRoutes } from "./modelCatalogProviders";

export function registerModelCatalogRoutes(
  app: ModelCatalogRouteHost,
  core: Scope,
): void {
  const listModelsRoute = defineRoute(
    {
      method: "GET",
      path: "/models",
      success: { data: listModelsResponseSchema },
      description: "List configured model aliases",
      tags: ["models"],
    },
    async (req, reply) => {
      const items = await (await loadCatalog(core)).listModels();
      // Presentation filter: the secondary-model derived entry is synthesized
      // runtime state, not a configured alias — keep it out of pickers (the
      // catalog still resolves it by id, and the overlay's strip keeps any
      // default-model pointer to it out of config.toml).
      reply.send(
        okEnvelope(
          {
            items: items.filter(
              (item) => item.model !== SECONDARY_DERIVED_MODEL_ID,
            ),
          },
          req.id,
        ),
      );
    },
  );
  app.get(
    listModelsRoute.path,
    listModelsRoute.options,
    listModelsRoute.handler as Parameters<ModelCatalogRouteHost["get"]>[2],
  );

  const setDefaultModelRoute = defineRoute(
    {
      method: "POST",
      path: "/models/{tail}",
      params: modelActionTailParamSchema,
      success: { data: setDefaultModelResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.MODEL_NOT_FOUND]: {},
      },
      description: "Set the global default model alias",
      tags: ["models"],
      operationId: "setDefaultModel",
    },
    async (req, reply) => {
      try {
        const { tail } = req.params;
        const parsed = parseActionSuffix({
          tail,
          allowedActions: ["set_default"] as const,
          resourceLabel: "model",
        });
        if (parsed.kind !== "action") {
          const message =
            parsed.kind === "invalid"
              ? parsed.reason
              : `unsupported action: ${tail}`;
          reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, message, req.id));
          return;
        }
        const result = await (await loadCatalog(core)).setDefaultModel(
          parsed.id,
        );
        reply.send(okEnvelope(result, req.id));
      } catch (err) {
        if (sendMappedError(reply, req.id, err)) return;
        throw err;
      }
    },
  );
  app.post(
    setDefaultModelRoute.path,
    setDefaultModelRoute.options,
    setDefaultModelRoute.handler as Parameters<
      ModelCatalogRouteHost["post"]
    >[2],
  );

  const listProvidersRoute = defineRoute(
    {
      method: "GET",
      path: "/providers",
      success: { data: listProvidersResponseSchema },
      description: "List configured providers",
      tags: ["providers"],
    },
    async (req, reply) => {
      const items = await (await loadCatalog(core)).listProviders();
      reply.send(okEnvelope({ items }, req.id));
    },
  );
  app.get(
    listProvidersRoute.path,
    listProvidersRoute.options,
    listProvidersRoute.handler as Parameters<ModelCatalogRouteHost["get"]>[2],
  );
  registerModelCatalogProviderRoutes(app, core);
  const listCatalogProvidersRoute = defineRoute(
    {
      method: "GET",
      path: "/catalog/providers",
      success: { data: listCatalogProvidersResponseSchema },
      errors: { [ErrorCode.CATALOG_UNAVAILABLE]: {} },
      description:
        "Browse the models.dev directory (server-proxied, 10-minute in-memory cache, built-in snapshot fallback). Entries the server cannot import carry `rejected: true` with a machine-readable `reject_reason`; entries with `needs_base_url: true` require a base URL at import time. Items keep the upstream directory order.",
      tags: ["providers"],
      operationId: "listCatalogProviders",
    },
    async (req, reply) => {
      try {
        const items = await core.accessor
          .get(IModelsDevImportService)
          .listModelsDevProviders();
        reply.send(okEnvelope({ items }, req.id));
      } catch (err) {
        if (sendModelsDevImportError(reply, req.id, err)) return;
        throw err;
      }
    },
  );
  app.get(
    listCatalogProvidersRoute.path,
    listCatalogProvidersRoute.options,
    listCatalogProvidersRoute.handler as Parameters<
      ModelCatalogRouteHost["get"]
    >[2],
  );

  const getCatalogProviderRoute = defineRoute(
    {
      method: "GET",
      path: "/catalog/providers/{catalog_id}",
      params: catalogIdParamSchema,
      success: { data: getCatalogProviderResponseSchema },
      errors: {
        [ErrorCode.CATALOG_ENTRY_NOT_FOUND]: {},
        [ErrorCode.CATALOG_UNAVAILABLE]: {},
      },
      description: "Get one models.dev directory entry by catalog id.",
      tags: ["providers"],
      operationId: "getCatalogProvider",
    },
    async (req, reply) => {
      try {
        const { catalog_id } = req.params;
        const item = await core.accessor
          .get(IModelsDevImportService)
          .getModelsDevProvider(catalog_id);
        reply.send(okEnvelope(item, req.id));
      } catch (err) {
        if (sendModelsDevImportError(reply, req.id, err)) return;
        throw err;
      }
    },
  );
  app.get(
    getCatalogProviderRoute.path,
    getCatalogProviderRoute.options,
    getCatalogProviderRoute.handler as Parameters<
      ModelCatalogRouteHost["get"]
    >[2],
  );
}

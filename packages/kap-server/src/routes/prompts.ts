/**
 * `/api/v1` prompt routes — v1-compatible prompt surface backed directly by
 * the Agent-scoped `prompt` scheduler. This edge applies protocol conversion,
 * request overrides, and metadata updates while preserving the paths and wire
 * shapes from `packages/server/src/routes/prompts.ts`.
 */

import { join } from "node:path";

import {
  IBootstrapService,
  IEventService,
  IFileService,
  ISessionContext,
  ISessionMetadata,
  ProfileError,
  applyPromptMetadataUpdate,
  promptMetadataTextFromContentParts,
  resumeSessionById,
  sessionMediaOriginalsDir,
  Error2,
  ErrorCodes,
  type Scope,
} from "@moonshot-ai/agent-core-v2";
import { z } from "zod";

import { errEnvelope, okEnvelope } from "../envelope";
import { requestLog } from "../lib/requestLog";
import { defineRoute } from "../middleware/defineRoute";
import { ErrorCode } from "../protocol/error-codes";
import {
  promptAbortResponseSchema,
  promptListResponseSchema,
  promptSteerRequestSchema,
  promptSteerResultSchema,
  promptSubmissionSchema,
  promptSubmitResultSchema,
} from "../protocol/rest-prompt";
import { parseActionSuffix } from "./action-suffix";
import { resolvePromptMediaFiles } from "./promptMedia";
import {
  contentToCoreParts,
  projectPromptHandle,
  projectPromptList,
} from "./promptProjection";
import {
  applyProfileSelection,
  assertPromptFileRefs,
  authModelDetailsSchema,
  authProviderDetailsSchema,
  resolvePrompt,
  resolveSession,
  sendMappedError,
  sessionIdParamSchema,
  validationDetailsSchema,
  type PromptRouteHost,
} from "./promptsSupport";

export function registerPromptsRoutes(app: PromptRouteHost, core: Scope): void {
  const listRoute = defineRoute(
    {
      method: "GET",
      path: "/sessions/{session_id}/prompts",
      params: sessionIdParamSchema,
      success: { data: promptListResponseSchema },
      errors: { [ErrorCode.SESSION_NOT_FOUND]: {} },
      description: "List the active prompt and queued prompts for a session",
      tags: ["prompts"],
      operationId: "listPrompts",
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const result = projectPromptList(
          (await resolvePrompt(core, session_id)).prompt.list(),
        );
        reply.send(okEnvelope(result, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.get(
    listRoute.path,
    listRoute.options,
    listRoute.handler as Parameters<PromptRouteHost["get"]>[2],
  );

  const submitRoute = defineRoute(
    {
      method: "POST",
      path: "/sessions/{session_id}/prompts",
      body: promptSubmissionSchema,
      params: sessionIdParamSchema,
      success: { data: promptSubmitResultSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {
          detailsSchema: validationDetailsSchema,
        },
        [ErrorCode.AUTH_PROVISIONING_REQUIRED]: {},
        [ErrorCode.AUTH_TOKEN_MISSING]: {
          detailsSchema: authProviderDetailsSchema,
        },
        [ErrorCode.AUTH_TOKEN_UNAUTHORIZED]: {
          detailsSchema: authProviderDetailsSchema,
        },
        [ErrorCode.AUTH_MODEL_NOT_RESOLVED]: {
          detailsSchema: authModelDetailsSchema,
        },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.PROMPT_ALREADY_COMPLETED]: {
          dataSchema: z.object({ aborted: z.literal(false) }),
        },
      },
      description: "Submit a prompt to a session",
      tags: ["prompts"],
      operationId: "submitPrompt",
    },
    async (req, reply) => {
      const { session_id } = req.params;
      try {
        await assertPromptFileRefs(req.body, core.accessor.get(IFileService));
        const resolved = await resolvePrompt(
          core,
          session_id,
          req.body.agent_id,
        );
        await resolved.auth.ensureReady();

        const resolvedBody = await resolvePromptMediaFiles(
          req.body,
          core.accessor.get(IFileService),
          core.accessor.get(IBootstrapService).cacheDir,
          {
            resolveOriginalsDir: async () => {
              const session = await resumeSessionById(
                core.accessor,
                session_id,
              );
              if (session === undefined) return undefined;
              return sessionMediaOriginalsDir(
                session.accessor.get(ISessionContext).sessionDir,
              );
            },
            resolveAttachmentsDir: async () => {
              const session = await resumeSessionById(
                core.accessor,
                session_id,
              );
              if (session === undefined) return undefined;
              return join(
                session.accessor.get(ISessionContext).sessionDir,
                "attachments",
              );
            },
          },
        );

        let thinkingConsumed = false;
        if (req.body.profile !== undefined) {
          thinkingConsumed =
            (await applyProfileSelection(
              resolved.profile,
              req.body.profile,
              req.body.model,
              req.body.thinking,
            )) && req.body.thinking !== undefined;
        }
        if (req.body.model !== undefined)
          await resolved.profile.setModel(req.body.model);
        if (req.body.thinking !== undefined && !thinkingConsumed)
          resolved.profile.setThinking(req.body.thinking);
        if (req.body.permission_mode !== undefined)
          resolved.permissionMode.setMode(req.body.permission_mode);
        if (req.body.disabled_tools !== undefined) {
          try {
            await resolved.toolPolicy.setSessionDisabledTools(
              req.body.disabled_tools,
            );
          } catch (error) {
            if (error instanceof ProfileError) {
              throw new Error2(ErrorCodes.REQUEST_INVALID, error.message);
            }
            throw error;
          }
        }
        const parts = contentToCoreParts(resolvedBody.content);
        const session = await resolveSession(core, session_id);
        await applyPromptMetadataUpdate(
          {
            metadata: session.accessor.get(ISessionMetadata),
            eventService: core.accessor.get(IEventService),
            sessionId: session_id,
          },
          promptMetadataTextFromContentParts(parts),
        );
        const handle = await resolved.prompt.enqueue({
          message: {
            role: "user",
            content: parts,
            toolCalls: [],
            origin: { kind: "user" },
          },
        });
        reply.send(okEnvelope(projectPromptHandle(handle), req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.post(
    submitRoute.path,
    submitRoute.options,
    submitRoute.handler as Parameters<PromptRouteHost["post"]>[2],
  );

  const steerManyRoute = defineRoute(
    {
      method: "POST",
      path: "/sessions/{session_id}/prompts::steer",
      body: promptSteerRequestSchema,
      params: sessionIdParamSchema,
      success: { data: promptSteerResultSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.PROMPT_NOT_FOUND]: {},
      },
      description: "Steer queued prompts into the active turn",
      tags: ["prompts"],
      operationId: "steerPrompts",
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const resolved = await resolvePrompt(core, session_id);
        await resolved.prompt.steer(req.body.prompt_ids);
        reply.send(
          okEnvelope(
            { steered: true, prompt_ids: [...req.body.prompt_ids] },
            req.id,
          ),
        );
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.post(
    steerManyRoute.path,
    steerManyRoute.options,
    steerManyRoute.handler as Parameters<PromptRouteHost["post"]>[2],
  );

  const actionRoute = defineRoute(
    {
      method: "POST",
      path: "/sessions/{session_id}/prompts/{tail}",
      success: {
        data: z.union([promptAbortResponseSchema, promptSteerResultSchema]),
      },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.PROMPT_NOT_FOUND]: {},
        [ErrorCode.PROMPT_ALREADY_COMPLETED]: {
          dataSchema: z.object({ aborted: z.literal(false) }),
        },
      },
      description: "Abort a running prompt or steer a queued prompt",
      tags: ["prompts"],
      operationId: "promptAction",
    },
    async (req, reply) => {
      try {
        const { session_id, tail } = req.params as {
          session_id: string;
          tail: string;
        };
        const parsed = parseActionSuffix({
          tail,
          allowedActions: ["abort", "steer"] as const,
          resourceLabel: "prompt",
        });
        if (parsed.kind !== "action") {
          const message =
            parsed.kind === "invalid"
              ? parsed.reason
              : `unsupported action: ${tail}`;
          reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, message, req.id));
          return;
        }
        const resolved = await resolvePrompt(core, session_id);
        if (parsed.action === "abort") {
          resolved.prompt.abort(parsed.id);
          requestLog(req)?.info(
            { session_id, prompt_id: parsed.id },
            "prompt aborted",
          );
          reply.send(okEnvelope({ aborted: true }, req.id));
        } else {
          await resolved.prompt.steer([parsed.id]);
          reply.send(
            okEnvelope({ steered: true, prompt_ids: [parsed.id] }, req.id),
          );
        }
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.post(
    actionRoute.path,
    actionRoute.options,
    actionRoute.handler as Parameters<PromptRouteHost["post"]>[2],
  );
}

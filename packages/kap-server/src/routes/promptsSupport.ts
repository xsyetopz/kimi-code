import {
  IAgentLifecycleService,
  IAgentPermissionModeService,
  IAgentProfileService,
  IAgentPromptService,
  IAgentToolPolicyService,
  IAuthSummaryService,
  IFileService,
  ProfileError,
  resumeSessionById,
  isError2,
  Error2,
  ErrorCodes,
  type ISessionScopeHandle,
  type Scope,
} from "@moonshot-ai/agent-core-v2";
import { z } from "zod";

import { errEnvelope } from "../envelope";
import { requestLog } from "../lib/requestLog";
import { ErrorCode } from "../protocol/error-codes";
import type { PromptSubmission } from "../protocol/rest-prompt";
import { ensureMainAgent, MAIN_AGENT_ID } from "../transport/mainAgent";

export interface PromptRouteHost {
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
}

export const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

export const validationDetailsSchema = z.array(
  z.object({ path: z.string(), message: z.string() }),
);
export const authProviderDetailsSchema = z.object({ provider_id: z.string() });
export const authModelDetailsSchema = z
  .object({ model_id: z.string(), provider_id: z.string() })
  .partial();

export async function resolveSession(
  core: Scope,
  sessionId: string,
): Promise<ISessionScopeHandle> {
  // `resume` (not `get`) so a persisted-but-cold session — created by a previous
  // process, by v1, or closed in this one — is loaded from disk instead of
  // being reported as `session.not_found`. Mirrors the snapshot route. Returns
  // `undefined` only when the session is unknown or its workspace is gone.
  const session = await resumeSessionById(core.accessor, sessionId);
  if (session === undefined) {
    throw new Error2(
      "session.not_found",
      `session ${sessionId} does not exist`,
    );
  }
  return session;
}

export async function resolvePrompt(core: Scope, sessionId: string, agentId?: string) {
  return resolvePromptFromSession(
    await resolveSession(core, sessionId),
    agentId,
  );
}

async function resolvePromptFromSession(
  session: ISessionScopeHandle,
  agentId?: string,
) {
  // A prompt may target a forked side-channel agent (e.g. `/btw`) via
  // `body.agent_id`. Default to `main` when absent; only `main` is
  // auto-created — any other id must already exist (forked beforehand), or it
  // is reported as `agent.not_found`.
  const agent =
    agentId === undefined || agentId === MAIN_AGENT_ID
      ? await ensureMainAgent(session)
      : session.accessor.get(IAgentLifecycleService).get(agentId);
  if (agent === undefined) {
    throw new Error2("agent.not_found", `agent ${agentId} does not exist`);
  }
  return {
    prompt: agent.accessor.get(IAgentPromptService),
    auth: agent.accessor.get(IAuthSummaryService),
    profile: agent.accessor.get(IAgentProfileService),
    toolPolicy: agent.accessor.get(IAgentToolPolicyService),
    permissionMode: agent.accessor.get(IAgentPermissionModeService),
  };
}

/**
 * Bind the resolved agent to the profile named by a prompt submission's
 * `profile` field. First-bind semantics live in the engine: a same-name
 * repeat is short-circuited here as a no-op, while an unknown name or a
 * post-bind switch is rejected by `AgentProfileService.bind` with a coded
 * `ProfileError` — this edge only maps it onto 40001. Checking anything
 * beyond the no-op shortcut here would re-introduce a check-then-act window
 * the engine guard has already closed.
 *
 * `model` falls back to the configured default inside the engine. `thinking`
 * rides along in the bind so an unsupported effort rejects atomically —
 * before any state mutation — instead of wedging the session's identity with
 * a successful bind followed by a failed `setThinking`.
 *
 * Returns true when a bind happened (i.e. `thinking` was consumed by it).
 */
export async function applyProfileSelection(
  profile: IAgentProfileService,
  profileName: string,
  model: string | undefined,
  thinking: string | undefined,
): Promise<boolean> {
  if (profile.data().profileName === profileName) return false;
  try {
    await profile.bind({
      profile: profileName,
      model,
      thinking,
      strictThinking: thinking !== undefined,
    });
  } catch (error) {
    if (error instanceof ProfileError) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, error.message);
    }
    throw error;
  }
  return true;
}

/**
 * Fail fast on stale or mis-kinded file references before anything
 * session-scoped happens: a bad `file_id` (unknown, or a real file used with
 * the wrong media kind, e.g. a PDF submitted as a video) must reject the
 * request without creating the prompt agent and without touching the
 * session's model/thinking/permission.
 */
export async function assertPromptFileRefs(
  body: PromptSubmission,
  store: IFileService,
): Promise<void> {
  for (const part of body.content) {
    if (part.type === "file") {
      await store.get(part.file_id);
    } else if (
      (part.type === "image" || part.type === "video") &&
      part.source.kind === "file"
    ) {
      const file = await store.get(part.source.file_id);
      assertMediaFile(file, part.type);
    }
  }
}

export function sendMappedError(
  reply: { send(payload: unknown): unknown },
  req: { id: string },
  err: unknown,
): void {
  const requestId = req.id;
  const log = requestLog(req);
  if (isError2(err)) {
    switch (err.code) {
      case "session.not_found":
      case "agent.not_found":
        reply.send(
          errEnvelope(
            ErrorCode.SESSION_NOT_FOUND,
            err.message,
            requestId,
            err.stack,
          ),
        );
        return;
      case "file.not_found":
        reply.send(
          errEnvelope(
            ErrorCode.FILE_NOT_FOUND,
            err.message,
            requestId,
            err.stack,
          ),
        );
        return;
      case "prompt.not_found":
        reply.send(
          errEnvelope(
            ErrorCode.PROMPT_NOT_FOUND,
            err.message,
            requestId,
            err.stack,
          ),
        );
        return;
      case "session.busy":
        reply.send(
          errEnvelope(
            ErrorCode.SESSION_BUSY,
            err.message,
            requestId,
            err.stack,
          ),
        );
        return;
      case "prompt.already_completed":
        reply.send({
          code: ErrorCode.PROMPT_ALREADY_COMPLETED,
          msg: err.message,
          data: { aborted: false },
          request_id: requestId,
          stack: err.stack,
        });
        return;
      case "request.invalid":
      case "validation.failed":
        reply.send(
          errEnvelope(
            ErrorCode.VALIDATION_FAILED,
            err.message,
            requestId,
            err.stack,
          ),
        );
        return;
      case "auth.provisioning_required":
        reply.send({
          code: ErrorCode.AUTH_PROVISIONING_REQUIRED,
          msg: err.message,
          data: null,
          request_id: requestId,
          stack: err.stack,
          details: null,
        });
        return;
      case "auth.token_missing": {
        const details = authProviderDetails(err);
        if (details === undefined) {
          log?.error({ err }, "prompt request failed");
          reply.send(
            errEnvelope(
              ErrorCode.INTERNAL_ERROR,
              `auth error ${err.code} missing provider_id`,
              requestId,
            ),
          );
          return;
        }
        reply.send({
          code: ErrorCode.AUTH_TOKEN_MISSING,
          msg: err.message,
          data: null,
          request_id: requestId,
          stack: err.stack,
          details,
        });
        return;
      }
      case "auth.token_unauthorized": {
        const details = authProviderDetails(err);
        if (details === undefined) {
          log?.error({ err }, "prompt request failed");
          reply.send(
            errEnvelope(
              ErrorCode.INTERNAL_ERROR,
              `auth error ${err.code} missing provider_id`,
              requestId,
            ),
          );
          return;
        }
        reply.send({
          code: ErrorCode.AUTH_TOKEN_UNAUTHORIZED,
          msg: err.message,
          data: null,
          request_id: requestId,
          stack: err.stack,
          details,
        });
        return;
      }
      case "auth.model_not_resolved":
        reply.send({
          code: ErrorCode.AUTH_MODEL_NOT_RESOLVED,
          msg: err.message,
          data: null,
          request_id: requestId,
          stack: err.stack,
          details: authModelDetails(err),
        });
        return;
    }
  }
  log?.error({ err }, "prompt request failed");
  reply.send(
    errEnvelope(
      ErrorCode.INTERNAL_ERROR,
      err instanceof Error ? err.message : String(err),
      requestId,
      err instanceof Error ? err.stack : undefined,
    ),
  );
}

function authProviderDetails(err: Error2): { provider_id: string } | undefined {
  const providerId = err.details?.["provider_id"];
  if (typeof providerId !== "string") return undefined;
  return { provider_id: providerId };
}

function authModelDetails(
  err: Error2,
): { model_id?: string; provider_id?: string } | null {
  const details: { model_id?: string; provider_id?: string } = {};
  const modelId = err.details?.["model_id"];
  const providerId = err.details?.["provider_id"];
  if (typeof modelId === "string") details.model_id = modelId;
  if (typeof providerId === "string") details.provider_id = providerId;
  return Object.keys(details).length === 0 ? null : details;
}

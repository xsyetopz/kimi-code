import {
  ErrorCodes,
  IAgentContextMemoryService,
  IAgentFullCompactionService,
  IAgentRPCService,
  IAgentConversationUndoService,
  ISessionIndex,
  ISessionLegacyService,
  resumeSessionById,
  isError2,
  Error2,
  type ContextMessage,
  type IAgentScopeHandle,
  type Scope,
  type SessionSummary,
} from "@moonshot-ai/agent-core-v2";
import { z } from "zod";

import { errEnvelope } from "../envelope";
import { requestLog } from "../lib/requestLog";
import { ErrorCode } from "../protocol/error-codes";
import { toProtocolMessage } from "../services/messages/messageProjection";
import { ensureMainAgent } from "../transport/mainAgent";
import { workspaceIdSchema } from "../protocol/workspace";
import { type SessionFacts } from "./sessionProjection";

export interface SessionRouteHost {
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: {
        id: string;
        body: unknown;
        params: unknown;
        headers: Record<string, unknown>;
      },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  get(
    path: string,
    options:
      | { preHandler: unknown[]; schema?: Record<string, unknown> }
      | undefined,
    handler: (
      req: { id: string; query: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

export const booleanQueryParam = z.preprocess((value) => {
  if (value === "true" || value === "1" || value === 1 || value === true)
    return true;
  if (value === "false" || value === "0" || value === 0 || value === false)
    return false;
  return value;
}, z.boolean().optional());

export const DEFAULT_SESSION_LIST_PAGE_SIZE = 20;

export const sessionsListQueryCoercion = z
  .object({
    before_id: z.string().min(1).optional(),
    after_id: z.string().min(1).optional(),
    page_size: z.coerce.number().int().min(1).max(100).optional(),
    busy: booleanQueryParam,
    include_archive: booleanQueryParam,
    exclude_empty: booleanQueryParam,
    archived_only: booleanQueryParam,
    workspace_id: workspaceIdSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.before_id !== undefined && value.after_id !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "before_id and after_id are mutually exclusive",
        path: ["before_id"],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
    if (value.archived_only === true && value.include_archive === true) {
      ctx.addIssue({
        code: "custom",
        message: "archived_only and include_archive are mutually exclusive",
        path: ["archived_only"],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
  });

export const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

export const sessionChildrenListQueryCoercion = z
  .object({
    before_id: z.string().min(1).optional(),
    after_id: z.string().min(1).optional(),
    page_size: z.coerce.number().int().min(1).max(100).optional(),
    busy: booleanQueryParam,
  })
  .superRefine((value, ctx) => {
    if (value.before_id !== undefined && value.after_id !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "before_id and after_id are mutually exclusive",
        path: ["before_id"],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
  });

export const sessionActionTailParamSchema = z.object({
  tail: z.string().min(1),
});

export const sessionActionRequestSchema = z.preprocess(
  (value) => (value === undefined ? {} : value),
  z.object({
    title: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    instruction: z.string().optional(),
    count: z.number().int().positive().optional(),
    page_size: z.number().int().min(1).max(100).optional(),
  }),
);

export const detailsSchema = z.array(
  z.object({ path: z.string(), message: z.string() }),
);

export async function resolveMainAgent(
  core: Scope,
  sessionId: string,
): Promise<IAgentScopeHandle> {
  const session = await resumeSessionById(core.accessor, sessionId);
  if (session === undefined) {
    throw new Error2(
      ErrorCodes.SESSION_NOT_FOUND,
      `session ${sessionId} does not exist`,
    );
  }
  return ensureMainAgent(session);
}

export function normalizeOptional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

const DEFAULT_UNDO_MESSAGE_PAGE_SIZE = 50;
const MAX_UNDO_MESSAGE_PAGE_SIZE = 100;

export function pageUndoMessages(
  sessionId: string,
  sessionCreatedAtMs: number,
  history: readonly ContextMessage[],
  requestedPageSize: number | undefined,
): { items: ReturnType<typeof toProtocolMessage>[]; has_more: boolean } {
  const pageSize = Math.min(
    Math.max(requestedPageSize ?? DEFAULT_UNDO_MESSAGE_PAGE_SIZE, 1),
    MAX_UNDO_MESSAGE_PAGE_SIZE,
  );
  const all = history.map((message, index) =>
    toProtocolMessage(sessionId, index, message, sessionCreatedAtMs),
  );
  const desc = all.toReversed();
  return {
    items: desc.slice(0, pageSize),
    has_more: desc.length > pageSize,
  };
}

export function buildValidationEnvelope(
  details: { path: string; message: string }[],
  requestId: string,
): {
  code: number;
  msg: string;
  data: null;
  request_id: string;
  details: { path: string; message: string }[];
} {
  const first = details[0];
  const msg =
    first === undefined
      ? "validation failed"
      : first.path === ""
        ? first.message
        : `${first.path}: ${first.message}`;
  return {
    code: ErrorCode.VALIDATION_FAILED,
    msg,
    data: null,
    request_id: requestId,
    details,
  };
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
      case "session.fork_active_turn":
      case ErrorCodes.SESSION_BUSY:
        reply.send(
          errEnvelope(
            ErrorCode.SESSION_BUSY,
            err.message,
            requestId,
            err.stack,
          ),
        );
        return;
      case "compaction.unable":
        reply.send(
          errEnvelope(
            ErrorCode.COMPACTION_UNABLE,
            err.message,
            requestId,
            err.stack,
          ),
        );
        return;
      case "session.undo_unavailable":
        reply.send({
          code: ErrorCode.SESSION_UNDO_UNAVAILABLE,
          msg: err.message,
          data: (err as { details?: unknown }).details ?? null,
          request_id: requestId,
          stack: err.stack,
        });
        return;
      case ErrorCodes.GOAL_ALREADY_EXISTS:
        reply.send(
          errEnvelope(
            ErrorCode.GOAL_ALREADY_EXISTS,
            err.message,
            requestId,
            err.stack,
          ),
        );
        return;
      case ErrorCodes.GOAL_NOT_FOUND:
        reply.send(
          errEnvelope(
            ErrorCode.GOAL_NOT_FOUND,
            err.message,
            requestId,
            err.stack,
          ),
        );
        return;
      case ErrorCodes.GOAL_STATUS_INVALID:
        reply.send(
          errEnvelope(
            ErrorCode.GOAL_STATUS_INVALID,
            err.message,
            requestId,
            err.stack,
          ),
        );
        return;
      case ErrorCodes.GOAL_NOT_RESUMABLE:
        reply.send(
          errEnvelope(
            ErrorCode.GOAL_NOT_RESUMABLE,
            err.message,
            requestId,
            err.stack,
          ),
        );
        return;
      case ErrorCodes.GOAL_OBJECTIVE_EMPTY:
        reply.send(
          errEnvelope(
            ErrorCode.GOAL_OBJECTIVE_EMPTY,
            err.message,
            requestId,
            err.stack,
          ),
        );
        return;
      case ErrorCodes.GOAL_OBJECTIVE_TOO_LONG:
        reply.send(
          errEnvelope(
            ErrorCode.GOAL_OBJECTIVE_TOO_LONG,
            err.message,
            requestId,
            err.stack,
          ),
        );
        return;
      case ErrorCodes.FS_PATH_NOT_FOUND:
        reply.send(
          errEnvelope(
            ErrorCode.FS_PATH_NOT_FOUND,
            err.message,
            requestId,
            err.stack,
          ),
        );
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
    }
  }
  log?.error({ err }, "session request failed");
  reply.send(
    errEnvelope(
      ErrorCode.INTERNAL_ERROR,
      err instanceof Error ? err.message : String(err),
      requestId,
      err instanceof Error ? err.stack : undefined,
    ),
  );
}

export interface EligibleSession {
  readonly summary: SessionSummary;
  readonly cwd: string;
  readonly facts?: SessionFacts;
}

/**
 * `/api/v1` session filesystem routes — server-v2 port.
 *
 * Mirrors `packages/server/src/routes/fs.ts` path-for-path and schema-for-schema
 * so existing v1 clients keep working against server-v2. Backed by the v2
 * Workspace-scoped `IWorkspaceFsService` (`agent-core-v2/src/workspace/workspaceFs`):
 * the route resolves the session from the URL, then dispatches `fs:<action>`
 * to the matching `IWorkspaceFsService` method — the session's accessor
 * resolves it from its parent Workspace scope (the handler), which is the
 * "session → handler → workspace fs" chain (chdir is gone, so the handler
 * root is the one fixed fs root). The wire schema comes from the engine's own
 * `workspaceFs` domain contract (`agent-core-v2`).
 *
 * Draft-session fallback: a client composing the first prompt of a new
 * session (e.g. kimi-web's new-session draft) has no session id yet, so it
 * passes the workspace reference — registered workspace id or absolute root —
 * in the `{session_id}` slot. Only `fs:search` serves those (the `@` file
 * mention must work before the session exists): the route resolves the
 * workspace's handler directly and uses the same Workspace-scope fs service a
 * real session would resolve to. URL and wire schema are unchanged.
 *
 * First-class workspace search: `POST /workspace/fs:search` carries the same
 * workspace reference in the body (`workspace`), so a session-less client
 * searches without borrowing the `{session_id}` slot. kimi-web's `@` mention
 * uses this route; the session-route fallback above predates it and stays for
 * wire compatibility.
 */

import { createReadStream } from "node:fs";
import { isAbsolute } from "node:path";

import {
  IWorkspaceFsService,
  IWorkspaceLifecycleService,
  IWorkspaceService,
  resumeSessionById,
  type Scope,
} from "@moonshot-ai/agent-core-v2";
import {
  fsSearchRequestSchema,
  fsSearchResponseSchema,
} from "@moonshot-ai/agent-core-v2/workspace/workspaceFs/fs";
import { z } from "zod";

import { errEnvelope, okEnvelope } from "../envelope";
import { parseRangeHeader, pickHeader } from "../lib/httpRange";
import { requestLog } from "../lib/requestLog";
import { defineRoute } from "../middleware/defineRoute";
import { ErrorCode } from "../protocol/error-codes";
import {
  handleDiff,
  handleGitStatus,
  handleGrep,
  handleList,
  handleListMany,
  handleMkdir,
  handleOpen,
  handleOpenIn,
  handleRead,
  handleReveal,
  handleSearch,
  handleStat,
  handleStatMany,
  resolveFs,
  sanitizeFilename,
  sendMappedError,
} from "./fsHandlers";

interface FsRouteHost {
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown; headers: Record<string, unknown> },
      reply: FsDownloadReply,
    ) => unknown,
  ): unknown;
}

interface FsDownloadReply {
  type(mime: string): FsDownloadReply;
  header(name: string, value: string | number): FsDownloadReply;
  code(status: number): FsDownloadReply;
  send(payload: unknown): unknown;
}

const sessionIdAndTailParamSchema = z.object({
  session_id: z.string().min(1),
  tail: z.string().min(1),
});

const workspaceFsSearchBodySchema = fsSearchRequestSchema.extend({
  workspace: z.string().min(1),
});

const detailsSchema = z.array(
  z.object({ path: z.string(), message: z.string() }),
);

const FS_ACTIONS = [
  "list",
  "read",
  "list_many",
  "stat",
  "stat_many",
  "mkdir",
  "search",
  "grep",
  "git_status",
  "diff",
  "open",
  "open-in",
  "reveal",
] as const;
type FsAction = (typeof FS_ACTIONS)[number];
const FS_TAIL_PREFIX = "fs:";

async function resolveWorkspaceFs(
  core: Scope,
  ref: string,
): Promise<IWorkspaceFsService | undefined> {
  const workspaces = core.accessor.get(IWorkspaceService);
  let ws = await workspaces.get(ref);
  if (ws === undefined) {
    if (!isAbsolute(ref)) return undefined;
    try {
      ws = await workspaces.createOrTouch(ref);
    } catch {
      return undefined;
    }
  }
  const handler = await core.accessor
    .get(IWorkspaceLifecycleService)
    .handlerFor({ workspaceId: ws.id, root: ws.root });
  return handler.accessor.get(IWorkspaceFsService);
}

export function registerFsRoutes(app: FsRouteHost, core: Scope): void {
  const fsActionRoute = defineRoute(
    {
      method: "POST",
      path: "/sessions/{session_id}/{tail}",
      params: sessionIdAndTailParamSchema,
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.FS_PATH_NOT_FOUND]: {},
        [ErrorCode.FS_IS_DIRECTORY]: {},
        [ErrorCode.FS_IS_BINARY]: {},
        [ErrorCode.FS_TOO_LARGE]: {},
        [ErrorCode.FS_TOO_MANY_RESULTS]: {},
        [ErrorCode.FS_PATH_ESCAPES_SESSION]: {},
        [ErrorCode.FS_GREP_TIMEOUT]: {},
        [ErrorCode.FS_GIT_UNAVAILABLE]: {},
        [ErrorCode.FS_ALREADY_EXISTS]: {},
      },
      description:
        "Filesystem action dispatcher. Supported actions: list, read, list_many, stat, stat_many, mkdir, search, grep, git_status, diff, open, open-in, reveal.",
      tags: ["fs"],
      operationId: "fsAction",
    },
    async (req, reply) => {
      const { session_id, tail } = req.params as {
        session_id: string;
        tail: string;
      };

      if (!tail.startsWith(FS_TAIL_PREFIX)) {
        reply.send(
          errEnvelope(
            ErrorCode.VALIDATION_FAILED,
            `unsupported action: ${tail}`,
            req.id,
          ),
        );
        return;
      }

      const action = tail.slice(FS_TAIL_PREFIX.length);
      if (!(FS_ACTIONS as readonly string[]).includes(action)) {
        reply.send(
          errEnvelope(
            ErrorCode.VALIDATION_FAILED,
            `unsupported action: ${tail}`,
            req.id,
          ),
        );
        return;
      }
      const fsAction = action as FsAction;

      // Cold-load a persisted-but-not-live session so fs actions (which only
      // need the work dir) do not 404 on a freshly-opened session. Matches v1,
      // which reads the persisted cwd. `resume` returns undefined only when the
      // session is unknown or its workspace is gone.
      const session = await resumeSessionById(core.accessor, session_id);
      // Draft-session fallback (file header): no session yet, but the client
      // addressed a workspace — `fs:search` resolves it directly.
      const workspaceFs =
        session === undefined && fsAction === "search"
          ? await resolveWorkspaceFs(core, session_id)
          : undefined;
      if (session === undefined && workspaceFs === undefined) {
        reply.send(
          errEnvelope(
            ErrorCode.SESSION_NOT_FOUND,
            `session ${session_id} does not exist`,
            req.id,
          ),
        );
        return;
      }

      try {
        switch (fsAction) {
          case "list":
            await handleList(core, session_id, req, reply);
            return;
          case "read":
            await handleRead(core, session_id, req, reply);
            return;
          case "list_many":
            await handleListMany(core, session_id, req, reply);
            return;
          case "stat":
            await handleStat(core, session_id, req, reply);
            return;
          case "stat_many":
            await handleStatMany(core, session_id, req, reply);
            return;
          case "mkdir":
            await handleMkdir(core, session_id, req, reply);
            return;
          case "search":
            await handleSearch(
              workspaceFs ?? resolveFs(core, session_id),
              req,
              reply,
            );
            return;
          case "grep":
            await handleGrep(core, session_id, req, reply);
            return;
          case "git_status":
            await handleGitStatus(core, session_id, req, reply);
            return;
          case "diff":
            await handleDiff(core, session_id, req, reply);
            return;
          case "open":
            await handleOpen(core, session_id, req, reply);
            return;
          case "open-in":
            await handleOpenIn(core, session_id, req, reply);
            return;
          case "reveal":
            await handleReveal(core, session_id, req, reply);
            return;
        }
      } catch (err) {
        sendMappedError(reply, req, err);
      }
    },
  );
  app.post(
    fsActionRoute.path,
    fsActionRoute.options,
    fsActionRoute.handler as unknown as Parameters<FsRouteHost["post"]>[2],
  );

  // Session-less workspace file search (file header): the `@` file mention of
  // a not-yet-created session addresses the workspace directly instead of
  // borrowing the session route's `{session_id}` slot. Declared with a double
  // colon so find-my-way serves it on the wire as `/workspace/fs:search`
  // (same convention as `/fs::browse` in `workspaceFs.ts`).
  const workspaceSearchRoute = defineRoute(
    {
      method: "POST",
      path: "/workspace/fs::search",
      body: workspaceFsSearchBodySchema,
      success: { data: fsSearchResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
        [ErrorCode.FS_TOO_MANY_RESULTS]: {},
      },
      description:
        "Search files in a workspace without a session. `workspace` accepts a registered workspace id or an absolute root (registered on the spot).",
      tags: ["fs"],
      operationId: "workspaceFsSearch",
    },
    async (req, reply) => {
      const { workspace, ...searchRequest } = req.body;
      const fs = await resolveWorkspaceFs(core, workspace);
      if (fs === undefined) {
        reply.send(
          errEnvelope(
            ErrorCode.WORKSPACE_NOT_FOUND,
            `workspace ${workspace} does not exist`,
            req.id,
          ),
        );
        return;
      }
      try {
        const data = await fs.search(searchRequest);
        reply.send(okEnvelope(data, req.id));
      } catch (err) {
        sendMappedError(reply, req, err);
      }
    },
  );
  app.post(
    workspaceSearchRoute.path,
    workspaceSearchRoute.options,
    workspaceSearchRoute.handler as unknown as Parameters<
      FsRouteHost["post"]
    >[2],
  );

  const downloadRoute = defineRoute(
    {
      method: "GET",
      path: "/sessions/{session_id}/fs/*",
      rawResponse: {
        200: { type: "string", format: "binary" },
      },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.FS_PATH_NOT_FOUND]: {},
        [ErrorCode.FS_PATH_ESCAPES_SESSION]: {},
      },
      description: "Download a file from the session workspace",
      tags: ["fs"],
      operationId: "downloadFile",
    },
    async (req, reply) => {
      const { session_id } = req.params as { session_id: string };
      const wildcard = (req.params as Record<string, unknown>)["*"] as string;

      const DOWNLOAD_SUFFIX = ":download";
      if (!wildcard.endsWith(DOWNLOAD_SUFFIX)) {
        reply.send(
          errEnvelope(
            ErrorCode.VALIDATION_FAILED,
            `unsupported action: ${wildcard}`,
            req.id,
          ),
        );
        return;
      }
      const relPath = wildcard.slice(0, -DOWNLOAD_SUFFIX.length);
      if (relPath.length === 0) {
        reply.send(
          errEnvelope(ErrorCode.VALIDATION_FAILED, "path is empty", req.id),
        );
        return;
      }

      // Cold-load so a freshly-opened (persisted but not live) session can still
      // serve downloads; `resume` only returns undefined for unknown / workspace-gone.
      const session = await resumeSessionById(core.accessor, session_id);
      if (session === undefined) {
        reply.send(
          errEnvelope(
            ErrorCode.SESSION_NOT_FOUND,
            `session ${session_id} does not exist`,
            req.id,
          ),
        );
        return;
      }

      let resolved: Awaited<ReturnType<IWorkspaceFsService["resolveDownload"]>>;
      try {
        resolved = await resolveFs(core, session_id).resolveDownload(relPath);
      } catch (err) {
        sendMappedError(reply, req, err);
        return;
      }

      const r = reply as unknown as FsDownloadReply;
      const headers = req.headers;

      const ifNoneMatch = pickHeader(headers, "if-none-match");
      if (ifNoneMatch !== undefined && ifNoneMatch === resolved.etag) {
        r.code(304).header("etag", resolved.etag).send("");
        return;
      }

      r.header("etag", resolved.etag);
      r.header("last-modified", resolved.modifiedAt.toUTCString());
      r.header(
        "content-disposition",
        `attachment; filename="${sanitizeFilename(resolved.relative)}"`,
      );
      r.type(resolved.mime);

      const rangeHeader = pickHeader(headers, "range");
      const range = parseRangeHeader(rangeHeader, resolved.size);
      if (range !== null) {
        r.code(206)
          .header("content-length", String(range.length))
          .header(
            "content-range",
            `bytes ${range.start}-${range.end}/${resolved.size}`,
          );
        const stream = createReadStream(resolved.absolute, {
          start: range.start,
          end: range.end,
        });
        stream.on("error", (error: unknown) => {
          requestLog(req)?.warn(
            { session_id, path: relPath, err: error },
            "fs download stream error",
          );
          try {
            stream.destroy();
          } catch {
            // best-effort
          }
        });
        return r.send(stream) as unknown as void;
      }

      r.code(200).header("content-length", String(resolved.size));
      const stream = createReadStream(resolved.absolute);
      stream.on("error", (error: unknown) => {
        requestLog(req)?.warn(
          { session_id, path: relPath, err: error },
          "fs download stream error",
        );
        try {
          stream.destroy();
        } catch {
          // best-effort
        }
      });
      return r.send(stream) as unknown as void;
    },
  );
  app.get(
    downloadRoute.path,
    downloadRoute.options,
    downloadRoute.handler as unknown as Parameters<FsRouteHost["get"]>[2],
  );
}

/**
 * `/sessions` route handlers — server-v2 port.
 *
 * Implements the v1 `/api/v1/sessions` wire contract on top of
 * `agent-core-v2` services:
 *   POST   /sessions                  create
 *   GET    /sessions                  list
 *   GET    /sessions/{session_id}     get
 *   GET    /sessions/{session_id}/profile
 *   POST   /sessions/{session_id}/profile      update title / metadata / agent_config
 *   POST   /sessions/{tail}                    action: fork / compact / undo /
 *                                              abort / btw / archive / restore
 *   GET    /sessions/{session_id}/children     list child sessions
 *   POST   /sessions/{session_id}/children     create child session (fork+tag)
 *   GET    /sessions/{session_id}/status       best-effort
 *   GET    /sessions/{session_id}/goal         current goal (null when none)
 *   GET    /sessions/{session_id}/warnings     session-level notices
 *
 * The `POST /sessions/{tail}` actions split into two groups. The thin
 * pass-throughs — `fork` / `compact` / `abort` / `archive` / `restore` — call
 * the native v2 services directly (the workspace handler's
 * `ISessionLifecycleService.fork` / `archive` / `restore`, reached through the
 * `sessionIndex` → `IWorkspaceLifecycleService.handlerFor` composition,
 * `IAgentFullCompactionService.begin`, `IAgentRPCService.cancel`); there is no
 * v1-only projection to centralize, so no adapter is involved. `undo` likewise
 * calls `IAgentConversationUndoService.undo` directly (it throws
 * `session.undo_unavailable` with a structured reason) and only borrows
 * `ISessionLegacyService.status` for the cross-domain status rollup. The
 * `/sessions/{id}/children` endpoints call `ISessionLifecycleService.createChild`
 * and `ISessionIndex.list({ childOf })` directly — the child markers and
 * parent-title default live in the lifecycle, and the child filter lives in the
 * index. Only `POST /sessions/{id}/profile` (`updateProfile`),
 * `GET /sessions/{id}/status`, and `GET /sessions/{id}/goal` go through
 * `ISessionLegacyService` (the `agent_config` patch, the status rollup, and the
 * current-goal read hold real cross-domain adaptation);
 * the route forwards each adapter result verbatim, mirroring v1's thin handler.
 * `create`, `fork`, and child creation publish `event.session.created` on the
 * core event bus, matching v1.
 *
 * `GET /sessions/{id}/warnings` surfaces session-level notices in the v1
 * `{ code, message, severity }` wire shape: the `agents-md-oversized` warning
 * (projected from the main agent's `IAgentProfileService.getAgentsMdWarning()`
 * — computed and cached when the agent binds a profile) and the
 * secondary-model early-validation warning (projected from the Session-scope
 * `ISessionSecondaryModelWarningService` — computed and cached when the main
 * agent is created). An unbound main agent or a valid/unset secondary model
 * yields an empty list, matching v1's "no warning" case.
 *
 * **Wire fidelity**: mirrors v1's `toProtocolSession`
 * (`the session domain`), which populates
 * only the index/metadata fields and returns placeholders for the heavy ones
 * (`agent_config:{model:''}`, `usage:zeros`, `permission_rules:[]`,
 * `message_count:0`, `last_seq:0`). v2 produces the same placeholder shape
 * from `ISessionIndex` (with `cwd` persisted on the session itself), and now
 * also surfaces `last_prompt` and the merged custom `metadata`.
 *
 * **Busy / last turn**: v1's `SessionService` overwrites the placeholder
 * `status` with the live value before projecting (`_patchSessionStatus`). v2
 * projects the orthogonal facts instead: `toWireSession` takes
 * `resolveSessionFacts` — `busy` from the session lifecycle's authoritative
 * drain registry and `last_turn_reason` from the main agent's activity view (a
 * cold session is not busy and carries no reason) — so both are real on every
 * session-producing endpoint here. `GET /sessions` and
 * `GET /sessions/{id}/children` filter their projected page by the `busy`
 * query param (post-page, matching v1 — `has_more` reflects the pre-filter
 * page), except `archived_only` lists filter busy before route pagination so
 * they can drain archived pages the same way v1 does.
 *
 * **cwd resolution (gap G3 closed)**: the session's frozen work dir is
 * persisted on its metadata document (`ISessionMetadata`) and surfaced on the
 * `ISessionIndex` summary, so `metadata.cwd` comes from the session itself —
 * not from `IWorkspaceService`. Sessions whose workspace was unregistered keep
 * their original cwd and stay listed / gettable (matching v1, which stores
 * `workDir` on the session). `IWorkspaceService` is consulted only as a
 * back-compat fallback for sessions written before `cwd` was persisted.
 */
import {
  ErrorCodes,
  IAgentProfileService,
  IEventService,
  ISessionContext,
  ISessionIndex,
  ISessionLegacyService,
  ISessionLifecycleService,
  ISessionMetadata,
  ISessionSecondaryModelWarningService,
  IWorkspaceLifecycleService,
  IWorkspaceService,
  getLiveSessionById,
  handlerForSession,
  resumeSessionById,
  isError2,
  Error2,
  type Scope,
} from "@moonshot-ai/agent-core-v2";
import { z } from "zod";

import { errEnvelope, okEnvelope } from "../envelope";
import { defineRoute } from "../middleware/defineRoute";
import { ErrorCode } from "../protocol/error-codes";
import {
  createSessionChildRequestSchema,
  createSessionRequestSchema,
  getSessionGoalResponseSchema,
  listSessionChildrenResponseSchema,
  sessionStatusResponseSchema,
  sessionWarningsResponseSchema,
  updateSessionProfileRequestSchema,
} from "../protocol/rest-session";
import { sessionSchema } from "../protocol/session";
import { ensureMainAgent } from "../transport/mainAgent";
import { resolveSessionFacts, toWireSession } from "./sessionProjection";
import { registerSessionsActionRoute } from "./sessionsActions";
import { registerSessionsListRoute } from "./sessionsList";
import {
  buildValidationEnvelope,
  detailsSchema,
  sessionChildrenListQueryCoercion,
  sessionIdParamSchema,
  sendMappedError,
  type SessionRouteHost,
} from "./sessionsSupport";

export function registerSessionsRoutes(
  app: SessionRouteHost,
  core: Scope,
): void {
  const createRoute = defineRoute(
    {
      method: "POST",
      path: "/sessions",
      body: createSessionRequestSchema,
      success: { data: sessionSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
        [ErrorCode.FS_PATH_NOT_FOUND]: {},
      },
      description: "Create a new session",
      tags: ["sessions"],
    },
    async (req, reply) => {
      const body = req.body;
      const callerCwd =
        typeof body.metadata?.cwd === "string" ? body.metadata.cwd : undefined;
      const workspaceId = body.workspace_id;
      if (workspaceId === undefined && callerCwd === undefined) {
        reply.send(
          buildValidationEnvelope(
            [
              {
                path: "metadata.cwd",
                message: "either workspace_id or metadata.cwd is required",
              },
            ],
            req.id,
          ),
        );
        return;
      }

      const registry = core.accessor.get(IWorkspaceService);
      let workDir: string;
      if (workspaceId !== undefined) {
        const workspace = await registry.get(workspaceId);
        if (workspace === undefined) {
          reply.send(
            errEnvelope(
              ErrorCode.WORKSPACE_NOT_FOUND,
              `workspace ${workspaceId} does not exist`,
              req.id,
            ),
          );
          return;
        }
        if (callerCwd !== undefined && callerCwd !== workspace.root) {
          reply.send(
            buildValidationEnvelope(
              [
                {
                  path: "metadata.cwd",
                  message: `metadata.cwd (${callerCwd}) must equal workspace root (${workspace.root})`,
                },
              ],
              req.id,
            ),
          );
          return;
        }
        workDir = workspace.root;
      } else {
        workDir = callerCwd as string;
      }

      // Ensure the workspace is registered so `metadata.cwd` is resolvable on
      // read (gap G3 — v2 does not store workDir on the session). The session
      // is created through the workspace's handler (`handlerFor` → the
      // handler's `ISessionLifecycleService`) — there is no App-scope session
      // lifecycle entry point.
      try {
        const touched = await registry.createOrTouch(workDir);

        const handler = await core.accessor
          .get(IWorkspaceLifecycleService)
          .handlerFor({
            root: workDir,
          });
        const handle = await handler.accessor
          .get(ISessionLifecycleService)
          .create({
            workDir,
          });
        if (typeof body.title === "string") {
          await handle.accessor.get(ISessionMetadata).setTitle(body.title);
        }
        const meta = await handle.accessor.get(ISessionMetadata).read();
        const session = toWireSession(
          { ...meta, workspaceId: touched.id },
          touched.root,
          { busy: false, mainTurnActive: false, pendingInteraction: "none" },
        );
        core.accessor.get(IEventService).publish({
          type: "event.session.created",
          payload: { agentId: "main", sessionId: session.id, session },
        });
        reply.send(okEnvelope(session, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.post(
    createRoute.path,
    createRoute.options,
    createRoute.handler as Parameters<SessionRouteHost["post"]>[2],
  );

  registerSessionsListRoute(app, core);
  const getRoute = defineRoute(
    {
      method: "GET",
      path: "/sessions/{session_id}",
      params: sessionIdParamSchema,
      success: { data: sessionSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: "Get a session by ID",
      tags: ["sessions"],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const summary = await core.accessor.get(ISessionIndex).get(session_id);
      if (summary === undefined) {
        reply.send(
          errEnvelope(
            ErrorCode.SESSION_NOT_FOUND,
            `session ${session_id} does not exist`,
            req.id,
          ),
        );
        return;
      }
      const cwd =
        summary.cwd ??
        (await core.accessor.get(IWorkspaceService).get(summary.workspaceId))
          ?.root;
      if (cwd === undefined) {
        // Persisted session with no `cwd` on disk and no registered workspace
        // to fall back to (predates gap-G3 persistence) — cannot project cwd.
        reply.send(
          errEnvelope(
            ErrorCode.SESSION_NOT_FOUND,
            `session ${session_id} has no recoverable cwd`,
            req.id,
          ),
        );
        return;
      }
      reply.send(
        okEnvelope(
          toWireSession(summary, cwd, resolveSessionFacts(core, session_id)),
          req.id,
        ),
      );
    },
  );
  app.get(
    getRoute.path,
    getRoute.options,
    getRoute.handler as Parameters<SessionRouteHost["get"]>[2],
  );

  const getProfileRoute = defineRoute(
    {
      method: "GET",
      path: "/sessions/{session_id}/profile",
      params: sessionIdParamSchema,
      success: { data: sessionSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: "Get session profile",
      tags: ["sessions"],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const summary = await core.accessor.get(ISessionIndex).get(session_id);
      if (summary === undefined) {
        reply.send(
          errEnvelope(
            ErrorCode.SESSION_NOT_FOUND,
            `session ${session_id} does not exist`,
            req.id,
          ),
        );
        return;
      }
      const cwd =
        summary.cwd ??
        (await core.accessor.get(IWorkspaceService).get(summary.workspaceId))
          ?.root;
      if (cwd === undefined) {
        reply.send(
          errEnvelope(
            ErrorCode.SESSION_NOT_FOUND,
            `session ${session_id} has no recoverable cwd`,
            req.id,
          ),
        );
        return;
      }
      reply.send(
        okEnvelope(
          toWireSession(summary, cwd, resolveSessionFacts(core, session_id)),
          req.id,
        ),
      );
    },
  );
  app.get(
    getProfileRoute.path,
    getProfileRoute.options,
    getProfileRoute.handler as Parameters<SessionRouteHost["get"]>[2],
  );

  const updateProfileRoute = defineRoute(
    {
      method: "POST",
      path: "/sessions/{session_id}/profile",
      params: sessionIdParamSchema,
      body: updateSessionProfileRequestSchema,
      success: { data: sessionSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: "Update session profile (title, metadata, agent_config)",
      tags: ["sessions"],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const fields = await core.accessor
          .get(ISessionLegacyService)
          .updateProfile(session_id, req.body);
        const session = toWireSession(
          fields,
          fields.root,
          resolveSessionFacts(core, fields.id),
        );
        // Broadcast the title change to every connection (including clients not
        // subscribed to this session, and covering inactive sessions), so session
        // lists stay in sync — mirrors v1's `session.meta.updated` publish.
        if (
          typeof req.body.title === "string" &&
          req.body.title.trim().length > 0
        ) {
          core.accessor.get(IEventService).publish({
            type: "session.meta.updated",
            payload: {
              agentId: "main",
              sessionId: session_id,
              title: session.title,
              patch: { title: session.title, isCustomTitle: true },
            },
          });
        }
        reply.send(okEnvelope(session, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.post(
    updateProfileRoute.path,
    updateProfileRoute.options,
    updateProfileRoute.handler as Parameters<SessionRouteHost["post"]>[2],
  );

  registerSessionsActionRoute(app, core);
  const listChildrenRoute = defineRoute(
    {
      method: "GET",
      path: "/sessions/{session_id}/children",
      params: sessionIdParamSchema,
      querystring: sessionChildrenListQueryCoercion,
      success: { data: listSessionChildrenResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: "List child sessions",
      tags: ["sessions"],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        // 404 when the parent is unknown — the live handle wins, otherwise the
        // persisted index (a closed parent can still list children, like v1).
        const exists =
          getLiveSessionById(core.accessor, session_id) !== undefined ||
          (await core.accessor.get(ISessionIndex).get(session_id)) !==
            undefined;
        if (!exists) {
          throw new Error2(
            ErrorCodes.SESSION_NOT_FOUND,
            `session ${session_id} does not exist`,
          );
        }

        // The index filters by the child markers (`parent_session_id` +
        // `child_session_kind`) and returns keyset pages in recency order —
        // the id-cursor and page-size go down to the index, the busy
        // projection/filter stays at the edge (v1 wire concerns; status needs
        // live handles).
        const pageSize = req.query.page_size ?? 100;
        const page = await core.accessor.get(ISessionIndex).listRecent({
          childOf: session_id,
          before: req.query.before_id,
          after: req.query.after_id,
          limit: pageSize + 1,
        });
        const window = page.items.slice(0, pageSize);

        // `cwd` is read from the child's own summary first (gap G3 closed); the
        // registry is only a back-compat fallback for sessions written before
        // `cwd` was persisted, defaulting to '' (matches the prior adapter).
        const roots = new Map(
          (await core.accessor.get(IWorkspaceService).list()).map((w) => [
            w.id,
            w.root,
          ]),
        );
        const projected = window.map((summary) =>
          toWireSession(
            summary,
            summary.cwd ?? roots.get(summary.workspaceId) ?? "",
            resolveSessionFacts(core, summary.id),
          ),
        );
        // v1 filters the projected page by the busy fact (post-page); `has_more`
        // reflects the pre-filter page.
        const items =
          req.query.busy !== undefined
            ? projected.filter((session) => session.busy === req.query.busy)
            : projected;
        reply.send(
          okEnvelope(
            { items, has_more: page.nextCursor !== undefined },
            req.id,
          ),
        );
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.get(
    listChildrenRoute.path,
    listChildrenRoute.options,
    listChildrenRoute.handler as Parameters<SessionRouteHost["get"]>[2],
  );

  const createChildRoute = defineRoute(
    {
      method: "POST",
      path: "/sessions/{session_id}/children",
      params: sessionIdParamSchema,
      body: createSessionChildRequestSchema,
      success: { data: sessionSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.SESSION_BUSY]: {},
      },
      description: "Create a child session",
      tags: ["sessions"],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        // `createChild` throws `session.not_found` for an unknown source (via
        // `fork`), so no explicit existence check is needed here. The child
        // markers (`parent_session_id` / `child_session_kind`) and the default
        // `Child: <parent>` title are applied by the handler's lifecycle.
        const childHandler = await handlerForSession(core.accessor, session_id);
        if (childHandler === undefined) {
          throw new Error2(
            ErrorCodes.SESSION_NOT_FOUND,
            `session ${session_id} does not exist`,
          );
        }
        const handle = await childHandler.accessor
          .get(ISessionLifecycleService)
          .createChild({
            sourceSessionId: session_id,
            title: req.body.title,
            metadata: req.body.metadata,
          });
        const meta = await handle.accessor.get(ISessionMetadata).read();
        const ctx = handle.accessor.get(ISessionContext);
        const session = toWireSession(
          { ...meta, workspaceId: ctx.workspaceId },
          ctx.cwd,
          resolveSessionFacts(core, meta.id),
        );
        core.accessor.get(IEventService).publish({
          type: "event.session.created",
          payload: { agentId: "main", sessionId: session.id, session },
        });
        reply.send(okEnvelope(session, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.post(
    createChildRoute.path,
    createChildRoute.options,
    createChildRoute.handler as Parameters<SessionRouteHost["post"]>[2],
  );

  const statusRoute = defineRoute(
    {
      method: "GET",
      path: "/sessions/{session_id}/status",
      params: sessionIdParamSchema,
      success: { data: sessionStatusResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: "Get realtime session status (best-effort in this slice)",
      tags: ["sessions"],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const status = await core.accessor
          .get(ISessionLegacyService)
          .status(session_id);
        reply.send(okEnvelope(status, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.get(
    statusRoute.path,
    statusRoute.options,
    statusRoute.handler as Parameters<SessionRouteHost["get"]>[2],
  );

  const goalRoute = defineRoute(
    {
      method: "GET",
      path: "/sessions/{session_id}/goal",
      params: sessionIdParamSchema,
      success: { data: getSessionGoalResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: "Get the current session goal (null when none is active)",
      tags: ["sessions"],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const goal = await core.accessor
          .get(ISessionLegacyService)
          .goal(session_id);
        reply.send(okEnvelope(goal, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.get(
    goalRoute.path,
    goalRoute.options,
    goalRoute.handler as Parameters<SessionRouteHost["get"]>[2],
  );

  const sessionWarningsRoute = defineRoute(
    {
      method: "GET",
      path: "/sessions/{session_id}/warnings",
      params: sessionIdParamSchema,
      success: { data: sessionWarningsResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: "Get session-level warnings (e.g. oversized AGENTS.md)",
      tags: ["sessions"],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      // `resume` (not `get`) so a freshly-opened cold session still computes its
      // warnings; matches v1's best-effort `resumeSession` before reading them.
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
      try {
        // Surface v2 notices in the v1 wire shape. The agents-md warning is
        // computed (and cached) by `IAgentProfileService` when the main agent
        // binds a profile; the secondary-model warning is computed (and
        // cached) by `ISessionSecondaryModelWarningService` when the main
        // agent is created. An unbound main agent / unset secondary model
        // yields `undefined` → that entry drops out, matching v1's "no
        // warning" case.
        const agent = await ensureMainAgent(session);
        const agentsMdWarning = agent.accessor
          .get(IAgentProfileService)
          .getAgentsMdWarning();
        const secondaryModelWarning = session.accessor
          .get(ISessionSecondaryModelWarningService)
          .getSecondaryModelWarning();
        const warnings = [
          ...(agentsMdWarning === undefined
            ? []
            : [
                {
                  code: "agents-md-oversized",
                  message: agentsMdWarning,
                  severity: "warning" as const,
                },
              ]),
          ...(secondaryModelWarning === undefined
            ? []
            : [
                {
                  code: secondaryModelWarning.code,
                  message: secondaryModelWarning.message,
                  severity: "warning" as const,
                },
              ]),
        ];
        reply.send(okEnvelope({ warnings }, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.get(
    sessionWarningsRoute.path,
    sessionWarningsRoute.options,
    sessionWarningsRoute.handler as Parameters<SessionRouteHost["get"]>[2],
  );
}

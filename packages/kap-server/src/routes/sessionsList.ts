import {
  ISessionIndex,
  IWorkspaceAliases,
  IWorkspaceService,
  type Scope,
} from "@moonshot-ai/agent-core-v2";

import { errEnvelope, okEnvelope } from "../envelope";
import { defineRoute } from "../middleware/defineRoute";
import { ErrorCode } from "../protocol/error-codes";
import { pageResponseSchema } from "../protocol/pagination";
import { sessionSchema } from "../protocol/session";
import { resolveSessionFacts, toWireSession } from "./sessionProjection";
import {
  DEFAULT_SESSION_LIST_PAGE_SIZE,
  detailsSchema,
  sessionsListQueryCoercion,
  type SessionRouteHost,
} from "./sessionsSupport";

export function registerSessionsListRoute(
  app: SessionRouteHost,
  core: Scope,
): void {
  const listRoute = defineRoute(
    {
      method: "GET",
      path: "/sessions",
      querystring: sessionsListQueryCoercion,
      success: { data: pageResponseSchema(sessionSchema) },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
      },
      description: "List sessions",
      tags: ["sessions"],
    },
    async (req, reply) => {
      const raw = req.query;
      const archivedOnly = raw.archived_only === true;

      const workspaces = await core.accessor.get(IWorkspaceService).list();
      const roots = new Map(workspaces.map((w) => [w.id, w.root]));

      // v1 resolves `workspace_id` to its root and 40410s when it is unknown;
      // the existence check stays on the listed (root-deduped) registry so an
      // unknown id fails byte-identically, and only then is a known id
      // expanded to every id spelling of the same directory — legacy split
      // buckets (casing/slash variants) list as one workspace.
      if (raw.workspace_id !== undefined && !roots.has(raw.workspace_id)) {
        reply.send(
          errEnvelope(
            ErrorCode.WORKSPACE_NOT_FOUND,
            `workspace ${raw.workspace_id} does not exist`,
            req.id,
          ),
        );
        return;
      }

      const workspaceIds =
        raw.workspace_id === undefined
          ? undefined
          : await core.accessor
              .get(IWorkspaceAliases)
              .resolveAliasIds(raw.workspace_id);
      const index = core.accessor.get(ISessionIndex);
      const includeArchived = archivedOnly ? true : raw.include_archive;

      interface Eligible {
        readonly summary: SessionSummary;
        readonly cwd: string;
        readonly facts?: SessionFacts;
      }

      // Keyset pages are pulled from the index and filtered at the edge
      // (`cwd` recoverability, `exclude_empty`; `archived_only` also applies
      // its busy filter here so it can drain to a full page, matching v1) —
      // a bounded `page_size` request never materializes the full session
      // set. An unknown cursor resolves to an empty, terminal page (this was
      // the boot-time request storm). The index pages with ONE cursor per
      // call (`before` wins when both are set), so the drain can only advance
      // `before`; the `after` lower bound is re-applied at the edge instead —
      // the first candidate no longer strictly newer than the cursor ends
      // the window, so a heavily filtered stretch can never pull in sessions
      // at/older than the original `after_id`.
      const collect = async (
        pageSize: number,
      ): Promise<{ visible: Eligible[]; hasMore: boolean }> => {
        const wanted = pageSize + 1;
        const collected: Eligible[] = [];
        let before = raw.before_id;
        const after = raw.after_id;
        const afterCursor =
          after !== undefined ? await index.get(after) : undefined;
        const newerThanCursor = (summary: SessionSummary): boolean =>
          afterCursor === undefined ||
          summary.updatedAt > afterCursor.updatedAt ||
          (summary.updatedAt === afterCursor.updatedAt &&
            summary.id > afterCursor.id);
        while (collected.length < wanted) {
          const page = await index.listRecent({
            workspaceIds,
            includeArchived,
            limit: wanted - collected.length,
            before,
            after: before === undefined ? after : undefined,
          });
          if (page.items.length === 0) break;
          let exhausted = false;
          for (const summary of page.items) {
            if (!newerThanCursor(summary)) {
              exhausted = true;
              break;
            }
            const cwd = summary.cwd ?? roots.get(summary.workspaceId);
            if (cwd === undefined) continue;
            if (
              raw.exclude_empty === true &&
              (summary.lastPrompt ?? "").length === 0
            )
              continue;
            if (archivedOnly) {
              if (!summary.archived) continue;
              const facts = resolveSessionFacts(core, summary.id);
              if (raw.busy !== undefined && facts.busy !== raw.busy) continue;
              collected.push({ summary, cwd, facts });
            } else {
              collected.push({ summary, cwd });
            }
          }
          if (exhausted || page.nextCursor === undefined) break;
          before = page.nextCursor;
        }
        return {
          visible: collected.slice(0, pageSize),
          hasMore: collected.length > pageSize,
        };
      };

      if (!archivedOnly && raw.page_size === undefined) {
        // v1 wire default: an unpaged list returns the whole (cursor-bounded)
        // set with has_more=false.
        const page = await index.listRecent({
          workspaceIds,
          includeArchived,
          before: raw.before_id,
          after: raw.after_id,
        });
        const eligible: Eligible[] = [];
        for (const summary of page.items) {
          const cwd = summary.cwd ?? roots.get(summary.workspaceId);
          if (cwd === undefined) continue;
          if (
            raw.exclude_empty === true &&
            (summary.lastPrompt ?? "").length === 0
          )
            continue;
          eligible.push({ summary, cwd });
        }
        const projected = eligible.map(({ summary, cwd }) =>
          toWireSession(summary, cwd, resolveSessionFacts(core, summary.id)),
        );
        // v1 filters ordinary lists by the busy fact post-page.
        const items =
          raw.busy !== undefined
            ? projected.filter((session) => session.busy === raw.busy)
            : projected;
        reply.send(okEnvelope({ items, has_more: false }, req.id));
        return;
      }

      const pageSize = raw.page_size ?? DEFAULT_SESSION_LIST_PAGE_SIZE;
      const { visible, hasMore } = await collect(pageSize);
      const projected = visible.map(({ summary, cwd, facts }) =>
        toWireSession(
          summary,
          cwd,
          facts ?? resolveSessionFacts(core, summary.id),
        ),
      );
      // v1 filters ordinary lists by the busy fact post-page; `archived_only`
      // already applied it during the drain above.
      const items =
        raw.busy !== undefined && !archivedOnly
          ? projected.filter((session) => session.busy === raw.busy)
          : projected;
      reply.send(okEnvelope({ items, has_more: hasMore }, req.id));
    },
  );
  app.get(
    listRoute.path,
    listRoute.options,
    listRoute.handler as Parameters<SessionRouteHost["get"]>[2],
  );
}

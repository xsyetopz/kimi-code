import type { ApprovalResponse, Interaction, InteractionKind } from "@moonshot-ai/agent-core-v2";
import type { ConfigWarningItem, SessionCreatedEvent, SessionMetaUpdatedEvent, Event } from "./events";
import { toWireApproval } from "../../../routes/approvals";
import { toWireQuestion } from "../../../routes/questions";
import type { EventEnvelope } from "./sessionEventJournal";
import type { TranscriptGradeSpec } from "@moonshot-ai/transcript";
import type { AgentFilter, TargetSubscription } from "./sessionEventBroadcasterTypes";

export const GLOBAL_SESSION_ID = "__global__";

/**
 * Server-side durability gate for the agent event path. Live events reach the
 * edge via the per-agent `IEventBus`; their volatile vs durable
 * classification is owned here rather than by the protocol's
 * `VOLATILE_EVENT_TYPES` / `isVolatileEventType` (still used by the global /
 * model path in `dispatchGlobal`, and by the shipped v1 server). Volatile set
 * per plan line 475.
 */
const VOLATILE_SIGNAL_TYPES = [
  "assistant.delta",
  "thinking.delta",
  "tool.call.delta",
  "tool.progress",
  "shell.output",
  "shell.started",
  "shell.completed",
  "agent.status.updated",
] as const;

const volatileSignalTypeSet: ReadonlySet<string> = new Set(
  VOLATILE_SIGNAL_TYPES,
);

export function isVolatileSignal(type: string): boolean {
  return volatileSignalTypeSet.has(type);
}

/**
 * v1 wire compatibility: map a native v2 background-task lifecycle event to its
 * pre-v2 spelling, returning `undefined` for every other event. The pre-v2
 * engine emitted `background.task.started`/`background.task.terminated`; v2
 * emits `task.started`/`task.terminated`. The payload (`info`) is kept
 * byte-identical and `agentId`/`sessionId` are re-stamped so the alias flows
 * through the same dispatch / journal / agent-filter path as the native event.
 *
 * Exists so unchanged v1 consumers (kimi-code TUI / `kimi -p`, node-sdk) keep
 * working while v2-shaped consumers (kimi-web) keep the native event and ignore
 * the alias (registered as known, no handler). Remove once every consumer has
 * migrated to `task.*`.
 */
export function legacyTaskEvent(
  event: DomainEvent,
  agentId: string,
  sessionId: string,
): Event | undefined {
  if (event.type !== "task.started" && event.type !== "task.terminated")
    return undefined;
  const legacyType =
    event.type === "task.started"
      ? "background.task.started"
      : "background.task.terminated";
  return { ...event, type: legacyType, agentId, sessionId } as unknown as Event;
}

/** Session/workspace/config events are broadcast to every connection. */
export function isGlobalEvent(type: string): boolean {
  return (
    type === "session.meta.updated" ||
    type.startsWith("event.session.") ||
    type.startsWith("event.workspace.") ||
    type.startsWith("event.config.")
  );
}

export function isAgentLifecycleEvent(type: string): boolean {
  return type === "agent.created" || type === "agent.disposed";
}

/**
 * Per-subscription agent allowlist check — shared by live fan-out and replay.
 * Returns `true` when the envelope should be delivered to a subscriber carrying
 * `filter`:
 *   - `filter === undefined` → receive every agent (legacy session-grained
 *     behavior);
 *   - global events (session/workspace/config) and agent lifecycle events
 *     (`agent.created` / `agent.disposed`) are not per-agent stream content
 *     and always pass;
 *   - events without a string `agentId` (should not happen on the v1 wire,
 *     where the broadcaster stamps every event) pass defensively rather than
 *     being dropped;
 *   - otherwise the envelope's `payload.agentId` must be in the allowlist.
 */
export function matchesAgentFilter(
  envelope: EventEnvelope,
  filter: AgentFilter,
): boolean {
  if (filter === undefined) return true;
  if (isGlobalEvent(envelope.type)) return true;
  if (isAgentLifecycleEvent(envelope.type)) return true;
  const payload = envelope.payload;
  const agentId =
    typeof payload === "object" && payload !== null
      ? (payload as { agentId?: unknown }).agentId
      : undefined;
  if (typeof agentId !== "string") return true;
  return filter.has(agentId);
}

/**
 * Event types the transcript protocol already projects (the authoritative
 * mapping is the projector — `services/transcript/coreEventMap.ts`): a
 * connection carrying a non-'off' transcript grade for the emitting agent
 * gets the same information via `transcript.ops` / `transcript.reset`, so the
 * duplicate `session_event` is suppressed on that connection.
 *
 * Deliberately retained (never suppressed):
 *   - `agent.created` / `agent.disposed` — the transcript has no lifecycle
 *     events; a roster change surfaces there only implicitly, as the new
 *     agent's baseline reset;
 *   - `tool.list.updated`, `mcp.server.status` — not projected;
 *   - every global event ({@link isGlobalEvent}) — session/workspace/config
 *     facts live outside the per-agent transcript.
 *
 * Two entries are defensive: `prompt.submitted` is projected but nobody
 * publishes it on the v2 bus today (Phase 2 finding), and `task.notified` has
 * a projector case without a v1 wire-schema entry. `background.task.started`
 * / `background.task.terminated` are the legacy aliases of the projected
 * `task.started` / `task.terminated` (see {@link legacyTaskEvent}).
 */
export const TRANSCRIPT_PROJECTED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "turn.started",
  "turn.ended",
  "turn.step.started",
  "turn.step.completed",
  "turn.step.interrupted",
  "turn.step.retrying",
  "assistant.delta",
  "thinking.delta",
  "tool.call.delta",
  "tool.call.started",
  "tool.progress",
  "tool.result",
  "shell.started",
  "shell.output",
  "shell.completed",
  "task.started",
  "task.terminated",
  "background.task.started",
  "background.task.terminated",
  "task.notified",
  "subagent.spawned",
  "subagent.started",
  "subagent.completed",
  "subagent.failed",
  "subagent.suspended",
  "compaction.started",
  "compaction.blocked",
  "compaction.cancelled",
  "compaction.completed",
  "skill.activated",
  "plugin_command.activated",
  "cron.fired",
  "error",
  "warning",
  "goal.updated",
  "plan.revision",
  "context.spliced",
  "agent.status.updated",
  "hook.result",
  "prompt.submitted",
  "prompt.completed",
  "prompt.aborted",
  "prompt.steered",
  "event.question.requested",
  "event.question.dismissed",
  "event.question.answered",
  "event.approval.requested",
  "event.approval.resolved",
]);

/**
 * Per-connection transcript dedup check — shared by live fan-out and replay,
 * mirroring {@link matchesAgentFilter}. Returns `true` when the envelope is a
 * transcript-projected `session_event` the subscriber already receives via
 * the transcript stream:
 *   - `spec === undefined` → nothing is suppressed (legacy connections see
 *     every `session_event`);
 *   - global events and agent lifecycle events are never suppressed;
 *   - events without a string `agentId` pass defensively (same rule as the
 *     agent allowlist);
 *   - an 'off' grade for the emitting agent suppresses nothing;
 *   - otherwise the envelope is suppressed iff its type is in
 *     {@link TRANSCRIPT_PROJECTED_EVENT_TYPES}.
 */
export function suppressedByTranscript(
  envelope: EventEnvelope,
  spec: TranscriptGradeSpec | undefined,
): boolean {
  if (spec === undefined) return false;
  if (isGlobalEvent(envelope.type)) return false;
  if (isAgentLifecycleEvent(envelope.type)) return false;
  const payload = envelope.payload;
  const agentId =
    typeof payload === "object" && payload !== null
      ? (payload as { agentId?: unknown }).agentId
      : undefined;
  if (typeof agentId !== "string") return false;
  if (gradeFor(spec, agentId) === "off") return false;
  return TRANSCRIPT_PROJECTED_EVENT_TYPES.has(envelope.type);
}

// ---------------------------------------------------------------------------
// Interaction → v1 protocol event synthesis. Event names and payload shapes
// mirror v1's question/approval services
// (`packages/server/src/services/{question,approval}/*Service.ts`); the wire
// request bodies are the same projections the REST/snapshot routes use.
// ---------------------------------------------------------------------------

export function interactionRequestedEvent(
  interaction: Interaction,
  sessionId: string,
): Event | undefined {
  const agentId = interaction.origin.agentId ?? "main";
  switch (interaction.kind) {
    case "question":
      return {
        type: "event.question.requested",
        agentId,
        sessionId,
        ...toWireQuestion(interaction, sessionId),
      } as unknown as Event;
    case "approval":
      return {
        type: "event.approval.requested",
        agentId,
        sessionId,
        ...toWireApproval(interaction, sessionId),
      } as unknown as Event;
    default:
      // 'user_tool' has no v1 protocol event.
      return undefined;
  }
}

export function interactionResolvedEvent(
  kind: InteractionKind,
  id: string,
  response: unknown,
  sessionId: string,
  agentId: string,
): Event | undefined {
  const resolvedAt = new Date().toISOString();
  switch (kind) {
    case "question": {
      // `null` marks a dismissal (see `ISessionQuestionService.dismiss`).
      if (response === null) {
        return {
          type: "event.question.dismissed",
          agentId,
          sessionId,
          question_id: id,
          dismissed_at: resolvedAt,
        } as unknown as Event;
      }
      // `QuestionResult` is either `{ answers, method? }` or a bare answers record.
      const answers = (response as { answers?: unknown }).answers ?? response;
      return {
        type: "event.question.answered",
        agentId,
        sessionId,
        question_id: id,
        answers,
        resolved_at: resolvedAt,
      } as unknown as Event;
    }
    case "approval": {
      const r = response as Partial<ApprovalResponse>;
      return {
        type: "event.approval.resolved",
        agentId,
        sessionId,
        approval_id: id,
        decision: r.decision,
        scope: r.scope,
        feedback: r.feedback,
        selected_label: r.selectedLabel,
        resolved_at: resolvedAt,
      } as unknown as Event;
    }
    default:
      return undefined;
  }
}

/**
 * Validate the `session.meta.updated` payload published on the core
 * `IEventService`. Both the first-prompt auto-title path
 * (`agent-core-v2`'s `applyPromptMetadataUpdate`) and the
 * `POST /sessions/{id}/profile` rename route wrap the v1 fields under
 * `payload` alongside `agentId`/`sessionId`; we unwrap the title/patch here
 * and re-attach `agentId`/`sessionId` at the edge.
 */
export function sessionMetaUpdatedPayload(
  payload: unknown,
): Pick<SessionMetaUpdatedEvent, "title" | "patch"> | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const candidate = payload as Partial<SessionMetaUpdatedEvent>;
  const title =
    typeof candidate.title === "string" ? candidate.title : undefined;
  const patch =
    typeof candidate.patch === "object" &&
    candidate.patch !== null &&
    !Array.isArray(candidate.patch)
      ? candidate.patch
      : undefined;
  if (title === undefined && patch === undefined) return undefined;
  return { title, patch };
}

/** Recover the originating session id carried on the core payload. */
export function sessionMetaUpdatedSessionId(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const sessionId = (payload as { sessionId?: unknown }).sessionId;
  return typeof sessionId === "string" && sessionId.length > 0
    ? sessionId
    : undefined;
}

/**
 * Validate the `event.session.created` payload published on the core
 * `IEventService`. The create/fork/child routes publish
 * `{ agentId, sessionId, session }`; we unwrap the real session id and wire
 * session here and re-attach `agentId`/`sessionId` at the edge.
 */
export function sessionCreatedPayload(
  payload: unknown,
): { sessionId: string; session: SessionCreatedEvent["session"] } | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const candidate = payload as { sessionId?: unknown; session?: unknown };
  const sessionId =
    typeof candidate.sessionId === "string" && candidate.sessionId.length > 0
      ? candidate.sessionId
      : undefined;
  const session =
    typeof candidate.session === "object" &&
    candidate.session !== null &&
    !Array.isArray(candidate.session)
      ? (candidate.session as SessionCreatedEvent["session"])
      : undefined;
  if (sessionId === undefined || session === undefined) return undefined;
  return { sessionId, session };
}

/**
 * Validate the `event.config.warning` payload published on the core
 * `IEventService` (`{ warnings: [{ domain?, message }] }`). Any malformed
 * entry rejects the whole batch — the publisher always sends the full current
 * warning set, so a partial frame would be a lie by omission.
 */
export function configWarningPayload(
  payload: unknown,
): { warnings: ConfigWarningItem[] } | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const warnings = (payload as { warnings?: unknown }).warnings;
  if (!Array.isArray(warnings)) return undefined;
  const items: ConfigWarningItem[] = [];
  for (const warning of warnings) {
    if (typeof warning !== "object" || warning === null) return undefined;
    const message = (warning as { message?: unknown }).message;
    if (typeof message !== "string" || message.length === 0) return undefined;
    const domain = (warning as { domain?: unknown }).domain;
    if (domain !== undefined && typeof domain !== "string") return undefined;
    items.push(typeof domain === "string" ? { domain, message } : { message });
  }
  return { warnings: items };
}
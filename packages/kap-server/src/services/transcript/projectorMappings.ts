import type { TurnOrigin, TurnState, TranscriptTask, TranscriptTodo } from "@moonshot-ai/transcript";

// ---------------------------------------------------------------------------
// Pure mapping helpers
// ---------------------------------------------------------------------------

export function nowIso(): string {
  return new Date().toISOString();
}

export function epochMsToIso(value: number): string {
  return new Date(value).toISOString();
}

/** Event payload without the `type` discriminant (markers carry it verbatim). */
export function restOf(event: { readonly type: string }): Record<string, unknown> {
  const { type: _type, ...rest } = event;
  return rest;
}

/**
 * Engine `PromptOrigin` → transcript `TurnOrigin` (mirrors the cold-path
 * `groupMessagesIntoSnapshot` origin mapping; payload kept verbatim).
 */
export function mapTurnOrigin(origin: unknown): TurnOrigin {
  const candidate = origin as { kind?: unknown } | null | undefined;
  const kind = typeof candidate?.kind === "string" ? candidate.kind : undefined;
  switch (kind) {
    case "user":
      return { kind: "user", payload: origin };
    case "cron_job":
    case "cron_missed": {
      const jobId = (candidate as { jobId?: unknown }).jobId;
      return {
        kind: "cron",
        taskId: typeof jobId === "string" ? jobId : undefined,
        payload: origin,
      };
    }
    case "task":
    case "background_task": {
      const taskId = (candidate as { taskId?: unknown }).taskId;
      return typeof taskId === "string"
        ? { kind: "task", taskId, payload: origin }
        : { kind: "other", payload: origin };
    }
    case "hook_result":
      return { kind: "hook", payload: origin };
    case "compaction_summary":
      return { kind: "compaction", payload: origin };
    case "shell_command":
      // `!shell` echoes are user-visible input (same treatment as the cold path).
      return { kind: "user", payload: origin };
    default:
      return { kind: "other", payload: origin };
  }
}

export function mapTurnEndState(
  reason: "completed" | "cancelled" | "failed" | "blocked",
): TurnState {
  switch (reason) {
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "failed":
    case "blocked":
      // The engine folds `blocked` into `failed` at the wire edge (see
      // `TurnEndReason`); the transcript mirrors that contract.
      return "failed";
  }
}

/** Engine task kinds (`AgentTaskInfoByKind`: process / agent / question) → transcript kinds. */
export function mapTaskKind(kind: string): TranscriptTask["kind"] {
  switch (kind) {
    case "process":
      return "shell";
    case "agent":
      return "subagent";
    default:
      return "other";
  }
}

export function mapInteractionEndState(
  kind: "approval" | "question",
  response: unknown,
): TranscriptInteraction["state"] {
  if (kind === "question") return response === null ? "dismissed" : "answered";
  const decision = (response as { decision?: unknown } | null | undefined)
    ?.decision;
  if (
    decision === "approved" ||
    decision === "rejected" ||
    decision === "cancelled"
  ) {
    return decision;
  }
  return "cancelled";
}

/** Engine todo tool name and the singleton todo entity id (the engine store key). */
export const TODO_LIST_TOOL_NAME = "TodoList";
export const TODO_ENTITY_ID = "todo";

/** TodoList write args → todo items; undefined when the call is a read or malformed. */
export function todoWriteItems(input: unknown): TranscriptTodo["items"] | undefined {
  const todos = (input as { todos?: unknown } | undefined)?.todos;
  if (!Array.isArray(todos)) return undefined;
  const items: { title: string; status: "pending" | "in_progress" | "done" }[] =
    [];
  for (const entry of todos) {
    const title = (entry as { title?: unknown } | undefined)?.title;
    const status = (entry as { status?: unknown } | undefined)?.status;
    if (typeof title !== "string") return undefined;
    if (status !== "pending" && status !== "in_progress" && status !== "done")
      return undefined;
    items.push({ title, status });
  }
  return items;
}

/** Tool args arrive parsed in v2; tolerate a raw JSON string (parse-or-keep). */
export function parseToolArgs(args: unknown): unknown {
  if (typeof args !== "string" || args.length === 0) return args;
  try {
    return JSON.parse(args) as unknown;
  } catch {
    return args;
  }
}
/**
 * Best-effort normalization for model-emitted tool args before AJV validation.
 * Some providers stringify numbers or use Claude-style TodoWrite field names
 * (status aliases, per-item `description` / `id` / `note`, and so on).
 */

function coerceIntegerField(value: unknown): unknown {
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return Number(value);
  }
  return value;
}

const TODO_STATUS_ALIASES: Record<string, "pending" | "in_progress" | "done"> =
  {
    completed: "done",
    complete: "done",
    cancelled: "done",
    canceled: "done",
    wip: "in_progress",
    "in progress": "in_progress",
  };

function normalizeReadArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!("line_offset" in args)) return args;
  return {
    ...args,
    line_offset: coerceIntegerField(args.line_offset),
  };
}

function normalizeTodoListArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const todos = args.todos;
  if (!Array.isArray(todos)) return args;
  return {
    ...args,
    todos: todos.map((item) => {
      if (typeof item !== "object" || item === null) return item;
      const record = item as Record<string, unknown>;
      const rawStatus = record.status;
      const status =
        typeof rawStatus === "string"
          ? (TODO_STATUS_ALIASES[rawStatus] ?? rawStatus)
          : rawStatus;
      return {
        title: record.title,
        status,
      };
    }),
  };
}

export function normalizeToolArgsForValidation(
  toolName: string,
  args: unknown,
): unknown {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return args;
  }
  const record = args as Record<string, unknown>;
  switch (toolName) {
    case "Read":
      return normalizeReadArgs(record);
    case "TodoList":
      return normalizeTodoListArgs(record);
    default:
      return args;
  }
}

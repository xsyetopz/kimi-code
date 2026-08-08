/** Task-class model routing — cheap paths should not burn the coding model. */

export type TaskClass = "implement" | "review" | "plan" | "cheap";

export interface ModelRouteTable {
  readonly implement: string;
  readonly review: string;
  readonly plan: string;
  readonly cheap: string;
}

export const DEFAULT_MODEL_ROUTE_TABLE: ModelRouteTable = {
  implement: "openai/gpt-4.1",
  review: "openai/gpt-4.1-mini",
  plan: "openai/gpt-4.1-mini",
  cheap: "openai/gpt-4.1-mini",
};

export function classifyTask(
  text: string,
  options?: { readonly planMode?: boolean },
): TaskClass {
  if (options?.planMode) return "plan";
  const trimmed = text.trim();
  if (
    trimmed.startsWith("/usage") ||
    trimmed.startsWith("/cost") ||
    trimmed.startsWith("/help") ||
    trimmed.startsWith("/sessions") ||
    trimmed.startsWith("/auth") ||
    trimmed.startsWith("/skills") ||
    trimmed.startsWith("/provider") ||
    trimmed.startsWith("/diff")
  ) {
    return "cheap";
  }
  if (trimmed.startsWith("/review") || /\breview\b/i.test(trimmed)) {
    return "review";
  }
  if (trimmed.startsWith("/plan") || trimmed.startsWith("/implement")) {
    return trimmed.startsWith("/implement") ? "implement" : "plan";
  }
  return "implement";
}

export function modelForTask(
  task: TaskClass,
  table: ModelRouteTable = DEFAULT_MODEL_ROUTE_TABLE,
): string {
  switch (task) {
    case "implement":
      return table.implement;
    case "review":
      return table.review;
    case "plan":
      return table.plan;
    case "cheap":
      return table.cheap;
    default: {
      const _exhaustive: never = task;
      return _exhaustive;
    }
  }
}

/** Parse `KIMI_ROUTE_MODELS=implement=a,review=b,plan=c,cheap=d`. */
export function parseRouteTable(raw: string | undefined): ModelRouteTable {
  if (!raw || raw.trim().length === 0) return DEFAULT_MODEL_ROUTE_TABLE;
  let implement = DEFAULT_MODEL_ROUTE_TABLE.implement;
  let review = DEFAULT_MODEL_ROUTE_TABLE.review;
  let plan = DEFAULT_MODEL_ROUTE_TABLE.plan;
  let cheap = DEFAULT_MODEL_ROUTE_TABLE.cheap;
  for (const part of raw.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!value) continue;
    if (key === "implement") implement = value;
    else if (key === "review") review = value;
    else if (key === "plan") plan = value;
    else if (key === "cheap") cheap = value;
  }
  return { implement, review, plan, cheap };
}

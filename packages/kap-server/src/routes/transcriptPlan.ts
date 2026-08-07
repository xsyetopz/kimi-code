import type {
  ToolCallFrame,
  TranscriptInteraction,
  TranscriptItem,
} from "@moonshot-ai/transcript";

/** The review round-trip of one ExitPlanMode call, from its approval interaction. */
interface PlanReviewInfo {
  state: "pending" | "approved" | "rejected" | "cancelled";
  selected_option?: string;
  feedback?: string;
}

/** One ExitPlanMode call's projected plan information. */
interface PlanInfo {
  tool_call_id: string;
  turn_id: string;
  source: "interaction" | "display" | "output";
  plan: string;
  path?: string;
  options?: { label: string; description?: string }[];
  review?: PlanReviewInfo;
}

/** Structural read of the open-content `plan_review` display payload. */
interface PlanReviewDisplayInfo {
  plan: string;
  path?: string;
  options?: { label: string; description?: string }[];
}

/**
 * Project the plan information of an agent's ExitPlanMode tool calls, in
 * timeline order. `toolCallId` narrows the read to that one call. A call
 * whose content is not recoverable (e.g. it errored before the review
 * display existed) is skipped. Content comes from the first available fact:
 *
 *  1. the linked approval interaction's persisted `request` display — every
 *     interactive review (approve / Revise / Reject / dismiss), live or cold;
 *  2. the tool frame's `display` — live only (cold rebuilds do not restore
 *     displays), covers auto permission mode where no interaction exists;
 *  3. the tool frame's `output` text — the approved/auto-approved tool
 *     result embeds the plan body (see `parsePlanFromOutput`), the only
 *     source for cold rebuilds without an interaction.
 */
export function projectPlans(
  items: readonly TranscriptItem[],
  interactions: readonly TranscriptInteraction[],
  toolCallId?: string,
): PlanInfo[] {
  const plans: PlanInfo[] = [];
  for (const item of items) {
    if (item.kind !== "turn") continue;
    for (const step of item.steps) {
      for (const frame of step.frames) {
        if (frame.kind !== "tool" || frame.name !== "ExitPlanMode") continue;
        if (toolCallId !== undefined && frame.toolCallId !== toolCallId)
          continue;
        const info = projectPlanFrame(item.turnId, frame, interactions);
        if (info !== undefined) plans.push(info);
      }
    }
  }
  return plans;
}

/** Project one ExitPlanMode tool frame; `undefined` when no content is recoverable. */
function projectPlanFrame(
  turnId: string,
  frame: ToolCallFrame,
  interactions: readonly TranscriptInteraction[],
): PlanInfo | undefined {
  const toolCallId = frame.toolCallId;
  const interaction = interactions.find(
    (i) => i.interactionKind === "approval" && i.toolCallId === toolCallId,
  );
  const review = readPlanReview(interaction);

  const requestDisplay =
    interaction !== undefined &&
    interaction.request !== null &&
    typeof interaction.request === "object"
      ? (interaction.request as { display?: unknown }).display
      : undefined;
  const fromInteraction = readPlanReviewDisplay(requestDisplay);
  if (fromInteraction !== undefined) {
    return {
      tool_call_id: toolCallId,
      turn_id: turnId,
      source: "interaction",
      ...fromInteraction,
      review,
    };
  }
  const fromDisplay = readPlanReviewDisplay(frame.display);
  if (fromDisplay !== undefined) {
    return {
      tool_call_id: toolCallId,
      turn_id: turnId,
      source: "display",
      ...fromDisplay,
      review,
    };
  }
  const fromOutput = parsePlanFromOutput(frame.output);
  if (fromOutput !== undefined) {
    return {
      tool_call_id: toolCallId,
      turn_id: turnId,
      source: "output",
      ...fromOutput,
      review,
    };
  }
  return undefined;
}

/** Map an approval interaction onto the review info; `undefined` when there is none. */
function readPlanReview(
  interaction: TranscriptInteraction | undefined,
): PlanReviewInfo | undefined {
  if (interaction === undefined) return undefined;
  const state = interaction.state;
  if (
    state !== "pending" &&
    state !== "approved" &&
    state !== "rejected" &&
    state !== "cancelled"
  ) {
    return undefined;
  }
  const response =
    interaction.response !== null && typeof interaction.response === "object"
      ? (interaction.response as {
          selectedLabel?: unknown;
          feedback?: unknown;
        })
      : undefined;
  const selected =
    typeof response?.selectedLabel === "string" &&
    response.selectedLabel.length > 0
      ? response.selectedLabel
      : undefined;
  const feedback =
    typeof response?.feedback === "string" && response.feedback.length > 0
      ? response.feedback
      : undefined;
  return { state, selected_option: selected, feedback };
}

/** Read a `plan_review` display payload (open content) into plan info. */
function readPlanReviewDisplay(
  display: unknown,
): PlanReviewDisplayInfo | undefined {
  if (display === null || typeof display !== "object") return undefined;
  const d = display as {
    kind?: unknown;
    plan?: unknown;
    path?: unknown;
    options?: unknown;
  };
  if (
    d.kind !== "plan_review" ||
    typeof d.plan !== "string" ||
    d.plan.trim().length === 0
  ) {
    return undefined;
  }
  const options = Array.isArray(d.options)
    ? d.options
        .map(
          (option: unknown): { label: string; description?: string } | null => {
            if (option === null || typeof option !== "object") return null;
            const o = option as { label?: unknown; description?: unknown };
            if (typeof o.label !== "string" || o.label.length === 0)
              return null;
            return {
              label: o.label,
              description:
                typeof o.description === "string" ? o.description : undefined,
            };
          },
        )
        .filter((o): o is { label: string; description?: string } => o !== null)
    : undefined;
  return {
    plan: d.plan,
    path: typeof d.path === "string" ? d.path : undefined,
    options: options !== undefined && options.length > 0 ? options : undefined,
  };
}

// The wording mirrors `formatPlanForOutput` / `formatAutoApprovedPlanForOutput`
// in `agent-core-v2/src/agent/tools/plan/exit-plan-mode/exitPlanModeTool.ts` — the approved
// tool result embeds the full plan body after one of these markers, and the
// plan file path on a `Plan saved to: <path>` line.
const PLAN_SAVED_TO_MARKER = "Plan saved to: ";
const PLAN_BODY_MARKERS = [
  "## Approved Plan:\n",
  "## Plan (auto-approved, not user-reviewed):\n",
];

/**
 * Recover plan info from the ExitPlanMode tool result output text — the cold
 * rebuild path keeps the tool result but not the ephemeral review display.
 */
function parsePlanFromOutput(
  output: unknown,
): { plan: string; path?: string } | undefined {
  if (typeof output !== "string") return undefined;
  let path: string | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith(PLAN_SAVED_TO_MARKER)) {
      path = line.slice(PLAN_SAVED_TO_MARKER.length).trim() || undefined;
      break;
    }
  }
  for (const marker of PLAN_BODY_MARKERS) {
    const index = output.indexOf(marker);
    if (index === -1) continue;
    const plan = output.slice(index + marker.length);
    if (plan.trim().length > 0) return { plan, path };
  }
  return undefined;
}

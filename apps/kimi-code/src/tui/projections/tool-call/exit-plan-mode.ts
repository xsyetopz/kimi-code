export interface ExitPlanModeOutcome {
  readonly kind: "approved" | "auto_approved" | "rejected";
  readonly chosen?: string;
  readonly feedback?: string;
  readonly path?: string;
}

const REJECT_PREFIX = "User rejected the plan.";
const REJECT_FEEDBACK_PREFIX = "User rejected the plan. Feedback:";
const APPROVED_OPTION_RE = /^User approved option "([^"]+)"\./;
const PLAN_REJECT_PREFIX = "Plan rejected by user.";
const SELECTED_APPROACH_RE =
  /^Exited plan mode\. Selected approach: ([^\n]+)\n/;
const PLAN_SAVED_TO_RE = /\nPlan saved to: ([^\n]+)\n/;
export const APPROVED_PLAN_MARKER = "## Approved Plan:";
export const AUTO_APPROVED_PLAN_MARKER =
  "## Plan (auto-approved, not user-reviewed):";

/** Parses ExitPlanMode result text into an approval outcome. */
export function interpretExitPlanModeOutcome(
  output: string,
): ExitPlanModeOutcome {
  if (output.startsWith(REJECT_PREFIX)) {
    if (output.startsWith(REJECT_FEEDBACK_PREFIX)) {
      const feedback = output.slice(REJECT_FEEDBACK_PREFIX.length).trimStart();
      return { kind: "rejected", feedback };
    }
    return { kind: "rejected" };
  }
  if (output.startsWith(PLAN_REJECT_PREFIX)) {
    return { kind: "rejected" };
  }
  const pathMatch = PLAN_SAVED_TO_RE.exec(output);
  const path = pathMatch?.[1]?.trim();
  if (output.includes(AUTO_APPROVED_PLAN_MARKER)) {
    return path !== undefined && path.length > 0
      ? { kind: "auto_approved", path }
      : { kind: "auto_approved" };
  }
  const optionMatch =
    SELECTED_APPROACH_RE.exec(output) ?? APPROVED_OPTION_RE.exec(output);
  if (optionMatch !== null) {
    return path !== undefined && path.length > 0
      ? { kind: "approved", chosen: optionMatch[1], path }
      : { kind: "approved", chosen: optionMatch[1] };
  }
  return path !== undefined && path.length > 0
    ? { kind: "approved", path }
    : { kind: "approved" };
}

export function isExitPlanModeOutcomeOutput(output: string): boolean {
  return (
    output.startsWith(REJECT_PREFIX) ||
    output.startsWith(PLAN_REJECT_PREFIX) ||
    output.startsWith("Exited plan mode.") ||
    APPROVED_OPTION_RE.test(output) ||
    output.includes(APPROVED_PLAN_MARKER) ||
    output.includes(AUTO_APPROVED_PLAN_MARKER)
  );
}

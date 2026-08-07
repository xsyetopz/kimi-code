/**
 * `plan` domain — ExitPlanMode plan review.
 *
 * Owns the user-facing review that intercepts an `ExitPlanMode` call carrying
 * a non-empty `plan_review` display: drives the approval round-trip through
 * `toolApproval` (origin `exit-plan-mode-review-ask`), and folds every
 * approval outcome (approve with or without a selected option, Revise with
 * feedback, Reject and Exit, dismiss) into a synthetic tool result, exiting
 * plan mode through `plan` when the outcome deactivates it.
 */

import type {
  ApprovalResponse,
  PermissionPolicyResolution,
} from "#/agent/permissionPolicy/types";
import type { IAgentToolApprovalService } from "#/agent/toolApproval/toolApproval";
import type {
  BeforeExecuteDecision,
  ResolvedToolExecutionHookContext,
} from "#/agent/toolExecutor/toolHooks";
import type { ToolInputDisplay } from "#/tool/toolInputDisplay";

import type { IAgentPlanService } from "./plan";

type PlanReviewDisplay = Extract<ToolInputDisplay, { kind: "plan_review" }>;
type PlanReviewOption = NonNullable<PlanReviewDisplay["options"]>[number];

export class ExitPlanModeReview {
  constructor(
    private readonly plan: IAgentPlanService,
    private readonly toolApproval: IAgentToolApprovalService,
  ) {}

  async requestApproval(
    context: ResolvedToolExecutionHookContext,
  ): Promise<BeforeExecuteDecision | undefined> {
    const display = context.execution.display;
    if (display?.kind !== "plan_review") return undefined;
    if (display.plan.trim().length === 0) return undefined;
    return this.toolApproval.requestToolApproval(
      context,
      {
        kind: "ask",
        reason: {
          has_options: display.options !== undefined,
        },
        resolveApproval: (result) => this.approvalResult(result, display),
      },
      "exit-plan-mode-review-ask",
    );
  }

  private approvalResult(
    result: ApprovalResponse,
    display: PlanReviewDisplay,
  ): PermissionPolicyResolution | undefined {
    if (result.decision !== "approved") {
      return this.rejectedApprovalResult(result);
    }

    const selected = selectedExitPlanModeOption(
      display.options,
      result.selectedLabel,
    );
    this.plan.exit();

    const optionPrefix =
      selected === undefined
        ? ""
        : `Selected approach: ${selected.label}\nExecute ONLY the selected approach. Do not execute any unselected alternatives.\n\n`;
    const savedTo =
      display.path !== undefined ? `Plan saved to: ${display.path}\n\n` : "";
    const formattedPlan = `Plan mode deactivated. All tools are now available.\n${savedTo}## Approved Plan:\n${display.plan}`;
    return {
      kind: "result",
      result: {
        isError: false,
        output: `Exited plan mode. ${optionPrefix}${formattedPlan}`,
      },
    };
  }

  private rejectedApprovalResult(
    result: ApprovalResponse,
  ): PermissionPolicyResolution {
    if (result.decision === "cancelled") {
      return {
        kind: "result",
        result: {
          isError: false,
          output: "Plan approval dismissed. Plan mode remains active.",
        },
      };
    }

    if (result.selectedLabel === "Reject and Exit") {
      this.plan.exit();
      return {
        kind: "result",
        result: {
          isError: true,
          stopTurn: true,
          output: "Plan rejected by user. Plan mode deactivated.",
        },
      };
    }

    const feedback = result.feedback ?? "";
    if (result.selectedLabel === "Revise" || feedback.length > 0) {
      return {
        kind: "result",
        result: {
          isError: false,
          output:
            feedback.length > 0
              ? `User rejected the plan. Feedback:\n\n${feedback}`
              : "User requested revisions. Plan mode remains active.",
        },
      };
    }

    return {
      kind: "result",
      result: {
        isError: true,
        stopTurn: true,
        output: "Plan rejected by user. Plan mode remains active.",
      },
    };
  }
}

function selectedExitPlanModeOption(
  options: readonly PlanReviewOption[] | undefined,
  label: string | undefined,
): PlanReviewOption | undefined {
  if (options === undefined || label === undefined) return undefined;
  return options.find((option) => option.label === label);
}

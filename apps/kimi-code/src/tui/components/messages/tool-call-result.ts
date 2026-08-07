import { Text } from "@moonshot-ai/kimi-tui";
import type { Component } from "@moonshot-ai/kimi-tui";

import { COMMAND_PREVIEW_LINES } from "#/tui/constant/rendering";
import { currentTheme } from "#/tui/theme";
import type { MarkdownTheme } from "@moonshot-ai/kimi-tui";
import {
  interpretExitPlanModeOutcome,
  isExitPlanModeOutcomeOutput,
} from "#/tui/projections/tool-call/exit-plan-mode";
import {
  extractPartialStringField,
  projectWriteEditPreviewLines,
} from "#/tui/projections/tool-call/call-preview";
import { projectAgentSwarmResultSummaryLines } from "#/tui/projections/tool-call/agent-swarm-result";
import type { ToolCallBlockData, ToolResultBlockData } from "#/tui/types";

import { PlanBoxComponent } from "./plan-box";
import { ShellExecutionComponent } from "./shell-execution";
import { pickResultRenderer } from "./tool-renderers/registry";

export interface ToolCallResultHost {
  readonly toolCall: ToolCallBlockData;
  readonly result: ToolResultBlockData | undefined;
  readonly expanded: boolean;
  readonly markdownTheme: MarkdownTheme;
  readonly currentPlan: string | undefined;
  readonly planPath: string | undefined;
  isSingleSubagentView(): boolean;
  addBodyChild(child: Component): void;
  addPreviewLines(lines: readonly string[]): void;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function extractApprovedPlan(
  output: string,
  approvedMarker: string,
  autoApprovedMarker: string,
): string {
  const marker = output.includes(autoApprovedMarker)
    ? autoApprovedMarker
    : approvedMarker;
  const markerIndex = output.indexOf(marker);
  if (markerIndex < 0) return "";
  return output.slice(markerIndex + marker.length).trim();
}

/** Call-preview and result-body rendering for {@link ToolCallComponent}. */
export class ToolCallResultFacet {
  constructor(
    private readonly host: ToolCallResultHost,
    private readonly approvedPlanMarker: string,
    private readonly autoApprovedPlanMarker: string,
  ) {}

  buildCallPreview(): void {
    const { toolCall, result } = this.host;
    const name = toolCall.name;
    if (name === "ExitPlanMode") {
      this.buildPlanPreview();
      return;
    }
    if (result === undefined && toolCall.truncated === true) {
      this.host.addBodyChild(
        new Text(
          currentTheme.dim(
            "Tool call arguments truncated by max_tokens — call never executed.",
          ),
          2,
          0,
        ),
      );
      return;
    }
    if (name === "Write" || name === "Edit") {
      this.host.addPreviewLines(
        projectWriteEditPreviewLines({
          toolCall,
          result,
          expanded: this.host.expanded,
        }),
      );
      return;
    }
    if (result === undefined && toolCall.streamingArguments !== undefined) {
      this.buildStreamingPreview(toolCall.streamingArguments);
      return;
    }
    if (name === "Bash") {
      const command = str(toolCall.args["command"]);
      if (command.length === 0) return;
      this.host.addBodyChild(
        new ShellExecutionComponent({
          command,
          showCommand: true,
          commandPreviewLines: this.host.expanded
            ? undefined
            : COMMAND_PREVIEW_LINES,
        }),
      );
    }
  }

  buildStreamingPreview(streamText: string): void {
    const name = this.host.toolCall.name;
    if (name === "Bash") {
      const cmd = extractPartialStringField(streamText, "command");
      if (cmd === undefined || cmd.length === 0) return;
      this.host.addBodyChild(
        new ShellExecutionComponent({
          command: cmd,
          showCommand: true,
          commandPreviewLines: this.host.expanded
            ? undefined
            : COMMAND_PREVIEW_LINES,
        }),
      );
    }
  }

  buildPlanPreview(): void {
    const plan = this.resolvePlanForPreview();
    if (plan.length === 0) return;
    const path = this.resolvePlanPath();
    this.host.addBodyChild(
      new PlanBoxComponent(
        plan,
        this.host.markdownTheme,
        currentTheme.color("success"),
        path,
        {
          status: this.resolvePlanBoxStatus(),
        },
      ),
    );
  }

  buildContent(): void {
    const { result } = this.host;
    if (result === undefined) return;

    if (this.host.toolCall.name === "AgentSwarm") {
      this.buildAgentSwarmResultSummary(result);
      return;
    }

    if (!result.output) return;

    if (this.host.isSingleSubagentView()) {
      return;
    }

    if (result.output.trimStart().startsWith("<system-reminder>")) {
      return;
    }

    if (
      this.host.toolCall.name === "ExitPlanMode" &&
      isExitPlanModeOutcomeOutput(result.output)
    ) {
      const outcome = interpretExitPlanModeOutcome(result.output);
      if (outcome.kind === "rejected" && outcome.feedback !== undefined) {
        const trimmed = outcome.feedback.trim();
        if (trimmed.length > 0) {
          const labelTone = (text: string) =>
            currentTheme.boldFg("warning", text);
          this.host.addBodyChild(new Text(labelTone("↪ Suggestion"), 2, 0));
          for (const line of trimmed.split("\n")) {
            this.host.addBodyChild(new Text(line, 4, 0));
          }
        }
      }
      return;
    }

    if (this.host.toolCall.name === "TodoList" && !result.is_error) {
      return;
    }

    if (this.host.toolCall.name === "EnterPlanMode" && !result.is_error) {
      return;
    }

    if (
      this.host.toolCall.name === "AskUserQuestion" &&
      this.host.toolCall.args["background"] !== true &&
      !result.is_error &&
      this.renderAskUserQuestionResult(result.output)
    ) {
      return;
    }

    const renderer = pickResultRenderer(this.host.toolCall.name);
    const components = renderer(this.host.toolCall, result, {
      expanded: this.host.expanded,
    });
    for (const component of components) {
      this.host.addBodyChild(component);
    }
  }

  private buildAgentSwarmResultSummary(result: ToolResultBlockData): void {
    for (const line of projectAgentSwarmResultSummaryLines(result)) {
      this.host.addBodyChild(new Text(line, 2, 0));
    }
  }

  private renderAskUserQuestionResult(output: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      return false;
    }
    if (typeof parsed !== "object" || parsed === null) return false;

    const accent = (text: string) => currentTheme.fg("primary", text);

    const answers = (parsed as { answers?: unknown }).answers;
    const note = (parsed as { note?: unknown }).note;

    const hasAnswers =
      typeof answers === "object" &&
      answers !== null &&
      Object.keys(answers).length > 0;

    if (!hasAnswers) {
      const noteText =
        typeof note === "string" && note.length > 0
          ? note
          : "User dismissed the question.";
      this.host.addBodyChild(new Text(currentTheme.dim(`  ${noteText}`), 0, 0));
      return true;
    }

    for (const [question, answer] of Object.entries(
      answers as Record<string, unknown>,
    )) {
      const answerText =
        typeof answer === "string" ? answer : JSON.stringify(answer);
      this.host.addBodyChild(
        new Text(`  ${currentTheme.dim("Q")}  ${question}`, 0, 0),
      );
      this.host.addBodyChild(new Text(`  ${accent("→")}  ${answerText}`, 0, 0));
    }
    return true;
  }

  private resolvePlanForPreview(): string {
    const inlinePlan = str(this.host.toolCall.args["plan"]);
    if (inlinePlan.length > 0) return inlinePlan;
    if (this.host.result !== undefined && !this.host.result.is_error) {
      const approved = extractApprovedPlan(
        this.host.result.output,
        this.approvedPlanMarker,
        this.autoApprovedPlanMarker,
      );
      if (approved.length > 0) return approved;
    }
    return this.host.currentPlan ?? "";
  }

  private resolvePlanPath(): string | undefined {
    if (this.host.result !== undefined && !this.host.result.is_error) {
      const fromResult = interpretExitPlanModeOutcome(
        this.host.result.output,
      ).path;
      if (fromResult !== undefined && fromResult.length > 0) return fromResult;
    }
    return this.host.planPath;
  }

  private resolvePlanBoxStatus():
    | { label: string; colorHex: string }
    | undefined {
    const result = this.host.result;
    if (this.host.toolCall.name !== "ExitPlanMode" || result === undefined)
      return undefined;
    if (!isExitPlanModeOutcomeOutput(result.output)) return undefined;
    const outcome = interpretExitPlanModeOutcome(result.output);
    if (outcome.kind !== "rejected") return undefined;
    return { label: "Rejected", colorHex: currentTheme.color("error") };
  }
}

/**
 * `agentLifecycle` domain — builtin `orchestrator` profile contribution.
 *
 * Registers the swarm-orchestrator profile: delegates implementation work to
 * subagents, keeps plan-mode and goal tools on the caller lane, and does not
 * carry file-editing tools itself.
 */

import { registerAgentProfile } from "#/app/agentProfileCatalog/contribution";
import {
  renderSystemPromptResult,
  skillActiveFor,
} from "#/app/agentProfileCatalog/profile-shared";

const ORCHESTRATOR_TOOLS = [
  "Read",
  "ReadMediaFile",
  "Glob",
  "Grep",
  "WebSearch",
  "FetchURL",
  "AgentSwarm",
  "EnterPlanMode",
  "ExitPlanMode",
  "CreateGoal",
  "GetGoal",
  "SetGoalBudget",
  "UpdateGoal",
  "TodoList",
  "AskUserQuestion",
  "Skill",
  "TaskList",
  "TaskOutput",
  "mcp__*",
] as const;

const ORCHESTRATOR_ROLE =
  "You are the swarm orchestrator for this session. Explore and plan on your own lane, " +
  "then delegate distinct implementation or exploration work to subagents through AgentSwarm. " +
  "Do not edit source files yourself — spawn coder subagents for changes and explore or plan " +
  "subagents for read-only investigation. While subagents run, you may stay in plan mode or " +
  "goal mode without blocking the worker pool.";

registerAgentProfile({
  name: "orchestrator",
  description:
    "Swarm orchestrator — plans and coordinates parallel subagents without direct file edits.",
  whenToUse:
    "Use when the user wants large parallel workstreams: explore the task, enter plan or goal mode on the orchestrator lane, then fan out coder/explore/plan subagents.",
  tools: ORCHESTRATOR_TOOLS,
  subagents: ["coder", "explore", "plan"],
  renderSystemPrompt: (context) =>
    renderSystemPromptResult(ORCHESTRATOR_ROLE, context, {
      skillActive: skillActiveFor(ORCHESTRATOR_TOOLS),
    }),
});

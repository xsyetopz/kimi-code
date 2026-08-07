import { z } from "zod";

import { isoDateTimeSchema } from "@moonshot-ai/agent-core-v2/_base/utils/isoDateTime";
import type { TurnEndReason } from "@moonshot-ai/agent-core-v2/agent/loop/turnEvents";
import type { HookResultEvent } from "@moonshot-ai/agent-core-v2/agent/externalHooks/externalHooksService";
import type {
  CompactionBlockedEvent,
  CompactionCancelledEvent,
  CompactionCompletedEvent,
  CompactionStartedEvent,
} from "@moonshot-ai/agent-core-v2/agent/fullCompaction/compactionOps";
import type {
  AssistantDeltaEvent,
  ThinkingDeltaEvent,
  ToolCallDeltaEvent,
  TurnStepCompletedEvent,
  TurnStepInterruptedEvent,
  TurnStepStartedEvent,
} from "@moonshot-ai/agent-core-v2/agent/loop/turnEvents";
import type {
  McpServerStatusEvent,
  McpServerStatusPayload,
  ToolListUpdatedEvent,
  ToolListUpdatedReason,
} from "@moonshot-ai/agent-core-v2/agent/mcp/mcpService";
import type { WarningEvent } from "@moonshot-ai/agent-core-v2/agent/profile/profileService";
import type { PluginCommandActivatedEvent } from "@moonshot-ai/agent-core-v2/agent/rpc/rpcService";
import type {
  ShellCompletedEvent,
  ShellOutputEvent,
  ShellStartedEvent,
} from "@moonshot-ai/agent-core-v2/agent/shellCommand/shellCommandService";
import type { TurnStepRetryingEvent } from "@moonshot-ai/agent-core-v2/agent/stepRetry/stepRetryService";
import type {
  ToolCallStartedEvent,
  ToolProgressEvent,
  ToolResultEvent,
} from "@moonshot-ai/agent-core-v2/agent/toolExecutor/toolExecutorEvents";
import type {
  SubagentCompletedEvent,
  SubagentFailedEvent,
  SubagentSpawnedEvent,
  SubagentStartedEvent,
} from "@moonshot-ai/agent-core-v2/session/subagent/mirrorAgentRun";
import type { SubagentSuspendedEvent } from "@moonshot-ai/agent-core-v2/session/swarm/sessionSwarmService";

import { ToolInputDisplaySchema } from "./display";
import { configResponseSchema } from "./rest-config";
import { messageContentSchema } from "./message";
import { sessionPendingInteractionSchema, sessionSchema } from "./session";
import { workspaceSchema } from "./workspace";
import {
  agentPhaseSchema,
  compactionResultSchema,
  cronJobOriginSchema,
  goalChangeSchema,
  kimiErrorPayloadObjectSchema,
  permissionModeSchema,
  promptOriginSchema,
  taskInfoSchema,
  taskLifecycleStatusSchema,
  tokenUsageSchema,
  toolUpdateSchema,
  turnEndReasonSchema,
  usageStatusSchema,
} from "./events-zod-primitives";

export const agentStatusUpdatedEventSchema = z.object({
  type: z.literal("agent.status.updated"),
  model: z.string().optional(),
  thinkingEffort: z.string().optional(),
  contextTokens: z.number().optional(),
  maxContextTokens: z.number().optional(),
  contextUsage: z.number().optional(),
  planMode: z.boolean().optional(),
  swarmMode: z.boolean().optional(),
  permission: permissionModeSchema.optional(),
  usage: usageStatusSchema.optional(),
  phase: agentPhaseSchema.optional(),
});

export const sessionMetaUpdatedEventSchema = z.object({
  type: z.literal("session.meta.updated"),
  title: z.string().optional(),
  patch: z.record(z.string(), z.unknown()).optional(),
});

export const agentCreatedEventSchema = z.object({
  type: z.literal("agent.created"),
});

export const agentDisposedEventSchema = z.object({
  type: z.literal("agent.disposed"),
});

export const sessionCreatedEventSchema = z.object({
  type: z.literal("event.session.created"),
  session: sessionSchema,
});

export const workspaceCreatedEventSchema = z.object({
  type: z.literal("event.workspace.created"),
  workspace: workspaceSchema,
});

export const workspaceUpdatedEventSchema = z.object({
  type: z.literal("event.workspace.updated"),
  workspace: workspaceSchema,
});

export const workspaceDeletedEventSchema = z.object({
  type: z.literal("event.workspace.deleted"),
  workspace_id: z.string().min(1),
  root: z.string().min(1),
});

export const sessionWorkChangedEventSchema = z.object({
  type: z.literal("event.session.work_changed"),
  busy: z.boolean(),
  main_turn_active: z.boolean().optional(),
  pending_interaction: sessionPendingInteractionSchema.optional(),
  last_turn_reason: z.enum(["completed", "cancelled", "failed"]).optional(),
});

const legacySessionStatusSchema = z.enum([
  "idle",
  "running",
  "awaiting_approval",
  "awaiting_question",
  "aborted",
]);

export const sessionStatusChangedEventSchema = z.object({
  type: z.literal("event.session.status_changed"),
  status: legacySessionStatusSchema,
  previous_status: legacySessionStatusSchema,
  current_prompt_id: z.string().min(1).optional(),
});

export const configChangedEventSchema = z.object({
  type: z.literal("event.config.changed"),
  changedFields: z.array(z.string()),
  config: configResponseSchema,
});

export const configWarningEventSchema = z.object({
  type: z.literal("event.config.warning"),
  warnings: z.array(
    z.object({
      domain: z.string().optional(),
      message: z.string(),
    }),
  ),
});

export const goalUpdatedEventSchema = z.object({
  type: z.literal("goal.updated"),
  snapshot: goalSnapshotSchema.nullable(),
  change: goalChangeSchema.optional(),
});

export const skillActivatedEventSchema = z.object({
  type: z.literal("skill.activated"),
  activationId: z.string(),
  skillName: z.string(),
  skillArgs: z.string().optional(),
  trigger: z.enum(["user-slash", "model-tool", "nested-skill"]),
  skillPath: z.string().optional(),
  skillSource: skillSourceSchema.optional(),
});

export const pluginCommandActivatedEventSchema = z.object({
  type: z.literal("plugin_command.activated"),
  activationId: z.string(),
  pluginId: z.string(),
  commandName: z.string(),
  commandArgs: z.string().optional(),
  trigger: z.literal("user-slash"),
}) satisfies z.ZodType<PluginCommandActivatedEvent>;

export const errorEventSchema = kimiErrorPayloadObjectSchema.extend({
  type: z.literal("error"),
});

export const warningEventSchema = z.object({
  type: z.literal("warning"),
  message: z.string(),
  code: z.string().optional(),
}) satisfies z.ZodType<WarningEvent>;

export const turnStartedEventSchema = z.object({
  type: z.literal("turn.started"),
  turnId: z.number(),
  origin: promptOriginSchema,
  prompt: z.string().optional(),
});

export const turnEndedEventSchema = z.object({
  type: z.literal("turn.ended"),
  turnId: z.number(),
  reason: turnEndReasonSchema,
  error: kimiErrorPayloadSchema.optional(),
  durationMs: z.number().optional(),
  interruptReason: z
    .enum([
      "user_cancelled",
      "aborted",
      "max_steps",
      "error",
      "filtered",
      "blocked",
    ])
    .optional(),
});

export const turnStepStartedEventSchema = z.object({
  type: z.literal("turn.step.started"),
  turnId: z.number(),
  step: z.number(),
  stepId: z.string().optional(),
}) satisfies z.ZodType<TurnStepStartedEvent>;

export const turnStepCompletedEventSchema = z.object({
  type: z.literal("turn.step.completed"),
  turnId: z.number(),
  step: z.number(),
  stepId: z.string().optional(),
  usage: tokenUsageSchema.optional(),
  finishReason: z.string().optional(),
  llmFirstTokenLatencyMs: z.number().optional(),
  llmStreamDurationMs: z.number().optional(),
  llmRequestBuildMs: z.number().optional(),
  llmServerFirstTokenMs: z.number().optional(),
  llmServerDecodeMs: z.number().optional(),
  llmClientConsumeMs: z.number().optional(),
  providerFinishReason: finishReasonSchema.optional(),
  rawFinishReason: z.string().optional(),
}) satisfies z.ZodType<TurnStepCompletedEvent>;

export const turnStepRetryingEventSchema = z.object({
  type: z.literal("turn.step.retrying"),
  turnId: z.number(),
  step: z.number(),
  stepId: z.string().optional(),
  failedAttempt: z.number(),
  nextAttempt: z.number(),
  maxAttempts: z.number(),
  delayMs: z.number(),
  errorName: z.string(),
  errorMessage: z.string(),
  statusCode: z.number().optional(),
}) satisfies z.ZodType<TurnStepRetryingEvent>;

export const turnStepInterruptedEventSchema = z.object({
  type: z.literal("turn.step.interrupted"),
  turnId: z.number(),
  step: z.number(),
  stepId: z.string().optional(),
  reason: z.string(),
  message: z.string().optional(),
}) satisfies z.ZodType<TurnStepInterruptedEvent>;

export const assistantDeltaEventSchema = z.object({
  type: z.literal("assistant.delta"),
  turnId: z.number(),
  delta: z.string(),
}) satisfies z.ZodType<AssistantDeltaEvent>;

export const hookResultEventSchema = z.object({
  type: z.literal("hook.result"),
  turnId: z.number().optional(),
  hookEvent: z.string(),
  content: z.string(),
  blocked: z.boolean().optional(),
}) satisfies z.ZodType<HookResultEvent>;

export const thinkingDeltaEventSchema = z.object({
  type: z.literal("thinking.delta"),
  turnId: z.number(),
  delta: z.string(),
}) satisfies z.ZodType<ThinkingDeltaEvent>;

export const toolCallDeltaEventSchema = z.object({
  type: z.literal("tool.call.delta"),
  turnId: z.number(),
  toolCallId: z.string(),
  name: z.string().optional(),
  argumentsPart: z.string().optional(),
}) satisfies z.ZodType<ToolCallDeltaEvent>;

export const toolCallStartedEventSchema = z.object({
  type: z.literal("tool.call.started"),
  turnId: z.number(),
  toolCallId: z.string(),
  name: z.string(),
  args: z.unknown(),
  description: z.string().optional(),
  display: ToolInputDisplaySchema.optional(),
}) satisfies z.ZodType<ToolCallStartedEvent>;

export const toolProgressEventSchema = z.object({
  type: z.literal("tool.progress"),
  turnId: z.number(),
  toolCallId: z.string(),
  update: toolUpdateSchema,
}) satisfies z.ZodType<ToolProgressEvent>;

export const shellOutputEventSchema = z.object({
  type: z.literal("shell.output"),
  commandId: z.string(),
  update: toolUpdateSchema,
  taskId: z.string().optional(),
}) satisfies z.ZodType<ShellOutputEvent>;

export const shellStartedEventSchema = z.object({
  type: z.literal("shell.started"),
  commandId: z.string(),
  taskId: z.string(),
}) satisfies z.ZodType<ShellStartedEvent>;

export const shellCompletedEventSchema = z.object({
  type: z.literal("shell.completed"),
  commandId: z.string(),
  isError: z.boolean(),
  taskId: z.string().optional(),
}) satisfies z.ZodType<ShellCompletedEvent>;

export const toolResultEventSchema = z.object({
  type: z.literal("tool.result"),
  turnId: z.number(),
  toolCallId: z.string(),
  output: z.unknown(),
  isError: z.boolean().optional(),
  synthetic: z.boolean().optional(),
}) satisfies z.ZodType<ToolResultEvent>;

export const subagentSpawnedEventSchema = z.object({
  type: z.literal("subagent.spawned"),
  subagentId: z.string(),
  subagentName: z.string(),
  parentToolCallId: z.string(),
  parentToolCallUuid: z.string().optional(),
  parentAgentId: z.string().optional(),
  callerAgentId: z.string().optional(),
  description: z.string().optional(),
  swarmIndex: z.number().optional(),
  runInBackground: z.boolean(),
}) satisfies z.ZodType<SubagentSpawnedEvent>;

export const subagentStartedEventSchema = z.object({
  type: z.literal("subagent.started"),
  subagentId: z.string(),
}) satisfies z.ZodType<SubagentStartedEvent>;

export const subagentSuspendedEventSchema = z.object({
  type: z.literal("subagent.suspended"),
  subagentId: z.string(),
  reason: z.string(),
}) satisfies z.ZodType<SubagentSuspendedEvent>;

export const subagentCompletedEventSchema = z.object({
  type: z.literal("subagent.completed"),
  subagentId: z.string(),
  resultSummary: z.string(),
  usage: tokenUsageSchema.optional(),
  contextTokens: z.number().optional(),
}) satisfies z.ZodType<SubagentCompletedEvent>;

export const subagentFailedEventSchema = z.object({
  type: z.literal("subagent.failed"),
  subagentId: z.string(),
  error: z.string(),
}) satisfies z.ZodType<SubagentFailedEvent>;

export const compactionStartedEventSchema = z.object({
  type: z.literal("compaction.started"),
  trigger: z.enum(["manual", "auto"]),
  instruction: z.string().optional(),
}) satisfies z.ZodType<CompactionStartedEvent>;

export const compactionBlockedEventSchema = z.object({
  type: z.literal("compaction.blocked"),
  turnId: z.number().optional(),
}) satisfies z.ZodType<CompactionBlockedEvent>;

export const compactionCancelledEventSchema = z.object({
  type: z.literal("compaction.cancelled"),
}) satisfies z.ZodType<CompactionCancelledEvent>;

export const compactionCompletedEventSchema = z.object({
  type: z.literal("compaction.completed"),
  result: compactionResultSchema,
}) satisfies z.ZodType<CompactionCompletedEvent>;

export const taskStartedEventSchema = z.object({
  type: z.literal("task.started"),
  info: taskInfoSchema,
});

export const taskTerminatedEventSchema = z.object({
  type: z.literal("task.terminated"),
  info: taskInfoSchema,
});

export const backgroundTaskStartedEventSchema = z.object({
  type: z.literal("background.task.started"),
  info: taskInfoSchema,
});

export const backgroundTaskTerminatedEventSchema = z.object({
  type: z.literal("background.task.terminated"),
  info: taskInfoSchema,
});

export const cronFiredEventSchema = z.object({
  type: z.literal("cron.fired"),
  origin: cronJobOriginSchema,
  prompt: z.string(),
});

export const promptSubmittedEventSchema = z.object({
  type: z.literal("prompt.submitted"),
  promptId: z.string(),
  userMessageId: z.string(),
  status: z.enum(["running", "queued", "blocked"]),
  content: z.array(messageContentSchema),
  createdAt: isoDateTimeSchema,
});

export const promptCompletedEventSchema = z.object({
  type: z.literal("prompt.completed"),
  promptId: z.string(),
  finishedAt: isoDateTimeSchema,
  reason: z.enum(["completed", "failed", "blocked"]).optional(),
});

export const promptAbortedEventSchema = z.object({
  type: z.literal("prompt.aborted"),
  promptId: z.string(),
  abortedAt: isoDateTimeSchema,
});

export const promptSteeredEventSchema = z.object({
  type: z.literal("prompt.steered"),
  activePromptId: z.string(),
  promptIds: z.array(z.string()),
  content: z.array(messageContentSchema),
  steeredAt: isoDateTimeSchema,
});

export const toolListUpdatedReasonSchema = z.enum([
  "mcp.connected",
  "mcp.disconnected",
  "mcp.failed",
]) satisfies z.ZodType<ToolListUpdatedReason>;

export const toolListUpdatedEventSchema = z.object({
  type: z.literal("tool.list.updated"),
  reason: toolListUpdatedReasonSchema,
  serverName: z.string(),
}) satisfies z.ZodType<ToolListUpdatedEvent>;

export const mcpServerStatusPayloadSchema = z.object({
  name: z.string(),
  transport: z.enum(["stdio", "http"]),
  status: z.enum(["pending", "connected", "failed", "disabled", "needs-auth"]),
  toolCount: z.number(),
  error: z.string().optional(),
}) satisfies z.ZodType<McpServerStatusPayload>;

export const mcpServerStatusEventSchema = z.object({
  type: z.literal("mcp.server.status"),
  server: mcpServerStatusPayloadSchema,
}) satisfies z.ZodType<McpServerStatusEvent>;

export const agentEventSchema = z.discriminatedUnion("type", [
  errorEventSchema,
  warningEventSchema,
  agentStatusUpdatedEventSchema,
  agentCreatedEventSchema,
  agentDisposedEventSchema,
  sessionMetaUpdatedEventSchema,
  sessionCreatedEventSchema,
  workspaceCreatedEventSchema,
  workspaceUpdatedEventSchema,
  workspaceDeletedEventSchema,
  sessionWorkChangedEventSchema,
  sessionStatusChangedEventSchema,
  goalUpdatedEventSchema,
  skillActivatedEventSchema,
  pluginCommandActivatedEventSchema,
  turnStartedEventSchema,
  turnEndedEventSchema,
  turnStepStartedEventSchema,
  turnStepCompletedEventSchema,
  turnStepRetryingEventSchema,
  turnStepInterruptedEventSchema,
  assistantDeltaEventSchema,
  hookResultEventSchema,
  thinkingDeltaEventSchema,
  toolCallDeltaEventSchema,
  toolCallStartedEventSchema,
  toolProgressEventSchema,
  shellOutputEventSchema,
  shellStartedEventSchema,
  shellCompletedEventSchema,
  toolResultEventSchema,
  toolListUpdatedEventSchema,
  mcpServerStatusEventSchema,
  subagentSpawnedEventSchema,
  subagentStartedEventSchema,
  subagentSuspendedEventSchema,
  subagentCompletedEventSchema,
  subagentFailedEventSchema,
  compactionStartedEventSchema,
  compactionBlockedEventSchema,
  compactionCancelledEventSchema,
  compactionCompletedEventSchema,
  taskStartedEventSchema,
  taskTerminatedEventSchema,
  backgroundTaskStartedEventSchema,
  backgroundTaskTerminatedEventSchema,
  cronFiredEventSchema,
  promptSubmittedEventSchema,
  promptCompletedEventSchema,
  promptAbortedEventSchema,
  promptSteeredEventSchema,
]);

export const eventSchema = agentEventSchema.and(
  z.object({
    agentId: z.string(),
    sessionId: z.string(),
  }),
);

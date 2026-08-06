/**
 * `wire` domain — typed view of the established agent journal records.
 *
 * The native v2 journal is described by `WireRecord` and Op payloads.  The
 * visualizer and other read-only consumers also need the discriminated,
 * flattened record language persisted on the diagnostic wire.  This module is
 * the read-model type boundary: it reuses v2 domain contracts
 * for embedded values while keeping the stable record discriminants in one
 * place.  It contains no runtime code and does not depend on the previous
 * engine implementation.
 */

import type { GoalActor, GoalBudgetLimits, GoalStatus } from "#/agent/goal/types";
import type { LoopRecordedEvent } from "#/agent/contextMemory/loopEventFold";
import type { ContextMessage, PromptOrigin } from "#/agent/contextMemory/types";
import type { CompactionBeginData, CompactionResult } from "#/agent/fullCompaction/types";
import type { PermissionApprovalResultRecord } from "#/agent/permissionRules/permissionRules";
import type { AgentTaskInfoBase } from "#/agent/task/types";
import type { PermissionMode } from "#/agent/permissionPolicy/types";
import type { SwarmModeTrigger } from "#/agent/swarm/swarm";
import type { ContentPart, Message, ToolCall } from "#/kosong/contract/message";
import type { TokenUsage } from "#/kosong/contract/usage";
import type { MCPToolDefinition } from "#/mcpCore/types";
import type { McpToolCollision } from "#/agent/mcp/mcpDiscoveryOps";
import type { ToolInputDisplay } from "#/tool/toolInputDisplay";

export type {
  CompactionBeginData,
  CompactionResult,
  ContextMessage,
  LoopRecordedEvent,
  PermissionApprovalResultRecord,
  PermissionMode,
  PromptOrigin,
  TokenUsage,
};

export type AgentConfigUpdateData = Partial<{
  cwd: string;
  modelAlias: string;
  profileName: string;
  subagentNames: readonly string[];
  thinkingEffort: string;
  thinkingLevel: string;
  systemPrompt: string;
}>;

export type UsageRecordScope = "session" | "turn";

export interface ToolStoreUpdate {
  readonly key: string;
  readonly value: unknown;
}

export interface AgentRecordEvents {
  metadata: {
    protocol_version: string;
    created_at: number;
  };
  forked: Record<string, never>;
  "turn.prompt": { input: readonly ContentPart[]; origin: PromptOrigin };
  "turn.steer": { input: readonly ContentPart[]; origin: PromptOrigin };
  "turn.cancel": { turnId?: number };
  "config.update": AgentConfigUpdateData;
  "profile.bind": {
    modelAlias?: string;
    profileName?: string;
    thinkingEffort?: string;
    thinkingLevel?: string;
    systemPrompt?: string;
    activeToolNames?: readonly string[];
    disallowedTools?: readonly string[];
    subagents?: readonly string[];
  };
  "tools.reset_active_tools": Record<string, never>;
  "permission.set_mode": { mode: PermissionMode };
  "permission.record_approval_result": PermissionApprovalResultRecord;
  "full_compaction.begin": CompactionBeginData;
  "plan_mode.enter": { id: string };
  "plan_mode.cancel": { id?: string };
  "plan_mode.exit": { id?: string };
  "swarm_mode.enter": { trigger: SwarmModeTrigger };
  "swarm_mode.exit": Record<string, never>;
  "tools.register_user_tool": {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
  "tools.unregister_user_tool": { name: string };
  "tools.set_active_tools": {
    names: readonly string[];
    disallowedNames?: readonly string[];
  };
  "usage.record": {
    model: string;
    usage: TokenUsage;
    usageScope?: UsageRecordScope;
  };
  "full_compaction.cancel": Record<string, never>;
  "full_compaction.complete": Record<string, never>;
  "micro_compaction.apply": { cutoff: number };
  "context.append_message": { message: ContextMessage };
  "context.append_loop_event": { event: LoopRecordedEvent };
  "context.update_token_count": { tokenCount: number };
  "context.clear": Record<string, never>;
  "context.apply_compaction": CompactionResult;
  "context.undo": { count: number };
  "tools.update_store": ToolStoreUpdate;
  "goal.create": {
    goalId: string;
    objective: string;
    completionCriterion?: string;
  };
  "goal.update": {
    status?: GoalStatus;
    tokensUsed?: number;
    turnsUsed?: number;
    wallClockMs?: number;
    budgetLimits?: GoalBudgetLimits;
    reason?: string;
    actor?: GoalActor;
  };
  "goal.clear": Record<string, never>;
  "llm.tools_snapshot": {
    hash: string;
    tools: readonly {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    }[];
  };
  "llm.request": {
    kind: "loop" | "compaction";
    provider: string;
    model: string;
    modelAlias?: string;
    thinkingEffort?: string;
    thinkingKeep?: string;
    temperature?: number;
    topP?: number;
    maxTokens?: number;
    betaApi?: boolean;
    toolSelect: boolean;
    systemPromptHash: string;
    systemPrompt?: string;
    toolsHash: string;
    messageCount: number;
    turnStep?: string;
    attempt?: string;
    projection?: "strict" | "media-degraded" | "media-stripped";
    droppedCount?: number;
  };
  "mcp.tools_discovered": {
    serverName: string;
    hash: string;
    tools: readonly MCPToolDefinition[];
    enabledNames: readonly string[];
    collisions?: readonly McpToolCollision[];
  };
}

export type AgentRecord = {
  [K in keyof AgentRecordEvents]: Readonly<AgentRecordEvents[K]> & {
    readonly type: K;
    readonly time?: number;
  };
}[keyof AgentRecordEvents];

export type AgentRecordOf<K extends keyof AgentRecordEvents> = Extract<
  AgentRecord,
  { readonly type: K }
>;

/** Native v2 task information, retained under the historical read-only name. */
export interface ProcessBackgroundTaskInfo extends AgentTaskInfoBase {
  readonly kind: "process";
  readonly command: string;
  readonly pid: number;
  readonly exitCode: number | null;
}
export interface AgentBackgroundTaskInfo extends AgentTaskInfoBase {
  readonly kind: "agent";
  readonly agentId?: string;
  readonly subagentType?: string;
}
export interface QuestionBackgroundTaskInfo extends AgentTaskInfoBase {
  readonly kind: "question";
  readonly questionCount: number;
  readonly toolCallId?: string;
}
export type BackgroundTaskInfo =
  | ProcessBackgroundTaskInfo
  | AgentBackgroundTaskInfo
  | QuestionBackgroundTaskInfo;
export type BackgroundTaskStatus = AgentTaskInfoBase["status"];

// Kept as public aliases for consumers that only need the message contracts.
export type { ContentPart, Message, ToolCall, ToolInputDisplay };

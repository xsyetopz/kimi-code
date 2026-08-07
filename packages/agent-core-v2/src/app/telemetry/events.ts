/**
 * `telemetry` domain — harness event payload types.
 *
 * Typed payloads for `ITelemetryService.track2` call sites. The harness uses a
 * no-op telemetry service; these types keep call-site property shapes stable
 * without a product analytics registry.
 */

import type { TelemetryProperties } from "./telemetry";

export type TelemetryEventName = string;

export type TelemetryEventPayload<
  K extends TelemetryEventName = TelemetryEventName,
> = TelemetryProperties;

export type StrictPropertyCheck<T, E> = E extends TelemetryProperties
  ? E
  : never;

export interface TurnStartedEvent {
  turn_id: number;
  mode: "agent" | "plan";
  provider_type?: string;
  protocol?: string;
  thinking_effort?: string;
}

export interface TurnInterruptedEvent {
  turn_id: number;
  at_step: number;
  mode: "agent" | "plan";
  interrupt_reason:
    | "user_cancelled"
    | "aborted"
    | "max_steps"
    | "error"
    | "filtered"
    | "blocked";
  provider_type?: string;
  protocol?: string;
  thinking_effort?: string;
  trace_id?: string;
}

export interface TurnEndedEvent {
  turn_id: number;
  reason: "completed" | "cancelled" | "failed";
  duration_ms: number;
  mode: "agent" | "plan";
  provider_type?: string;
  protocol?: string;
  thinking_effort?: string;
  trace_id?: string;
}

export type ToolCallOutcome = "success" | "error" | "cancelled";

export interface ToolCallEvent {
  turn_id: number;
  tool_call_id: string;
  tool_name: string;
  outcome: ToolCallOutcome;
  duration_ms: number;
  dup_type: "normal" | "same_step" | "cross_step";
  error_type?: "cancelled" | "error";
  trace_id?: string;
}

export interface ApiErrorEvent {
  error_type: string;
  model: string;
  alias?: string;
  retryable: boolean;
  duration_ms: number;
  status_code?: number;
  provider_type?: string;
  protocol?: string;
  input_tokens?: number;
  turn_id?: number;
  request_kind?: string;
  step_no?: number;
  trace_id?: string;
}

export interface PlanSubmittedEvent {
  has_options: boolean;
}

export interface PlanResolvedEvent {
  outcome:
    | "approved"
    | "dismissed"
    | "rejected_and_exited"
    | "revise"
    | "rejected"
    | "auto_approved";
  chosen_option?: string;
  has_feedback?: boolean;
}

export interface CompactionFinishedEvent {
  turn_id?: number;
  source: "manual" | "auto";
  tokens_before: number;
  tokens_after: number;
  duration_ms: number;
  compacted_count: number;
  dropped_count?: number;
  retry_count: number;
  round: number;
  thinking_effort: string;
  input_tokens?: number;
  output_tokens?: number;
  input_cache_read?: number;
  input_cache_creation?: number;
  trace_id?: string;
}

export interface CompactionFailedEvent {
  turn_id?: number;
  source: "manual" | "auto";
  tokens_before: number;
  duration_ms: number;
  round: number;
  retry_count: number;
  thinking_effort: string;
  error_type: string;
  trace_id?: string;
}

export interface QuestionDismissedEvent {
  trace_id?: string;
}

export interface QuestionAnsweredEvent {
  answered: number;
  method?: "enter" | "space" | "number_key";
  trace_id?: string;
}

export interface GoalBudgetProperties {
  has_token_budget: boolean;
  has_turn_budget: boolean;
  has_wall_clock_budget: boolean;
}

export interface ToolCallDedupDetectedEvent {
  turn_id?: number;
  step_no: number;
  tool_call_id: string;
  tool_name: string;
  dup_type: "same_step" | "cross_step";
  args_hash: string;
  trace_id?: string;
}

export interface ToolCallRepeatEvent {
  turn_id?: number;
  tool_name: string;
  repeat_count: number;
  action: "none" | "r1" | "r2" | "r3" | "stop";
  trace_id?: string;
}

export interface AgentsMdReminderShownEvent {
  turn_id: number;
  tool_name: string;
  reminded_count: number;
  trace_id?: string;
}

export interface CronScheduledEvent {
  recurring: boolean;
  agent_id?: string;
}

export interface CronDeletedEvent {
  task_id: string;
  agent_id?: string;
}

export interface VideoUploadEvent {
  model?: string;
  provider_type?: string;
  protocol?: string;
  mime_type: string;
  size_bytes: number;
  outcome: "success" | "error";
  duration_ms: number;
  error_type?: string;
}

import {
  AgentSwarmProgressEstimator,
  type AgentSwarmProgressEstimatorPhase,
} from "#/tui/components/messages/agent-swarm-progress-estimator";
import type { ColorPalette } from "#/tui/theme/colors";
import type {
  AgentSwarmMemberViewState,
  AgentSwarmPoolViewState,
  AgentSwarmProgressViewState,
} from "#/tui/types";

import {
  agentSwarmDescriptionFromArgs,
  agentSwarmItemsFromArgs,
  agentSwarmPartialItemsFromArguments,
  agentSwarmPartialPromptTemplateFromArguments,
  agentSwarmPartialResumeItemsFromArguments,
  agentSwarmPromptTemplateFromArgs,
  agentSwarmResumeItemsFromArgs,
  agentSwarmWorkItemsStartedFromArguments,
  collapseWhitespace,
  latestNonEmptyLine,
  normalizeFailureText,
  normalizeFinalOutputText,
  parseAgentSwarmResultStatuses,
} from "#/tui/components/messages/agent-swarm-progress-parse";

export const MAX_LATEST_MODEL_CHARS = 2_000;
export const COMPLETE_FILL_MS = 360;
export const CANCELLED_LABEL = "Cancelled.";
export const ABORTED_LABEL = "Aborted.";
export const CANCELLED_LABEL_DARKEN_FACTOR = 0.72;

export type AgentSwarmPhase = AgentSwarmProgressEstimatorPhase;

export type ClearableMemberKey =
  | "completedAtMs"
  | "completedText"
  | "failedAtMs"
  | "failureText"
  | "cancelledLabelText"
  | "cancelledLabelColor"
  | "cancelledMarkColor"
  | "cancelledBarColor"
  | "suspendedReason";

export const COMPLETED_CLEAR_KEYS = [
  "failedAtMs",
  "failureText",
  "cancelledLabelText",
  "cancelledLabelColor",
  "cancelledMarkColor",
  "cancelledBarColor",
  "suspendedReason",
] as const satisfies readonly ClearableMemberKey[];
export const FAILED_CLEAR_KEYS = [
  "completedAtMs",
  "completedText",
  "cancelledLabelText",
  "cancelledLabelColor",
  "cancelledMarkColor",
  "cancelledBarColor",
  "suspendedReason",
] as const satisfies readonly ClearableMemberKey[];
export const TERMINAL_CLEAR_KEYS = [
  "completedAtMs",
  "completedText",
  "failedAtMs",
  "failureText",
  "cancelledLabelText",
  "cancelledLabelColor",
  "cancelledMarkColor",
  "cancelledBarColor",
  "suspendedReason",
] as const satisfies readonly ClearableMemberKey[];
export const CANCELLED_CLEAR_KEYS = [
  "completedAtMs",
  "completedText",
  "failedAtMs",
  "failureText",
  "suspendedReason",
] as const satisfies readonly ClearableMemberKey[];

export interface AgentSwarmMember {
  readonly id: string;
  agentId?: string;
  phase: AgentSwarmPhase;
  ticks: number;
  itemText: string;
  latestModelText: string;
  completedText?: string;
  failureText?: string;
  cancelledLabelText?: string;
  cancelledLabelColor?: string;
  cancelledMarkColor?: string;
  cancelledBarColor?: string;
  suspendedReason?: string;
  completedAtMs?: number;
  failedAtMs?: number;
}

export interface AgentSwarmSnapshot {
  readonly phase: AgentSwarmPhase;
  readonly ticks: number;
  readonly latestModelText: string;
  readonly phaseElapsedMs: number;
}

export const PHASE_LABELS: Record<AgentSwarmPhase, string> = {
  pending: "Queued...",
  queued: "Queued...",
  suspended: "Rate limited...",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: ABORTED_LABEL,
};

export function createMembers(
  count: number,
  phase: AgentSwarmPhase,
): AgentSwarmMember[] {
  return Array.from({ length: count }, (_item, index) => ({
    id: String(index + 1).padStart(3, "0"),
    phase,
    ticks: 0,
    itemText: "",
    latestModelText: "",
  }));
}

export function clearMemberState(
  member: AgentSwarmMember,
  ...keys: ClearableMemberKey[]
): void {
  for (const key of keys) delete member[key];
}

export function isTerminalPhase(phase: AgentSwarmPhase): boolean {
  return phase === "completed" || phase === "failed" || phase === "cancelled";
}

export function terminalPhaseElapsedMs(
  member: AgentSwarmMember,
  nowMs: number,
): number {
  const startedAtMs =
    member.phase === "completed"
      ? member.completedAtMs
      : member.phase === "failed"
        ? member.failedAtMs
        : undefined;
  return startedAtMs === undefined ? 0 : Math.max(0, nowMs - startedAtMs);
}

export function runningCellLabelText(member: AgentSwarmMember): string {
  const latestLine = latestNonEmptyLine(member.latestModelText);
  const itemText = collapseWhitespace(member.itemText);
  const text = latestLine.length > 0 ? latestLine : itemText;
  return text.length > 0 ? text : PHASE_LABELS.running;
}

export function cancelledLabelColor(colors: ColorPalette): string {
  return darkenHexColor(colors.warning, CANCELLED_LABEL_DARKEN_FACTOR);
}

function darkenHexColor(
  hex: string,
  redFactor: number,
  greenFactor = redFactor,
  blueFactor = redFactor,
): string {
  const match = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  if (match === null) return hex;
  const darken = (channel: string, factor: number): string =>
    Math.max(
      0,
      Math.min(255, Math.round(Number.parseInt(channel, 16) * factor)),
    )
      .toString(16)
      .padStart(2, "0");
  return `#${darken(match[1]!, redFactor)}${darken(match[2]!, greenFactor)}${darken(
    match[3]!,
    blueFactor,
  )}`;
}

export interface AgentSwarmProgressCoreState {
  members: AgentSwarmMember[];
  progressEstimator: AgentSwarmProgressEstimator;
  description: string;
  modelDisplay: string;
  inputComplete: boolean;
  failed: boolean;
  aborted: boolean;
  itemsStarted: boolean;
  toolCallActive: boolean;
  promptTemplateText: string;
  swarmFailureText: string | undefined;
  poolStatus: AgentSwarmPoolViewState | undefined;
}

export function createAgentSwarmProgressCoreState(
  description: string,
): AgentSwarmProgressCoreState {
  return {
    members: [],
    progressEstimator: new AgentSwarmProgressEstimator(),
    description,
    modelDisplay: "",
    inputComplete: false,
    failed: false,
    aborted: false,
    itemsStarted: false,
    toolCallActive: true,
    promptTemplateText: "",
    swarmFailureText: undefined,
    poolStatus: undefined,
  };
}

export function rebuildProgressEstimatorFromMembers(
  state: AgentSwarmProgressCoreState,
  nowMs = Date.now(),
): void {
  state.progressEstimator = new AgentSwarmProgressEstimator();
  for (const member of state.members) {
    switch (member.phase) {
      case "pending":
        break;
      case "queued":
      case "suspended":
        state.progressEstimator.markQueued(member.id, nowMs);
        break;
      case "running": {
        state.progressEstimator.markStarted(member.id, nowMs);
        for (let tick = 1; tick < member.ticks; tick += 1) {
          state.progressEstimator.recordToolCall({
            memberKey: member.id,
            toolCallId: `hydrate:${member.id}:${String(tick)}`,
            nowMs,
          });
        }
        break;
      }
      case "completed":
        state.progressEstimator.markStarted(member.id, nowMs - 1_000);
        state.progressEstimator.markCompleted(member.id, nowMs);
        break;
      case "failed":
        state.progressEstimator.markStarted(member.id, nowMs - 1_000);
        state.progressEstimator.markFailed(member.id, nowMs);
        break;
      case "cancelled":
        state.progressEstimator.markCancelled(member.id, nowMs);
        break;
    }
  }
}

export function captureAgentSwarmProgressState(
  state: AgentSwarmProgressCoreState,
  activitySpinnerText = "",
): AgentSwarmProgressViewState {
  const members: AgentSwarmMemberViewState[] = state.members.map((member) => ({
    id: member.id,
    agentId: member.agentId,
    phase: member.phase,
    ticks: member.ticks,
    itemText: member.itemText,
    latestModelText: member.latestModelText,
    completedText: member.completedText,
    failureText: member.failureText,
    cancelledLabelText: member.cancelledLabelText,
    suspendedReason: member.suspendedReason,
  }));
  return {
    description: state.description,
    modelDisplay: state.modelDisplay,
    promptTemplateText: state.promptTemplateText,
    inputComplete: state.inputComplete,
    failed: state.failed,
    aborted: state.aborted,
    itemsStarted: state.itemsStarted,
    toolCallActive: state.toolCallActive,
    activitySpinnerText,
    swarmFailureText: state.swarmFailureText,
    poolStatus: state.poolStatus,
    members,
  };
}

export function applyAgentSwarmProgressViewState(
  state: AgentSwarmProgressCoreState,
  viewState: AgentSwarmProgressViewState,
  colors: ColorPalette,
): void {
  state.description = viewState.description;
  state.modelDisplay = viewState.modelDisplay;
  state.promptTemplateText = viewState.promptTemplateText;
  state.inputComplete = viewState.inputComplete;
  state.failed = viewState.failed;
  state.aborted = viewState.aborted;
  state.itemsStarted = viewState.itemsStarted;
  state.toolCallActive = viewState.toolCallActive;
  state.swarmFailureText = viewState.swarmFailureText;
  state.poolStatus = viewState.poolStatus;
  state.members = viewState.members.map((member) => ({
    id: member.id,
    agentId: member.agentId,
    phase: member.phase,
    ticks: member.ticks,
    itemText: member.itemText,
    latestModelText: member.latestModelText,
    completedText: member.completedText,
    failureText: member.failureText,
    cancelledLabelText: member.cancelledLabelText,
    suspendedReason: member.suspendedReason,
  }));
  for (const member of state.members) {
    if (member.phase !== "cancelled") continue;
    member.cancelledLabelColor =
      member.cancelledLabelColor ?? cancelledLabelColor(colors);
    member.cancelledMarkColor = member.cancelledMarkColor ?? colors.warning;
    member.cancelledBarColor = member.cancelledBarColor ?? colors.warning;
  }
  rebuildProgressEstimatorFromMembers(state);
}

export function updateAgentSwarmArgs(
  state: AgentSwarmProgressCoreState,
  args: Record<string, unknown>,
  streamingArguments: string | undefined,
): void {
  const description = agentSwarmDescriptionFromArgs(args);
  if (description.length > 0 || state.description.length === 0) {
    state.description = description;
  }
  const fullRows = [
    ...agentSwarmResumeItemsFromArgs(args),
    ...agentSwarmItemsFromArgs(args),
  ];
  const partialRows =
    streamingArguments === undefined
      ? []
      : [
          ...agentSwarmPartialResumeItemsFromArguments(streamingArguments),
          ...agentSwarmPartialItemsFromArguments(streamingArguments),
        ];
  if (
    fullRows.length > 0 ||
    partialRows.length > 0 ||
    (streamingArguments !== undefined &&
      agentSwarmWorkItemsStartedFromArguments(streamingArguments))
  ) {
    state.itemsStarted = true;
  }
  const fullPromptTemplate = agentSwarmPromptTemplateFromArgs(args);
  const partialPromptTemplate =
    streamingArguments === undefined
      ? ""
      : agentSwarmPartialPromptTemplateFromArguments(streamingArguments);
  const promptTemplate =
    fullPromptTemplate.length > 0
      ? fullPromptTemplate
      : partialPromptTemplate;
  if (promptTemplate.length > 0 || state.promptTemplateText.length === 0) {
    state.promptTemplateText = promptTemplate;
  }

  const itemCount = Math.max(fullRows.length, partialRows.length);
  if (itemCount > 0) ensureMemberCount(state, itemCount);
  updateItemTexts(state, fullRows, partialRows);
}

export function findMemberByAgentId(
  state: AgentSwarmProgressCoreState,
  agentId: string,
): AgentSwarmMember | undefined {
  return state.members.find((member) => member.agentId === agentId);
}

export function findMemberForSubagent(
  state: AgentSwarmProgressCoreState,
  agentId: string,
  swarmIndex: number | undefined,
): AgentSwarmMember | undefined {
  const existing = findMemberByAgentId(state, agentId);
  if (existing !== undefined) return existing;

  if (
    swarmIndex !== undefined &&
    Number.isInteger(swarmIndex) &&
    swarmIndex > 0
  ) {
    ensureMemberCount(state, swarmIndex);
    const byIndex = state.members[swarmIndex - 1];
    if (byIndex !== undefined) return byIndex;
  }

  const unassigned = state.members.find(
    (member) => member.agentId === undefined,
  );
  if (unassigned !== undefined) return unassigned;

  ensureMemberCount(state, state.members.length + 1);
  return state.members.at(-1);
}

export function ensureMemberCount(
  state: AgentSwarmProgressCoreState,
  count: number,
): void {
  if (count <= state.members.length) return;
  const previousLength = state.members.length;
  state.members = [
    ...state.members,
    ...createMembers(
      count,
      state.inputComplete ? "queued" : "pending",
    ).slice(state.members.length),
  ];
  const nowMs = Date.now();
  for (let index = previousLength; index < state.members.length; index += 1) {
    const member = state.members[index];
    if (member !== undefined)
      state.progressEstimator.ensureMember(member.id, nowMs);
  }
}

export function updateItemTexts(
  state: AgentSwarmProgressCoreState,
  fullItems: readonly string[],
  partialItems: readonly string[],
): void {
  const count = Math.max(
    fullItems.length,
    partialItems.length,
    state.members.length,
  );
  for (let index = 0; index < count; index += 1) {
    const member = state.members[index];
    if (member === undefined) continue;
    const itemText = fullItems[index] ?? partialItems[index];
    if (itemText !== undefined) member.itemText = itemText;
  }
}

export function hasSubagentExecutionStarted(
  state: AgentSwarmProgressCoreState,
): boolean {
  return state.members.some(
    (member) =>
      member.agentId !== undefined ||
      member.phase === "running" ||
      member.phase === "completed",
  );
}

export function hasAnimatedMembers(
  state: AgentSwarmProgressCoreState,
): boolean {
  const now = Date.now();
  return (
    state.progressEstimator.hasPendingCatchup() ||
    state.members.some(
      (member) =>
        (member.phase === "completed" &&
          member.completedAtMs !== undefined &&
          now - member.completedAtMs < COMPLETE_FILL_MS) ||
        (member.phase === "failed" &&
          member.failedAtMs !== undefined &&
          now - member.failedAtMs < COMPLETE_FILL_MS),
    )
  );
}

export function promoteToRunning(
  state: AgentSwarmProgressCoreState,
  member: AgentSwarmMember,
  nowMs?: number,
  setTicks = false,
): void {
  if (
    member.phase === "pending" ||
    member.phase === "queued" ||
    member.phase === "suspended"
  ) {
    member.phase = "running";
    if (nowMs !== undefined)
      state.progressEstimator.markStarted(member.id, nowMs);
    if (setTicks) member.ticks = Math.max(member.ticks, 1);
  }
  delete member.suspendedReason;
}

export function completeMember(
  state: AgentSwarmProgressCoreState,
  member: AgentSwarmMember,
  nowMs: number,
  completedText?: string,
): void {
  if (member.phase !== "completed") {
    state.progressEstimator.markCompleted(member.id, nowMs);
    member.completedAtMs = nowMs;
  }
  const normalizedCompletedText = normalizeFinalOutputText(completedText);
  if (normalizedCompletedText !== undefined)
    member.completedText = normalizedCompletedText;
  member.phase = "completed";
  clearMemberState(member, ...COMPLETED_CLEAR_KEYS);
}

export function failMember(
  state: AgentSwarmProgressCoreState,
  member: AgentSwarmMember,
  nowMs: number,
  failureText?: string,
): void {
  if (member.phase !== "failed") {
    state.progressEstimator.markFailed(member.id, nowMs);
    member.failedAtMs = nowMs;
  }
  const normalizedFailureText = normalizeFailureText(failureText);
  if (normalizedFailureText !== undefined)
    member.failureText = normalizedFailureText;
  member.phase = "failed";
  clearMemberState(member, ...FAILED_CLEAR_KEYS);
}

export function cancelMember(
  state: AgentSwarmProgressCoreState,
  member: AgentSwarmMember,
  nowMs: number,
  colors: ColorPalette,
): void {
  const previousPhase = member.phase;
  state.progressEstimator.markCancelled(member.id, nowMs);
  member.phase = "cancelled";
  clearMemberState(member, ...CANCELLED_CLEAR_KEYS);
  if (
    previousPhase === "pending" ||
    previousPhase === "queued" ||
    previousPhase === "suspended"
  ) {
    member.cancelledLabelText = CANCELLED_LABEL;
    member.cancelledLabelColor = cancelledLabelColor(colors);
    member.cancelledMarkColor = colors.warning;
    member.cancelledBarColor = colors.warning;
  } else if (previousPhase === "running") {
    member.cancelledLabelText = runningCellLabelText(member);
    member.cancelledLabelColor = cancelledLabelColor(colors);
    member.cancelledMarkColor = colors.warning;
    member.cancelledBarColor = colors.warning;
  } else {
    member.cancelledLabelText = ABORTED_LABEL;
    member.cancelledLabelColor = colors.warning;
    member.cancelledMarkColor = colors.warning;
    member.cancelledBarColor = colors.warning;
  }
}

export function applyAgentSwarmResult(
  state: AgentSwarmProgressCoreState,
  output: string,
  colors: ColorPalette,
): boolean {
  const statuses = parseAgentSwarmResultStatuses(output);
  if (statuses.length === 0) return false;
  state.aborted = false;
  const nowMs = Date.now();
  for (const entry of statuses) {
    ensureMemberCount(state, entry.index);
    const member = state.members[entry.index - 1];
    if (member === undefined) continue;
    if (entry.status === "completed") {
      completeMember(state, member, nowMs, entry.completedText);
    } else if (entry.status === "failed") {
      failMember(state, member, nowMs, entry.failureText);
    } else {
      cancelMember(state, member, nowMs, colors);
    }
  }
  return true;
}

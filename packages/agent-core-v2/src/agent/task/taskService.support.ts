/**
 * `task` domain — task registry types, state keys, and notification helpers.
 */

import { randomBytes } from "node:crypto";
import { defineState } from "#/_base/state/stateRegistry";
import { escapeXml, escapeXmlAttr } from "#/_base/utils/xml-escape";
import { userCancellationReason } from "#/_base/utils/abort";
import { defineCheckpointedModel } from "#/agent/contextMemory/conversationTime";
import type { ContentPart, TaskOrigin } from "#/agent/contextMemory/types";
import { MessageStepRequest } from "#/agent/loop/stepRequest";
import type {
  AgentTaskInfo,
  AgentTaskOutputSnapshot,
  AgentTaskStatus,
  ForegroundTaskReleaseReason,
} from "./task";
import { TERMINAL_STATUSES } from "./types";
import type { AgentTaskSettlement } from "./types";

interface ForegroundRelease {
  readonly promise: Promise<ForegroundTaskReleaseReason>;
  resolve(reason: ForegroundTaskReleaseReason): void;
}

type AgentTaskNotification = Record<string, unknown> & {
  readonly id: string;
  readonly category: "task";
  readonly type: string;
  readonly source_kind: "background_task";
  readonly source_id: string;
  readonly agent_id?: string | undefined;
  readonly title: string;
  readonly severity: "info" | "warning";
  readonly body: string;
  readonly children?: readonly string[] | undefined;
};

interface AgentTaskNotificationBuildContext {
  readonly content: readonly ContentPart[];
  readonly origin: TaskOrigin;
  readonly notification: AgentTaskNotification;
}

export const TaskNotificationDeliveryModel = defineCheckpointedModel(
  "task.notificationDelivery",
  (): readonly string[] => [],
  {
    onAppendMessage: (current, message) => {
      const origin = taskOriginFromMessage(message);
      if (origin === undefined) return current;
      const key = notificationKey(origin);
      return current.includes(key) ? current : [...current, key];
    },
  },
);

interface ManagedTask {
  readonly taskId: string;
  readonly task: AgentTask | undefined;
  readonly handle: ITaskHandle | undefined;
  readonly toInfoFn?: (base: AgentTaskInfoBase) => AgentTaskInfo;
  readonly forceStopFn?: () => Promise<void>;
  readonly onDetachFn?: () => void;
  readonly outputChunks: string[];
  outputSizeBytes: number;
  retainedOutputBytes: number;
  outputLimitTripped: boolean;
  status: AgentTaskStatus;
  options: RegisterAgentTaskOptions & { description?: string };
  readonly startedAt: number;
  endedAt: number | null;
  foregroundRelease?: ForegroundRelease;
  stopReason?: string;
  terminalNotificationSuppressed?: boolean;
  terminalFired: boolean;
  readonly abortController: AbortController;
  foregroundSignalCleanup?: () => void;
  lifecyclePromise: Promise<void>;
  persistWriteQueue: Promise<void>;
  outputWriteQueue: Promise<void>;
  pendingOutput: string[];
  pendingOutputBytes: number;
  outputPersistStarted: boolean;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  timedOut: boolean;
  readonly waiters: Array<() => void>;
  handleSubscription?: { dispose(): void };
}

const MAX_OUTPUT_BYTES = 1024 * 1024;

const TERMINAL_OUTPUT_TAIL_BYTES = 4 * 1024;

const MAX_TASK_OUTPUT_BYTES = 16 * 1024 * 1024;

function outputLimitReason(): string {
  const mib = Math.floor(MAX_TASK_OUTPUT_BYTES / (1024 * 1024));
  return (
    `Output limit exceeded: the command produced more than ${mib} MiB and was ` +
    "terminated. Redirect large output to a file (e.g. `command > out.txt`) and " +
    "inspect it in slices instead."
  );
}

export const SIGTERM_GRACE_MS = 5_000;
export const SESSION_CLOSED_REASON = "Session closed";
export const NOTIFICATION_FALLBACK_PREVIEW_BYTES = 3_000;
export const ACTIVE_BACKGROUND_TASK_INJECTION_VARIANT =
  "background_task_status";
export const ACTIVE_BACKGROUND_TASK_GUIDANCE = [
  "The conversation was compacted, so the earlier messages that started these background tasks are gone — but the tasks are still running from before.",
  "Do not start duplicates. Use TaskList to list them, TaskOutput for a non-blocking status/output snapshot, and TaskStop to cancel one — completion arrives via automatic notification.",
].join(" ");

const TASK_ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export function isAgentTaskTerminal(status: AgentTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function coerceTimeoutSettlement(
  entry: ManagedTask,
  settlement: AgentTaskSettlement,
): AgentTaskSettlement {
  if (entry.timedOut && settlement.status === "killed") {
    return { ...settlement, status: "timed_out" };
  }
  return settlement;
}

declare module "#/app/event/eventBus" {
  interface DomainEventMap {
    "task.notified": AgentTaskNotificationContext;
  }
}

export class TaskNotificationStepRequest extends MessageStepRequest {
  constructor(
    message: ContextMessage,
    private readonly onWillDeliver?: () => void,
  ) {
    super(message, {
      kind: "task_notification",
      mergeable: true,
      turnScoped: false,
      admission: "activeOrNewTurn",
    });
  }

  override onWillMaterialize(): void {
    this.onWillDeliver?.();
  }
}

export const taskGhostsKey = defineState<Map<string, AgentTaskInfo>>(
  "task.ghosts",
  () => new Map(),
);
export const taskScheduledNotificationKeysKey = defineState<Set<string>>(
  "task.scheduledNotificationKeys",
  () => new Set(),
);
export const taskDeliveredNotificationKeysKey = defineState<Set<string>>(
  "task.deliveredNotificationKeys",
  () => new Set(),
);
export const taskActiveTaskReminderPendingKey = defineState<boolean>(
  "task.activeTaskReminderPending",
  () => false,
);

export function emptyOutputSnapshot(): AgentTaskOutputSnapshot {
  return {
    outputSizeBytes: 0,
    previewBytes: 0,
    truncated: false,
    fullOutputAvailable: false,
    preview: "",
  };
}

export function agentTaskNotificationChildren(
  output: AgentTaskOutputSnapshot,
): readonly string[] | undefined {
  if (output.fullOutputAvailable && output.outputPath !== undefined) {
    return [renderOutputFileBlock(output.outputPath, output.outputSizeBytes)];
  }
  if (output.preview.length === 0) return undefined;
  return [renderOutputPreviewBlock(output)];
}

function renderOutputFileBlock(
  outputPath: string,
  outputSizeBytes: number,
): string {
  return [
    `<output-file path="${escapeXmlAttr(outputPath)}" bytes="${String(outputSizeBytes)}">`,
    `Read the output file to retrieve the result: ${escapeXml(outputPath)}`,
    "</output-file>",
  ].join("\n");
}

function renderOutputPreviewBlock(output: AgentTaskOutputSnapshot): string {
  return [
    `<output-preview bytes="${String(output.previewBytes)}" total_bytes="${String(output.outputSizeBytes)}" truncated="${String(output.truncated)}">`,
    output.truncated
      ? `Showing the last ${String(output.previewBytes)} bytes. No persisted full output is available.`
      : "No persisted full output is available; this preview is the currently buffered task output.",
    escapeXml(output.preview),
    "</output-preview>",
  ].join("\n");
}

export function shouldListTask(
  info: AgentTaskInfo,
  activeOnly: boolean,
): boolean {
  if (!TERMINAL_STATUSES.has(info.status)) return true;
  if (activeOnly) return false;
  return info.detached !== false;
}

export function isCompactionSplice(splice: {
  readonly deleteCount: number;
  readonly messages: readonly {
    readonly origin?: { readonly kind: string } | undefined;
  }[];
}): boolean {
  return (
    splice.deleteCount > 0 &&
    splice.messages.some(
      (message) => message.origin?.kind === "compaction_summary",
    )
  );
}

export function newerRestoredTask(
  existing: AgentTaskInfo,
  loaded: AgentTaskInfo,
): AgentTaskInfo {
  const existingTerminal = isAgentTaskTerminal(existing.status);
  const loadedTerminal = isAgentTaskTerminal(loaded.status);
  if (existingTerminal && !loadedTerminal) return existing;
  if (!existingTerminal && loadedTerminal) return loaded;
  if (existing.endedAt !== null && loaded.endedAt !== null) {
    return loaded.endedAt >= existing.endedAt ? loaded : existing;
  }
  if (existing.endedAt !== null) return existing;
  if (loaded.endedAt !== null) return loaded;
  return loaded;
}

type TaskNotificationOrigin = Pick<
  TaskOrigin,
  "taskId" | "status" | "notificationId"
>;

export function isTaskOrigin(
  origin: unknown,
): origin is TaskNotificationOrigin {
  if (typeof origin !== "object" || origin === null) return false;
  const value = origin as Record<string, unknown>;
  return (
    (value["kind"] === "background_task" || value["kind"] === "task") &&
    typeof value["taskId"] === "string" &&
    typeof value["status"] === "string" &&
    typeof value["notificationId"] === "string"
  );
}

export function notificationKey(origin: TaskNotificationOrigin): string {
  return `${origin.taskId}\0${origin.status}\0${origin.notificationId}`;
}

export function taskOriginFromMessage(
  message: unknown,
): TaskNotificationOrigin | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const origin = (message as { readonly origin?: unknown }).origin;
  return isTaskOrigin(origin) ? origin : undefined;
}

export function buildAgentTaskNotificationBody(info: AgentTaskInfo): string {
  const baseLine =
    info.status === "timed_out"
      ? `${info.description} timed out.`
      : info.status === "killed" &&
          isSerializedUserCancellation(info.stopReason)
        ? `${info.description} was stopped by user.`
        : info.stopReason
          ? `${info.description} ${info.status === "killed" ? "was stopped" : info.status}. Reason: ${info.stopReason}`
          : `${info.description} ${info.status}.`;

  if (info.kind !== "agent") return baseLine;
  if (info.status === "completed") return baseLine;
  const agentId = info.agentId;
  if (agentId === undefined || agentId === info.taskId) return baseLine;

  const recovery = [
    "",
    `To recover or continue this subagent, call Agent(resume="${agentId}", prompt="Pick up where you left off; redo the last tool call if its result was never observed.").`,
    `Use agent_id ("${agentId}"), NOT source_id / task_id ("${info.taskId}") — the two look alike but only agent_id is accepted by the resume parameter.`,
    "Add run_in_background=true to keep it backgrounded, or omit it to take the result inline in the current turn.",
    "The subagent retains its full prior context across the restart, but any in-flight tool call lost its result and may need to be redone.",
  ].join("\n");

  return `${baseLine}${recovery}`;
}

export function generateTaskId(kind: string): string {
  const bytes = randomBytes(8);
  let suffix = "";
  for (let index = 0; index < 8; index++) {
    suffix += TASK_ID_ALPHABET[bytes[index]! % TASK_ID_ALPHABET.length];
  }
  return `${kind}-${suffix}`;
}

export function normalizeReason(
  reason: string | undefined,
): string | undefined {
  const trimmed = reason?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function isSerializedUserCancellation(reason: string | undefined): boolean {
  return reason === userCancellationReason().message;
}

export function createForegroundRelease(): ForegroundRelease {
  let resolve!: (reason: ForegroundTaskReleaseReason) => void;
  const promise = new Promise<ForegroundTaskReleaseReason>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

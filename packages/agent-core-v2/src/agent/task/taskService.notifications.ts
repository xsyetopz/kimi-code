/**
 * `task` domain — `AgentTaskService` implementation.
 *
 * Owns the agent's registry of running and restored tasks:
 * registers and drives tasks to completion, retains a bounded output ring,
 * persists task state and output through task persistence rooted at the
 * agent's own scope (v1's per-agent `<sessionDir>/agents/<id>/tasks/`
 * layout), lets only the main agent read through the previous v2
 * session-level task root without writing back to it, reads
 * limits through `config`, records lifecycle and broadcasts through `wire`
 * (persisted `task.started` / `task.terminated` Ops into `TaskModel`, the
 * terminated record carrying a bounded tail of the task's retained output as
 * `outputTail`, plus the matching signals), restores ghosts through a single
 * `wire.hooks.onDidRestore` hook
 * (wire replay -> disk load -> reconcile, in that order), delivers live
 * terminal notifications by enqueueing `TaskNotificationStepRequest`s onto
 * `loop` with `activeOrNewTurn` admission (mid-turn ones fold into the active turn's
 * following step; idle ones launch a fresh turn themselves, matching v1's
 * `turn.steer`, so the model consumes the notification without waiting for
 * the user), silently appends restored notifications through `contextMemory`,
 * re-surfaces active tasks through `contextInjector` after compaction, and
 * requests every owned task to stop on session close (`stopAllOnExit` — v1's
 * `stopBackgroundTasksOnExit`) with configurable SIGTERM grace and SIGKILL
 * escalation. `keepAliveOnExit` skips task-manager teardown so independently
 * living external work such as processes can continue; Session-scoped agents
 * remain governed by the Session lifecycle. Scope disposal paths that bypass
 * graceful close synchronously cancel/abort work and immediately attempt a
 * best-effort force-stop to reduce the risk of surviving child processes.
 * The plain-data task state (`ghosts`, `scheduledNotificationKeys`,
 * `deliveredNotificationKeys`, `activeTaskReminderPending`) is registered
 * into `agentState` (`IAgentStateService`) and read/written through it; the
 * live `tasks` registry stays a plain field because a `ManagedTask` holds
 * resources (promise chains, an `AbortController`, task handles) that must
 * not be snapshotted, as do the `persistence` construction-time helper and
 * the notification delivery machinery (`buildingNotificationKeys`,
 * `pendingNotificationRequests`, `notificationRestoreQueue`).
 * Notification delivery follows conversation undo through the checkpoint and
 * reconciliation contracts. Bound at Agent scope.
 */

import { randomBytes } from 'node:crypto';
import { join } from 'pathe';

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';

import type { ContentPart } from '#/kosong/contract/message';

import { Disposable } from '#/_base/di/lifecycle';
import { ILogService } from '#/_base/log/log';
import { defineState } from '#/_base/state/stateRegistry';
import {
  abortable,
  userCancellationReason,
} from '#/_base/utils/abort';
import { escapeXml, escapeXmlAttr } from '#/_base/utils/xml-escape';
import { IEventBus } from '#/app/event/eventBus';
import { Error2, ErrorCodes } from '#/errors';
import { defineCheckpointedModel } from '#/agent/contextMemory/conversationTime';
import { IAgentConversationUndoParticipantRegistry } from '#/agent/contextMemory/conversationUndoParticipants';
import type { ContextMessage, TaskOrigin } from '#/agent/contextMemory/types';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentLoopService } from '#/agent/loop/loop';
import { MessageStepRequest } from '#/agent/loop/stepRequest';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { ITaskService, type ITaskHandle, TERMINAL_TASK_STATES } from '#/app/task/task';
import {
  TERMINAL_STATUSES,
  type AgentTaskInfoBase,
  type AgentTaskSettlement,
} from './types';
import { renderNotificationXml } from './notificationXml';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IConfigService } from '#/app/config/config';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IWireService } from '#/wire/wire';
import {
  IAgentTaskService,
  type AgentTaskNotificationContext,
  type AgentTaskLoadOptions,
  type AgentTask,
  type AgentTaskInfo,
  type AgentTaskOutputSnapshot,
  type AgentTaskStatus,
  type AgentTaskTrackOptions,
  type ForegroundTaskReleaseReason,
  type IAgentTaskEntry,
  type RegisterAgentTaskOptions,
} from './task';
import { resolveAgentTaskConfig } from './configSection';
import { AgentTaskPersistence } from './persist';
import { TaskModel, taskStarted, taskTerminated } from './taskOps';
import { formatTaskList } from '#/agent/tools/task/task-list/taskListTool';
import '#/agent/tools/task/task-output/taskOutputTool';
import '#/agent/tools/task/task-stop/taskStopTool';

interface ForegroundRelease {
  readonly promise: Promise<ForegroundTaskReleaseReason>;
  resolve(reason: ForegroundTaskReleaseReason): void;
}

type AgentTaskNotification = Record<string, unknown> & {
  readonly id: string;
  readonly category: 'task';
  readonly type: string;
  readonly source_kind: 'background_task';
  readonly source_id: string;
  readonly agent_id?: string | undefined;
  readonly title: string;
  readonly severity: 'info' | 'warning';
  readonly body: string;
  readonly children?: readonly string[] | undefined;
};

interface AgentTaskNotificationBuildContext {
  readonly content: readonly ContentPart[];
  readonly origin: TaskOrigin;
  readonly notification: AgentTaskNotification;
}

const TaskNotificationDeliveryModel = defineCheckpointedModel(
  'task.notificationDelivery',
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
    'terminated. Redirect large output to a file (e.g. `command > out.txt`) and ' +
    'inspect it in slices instead.'
  );
}

const SIGTERM_GRACE_MS = 5_000;
const TASK_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const SESSION_CLOSED_REASON = 'Session closed';
const NOTIFICATION_FALLBACK_PREVIEW_BYTES = 3_000;
const ACTIVE_BACKGROUND_TASK_INJECTION_VARIANT = 'background_task_status';
const ACTIVE_BACKGROUND_TASK_GUIDANCE = [
  'The conversation was compacted, so the earlier messages that started these background tasks are gone — but the tasks are still running from before.',
  'Do not start duplicates. Use TaskList to list them, TaskOutput for a non-blocking status/output snapshot, and TaskStop to cancel one — completion arrives via automatic notification.',
].join(' ');

export function isAgentTaskTerminal(status: AgentTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function coerceTimeoutSettlement(
  entry: ManagedTask,
  settlement: AgentTaskSettlement,
): AgentTaskSettlement {
  if (entry.timedOut && settlement.status === 'killed') {
    return { ...settlement, status: 'timed_out' };
  }
  return settlement;
}

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'task.notified': AgentTaskNotificationContext;
  }
}

export class TaskNotificationStepRequest extends MessageStepRequest {
  constructor(
    message: ContextMessage,
    private readonly onWillDeliver?: () => void,
  ) {
    super(message, {
      kind: 'task_notification',
      mergeable: true,
      turnScoped: false,
      admission: 'activeOrNewTurn',
    });
  }

  override onWillMaterialize(): void {
    this.onWillDeliver?.();
  }
}

export const taskGhostsKey = defineState<Map<string, AgentTaskInfo>>(
  'task.ghosts',
  () => new Map(),
);
export const taskScheduledNotificationKeysKey = defineState<Set<string>>(
  'task.scheduledNotificationKeys',
  () => new Set(),
);
export const taskDeliveredNotificationKeysKey = defineState<Set<string>>(
  'task.deliveredNotificationKeys',
  () => new Set(),
);
export const taskActiveTaskReminderPendingKey = defineState<boolean>(
  'task.activeTaskReminderPending',
  () => false,
);

import { AgentTaskServiceTermination } from './taskService.termination';

export class AgentTaskServiceNotifications extends AgentTaskServiceTermination {

  private async notifyAgentTask(info: AgentTaskInfo): Promise<void> {
    const context = await this.buildAgentTaskNotificationContext(info);
    if (context === undefined) return;
    const key = notificationKey(context.origin);
    const request = new TaskNotificationStepRequest(
      {
        role: 'user',
        content: [...context.content],
        toolCalls: [],
        origin: context.origin,
      },
      () => this.fireNotificationHook(context.notification),
    );
    this.pendingNotificationRequests.set(key, request);
    try {
      const receipt = this.loop.enqueue(request);
      void receipt.assigned
        .then(({ step }) => step.result)
        .then(
          () => {
            if (request.aborted) this.clearPendingNotification(key, request);
          },
          () => this.clearPendingNotification(key, request),
        );
    } catch (error) {
      this.clearPendingNotification(key, request);
      throw error;
    }
  }

  private restoreAgentTaskNotifications(): Promise<void> {
    const restore = this.notificationRestoreQueue.then(() =>
      this.restoreAgentTaskNotificationsNow(),
    );
    this.notificationRestoreQueue = restore.catch(() => {});
    return restore;
  }

  private async restoreAgentTaskNotificationsNow(): Promise<void> {
    for (const info of this.list(false)) {
      if (!isAgentTaskTerminal(info.status)) continue;
      await this.restoreAgentTaskNotification(info);
    }
  }

  private async restoreAgentTaskNotification(info: AgentTaskInfo): Promise<void> {
    const context = await this.buildAgentTaskNotificationContext(info);
    if (context === undefined) return;
    this.context.append({
      role: 'user',
      content: [...context.content],
      toolCalls: [],
      origin: context.origin,
    });
    this.fireNotificationHook(context.notification);
  }

  private async buildAgentTaskNotificationContext(
    info: AgentTaskInfo,
  ): Promise<AgentTaskNotificationBuildContext | undefined> {
    if (info.detached === false) return undefined;
    if (info.terminalNotificationSuppressed === true) return undefined;
    const origin: TaskOrigin = {
      kind: 'task',
      taskId: info.taskId,
      status: info.status,
      notificationId: `task:${info.taskId}:${info.status}`,
    };
    const key = notificationKey(origin);
    if (this.buildingNotificationKeys.has(key)) return undefined;
    if (this.scheduledNotificationKeys.has(key)) return undefined;
    if (this.deliveredNotificationKeys.has(key)) return undefined;
    if (this.hasDeliveredNotification(key)) return undefined;
    this.buildingNotificationKeys.add(key);
    try {
      let output = emptyOutputSnapshot();
      try {
        output = await this.getOutputSnapshot(info.taskId, 0);
        if (!output.fullOutputAvailable) {
          output = await this.getOutputSnapshot(info.taskId, NOTIFICATION_FALLBACK_PREVIEW_BYTES);
        }
      } catch (error) {
        this.log.error('task notification output read failed; delivering without output', {
          taskId: info.taskId,
          error,
        });
      }
      if (this.isTerminalNotificationSuppressed(info.taskId)) return undefined;
      if (this.scheduledNotificationKeys.has(key)) return undefined;
      if (this.deliveredNotificationKeys.has(key)) return undefined;
      if (this.hasDeliveredNotification(key)) return undefined;
      this.scheduledNotificationKeys.add(key);
      const notification: AgentTaskNotification = {
        id: origin.notificationId,
        category: 'task',
        type: `task.${info.status}`,
        source_kind: 'background_task',
        source_id: info.taskId,
        agent_id: info.kind === 'agent' ? info.agentId : undefined,
        title: `Background ${info.kind} ${info.status}`,
        severity: info.status === 'completed' ? 'info' : 'warning',
        body: buildAgentTaskNotificationBody(info),
        children: agentTaskNotificationChildren(output),
      };
      const content = [
        {
          type: 'text',
          text: renderNotificationXml(notification),
        },
      ] as const;
      return { content, origin, notification };
    } finally {
      this.buildingNotificationKeys.delete(key);
    }
  }

  private fireNotificationHook(notification: AgentTaskNotification): void {
    this.eventBus.publish({
      type: 'task.notified',
      notificationType: notification.type,
      title: notification.title,
      body: notification.body,
      severity: notification.severity,
      sourceKind: notification.source_kind,
      sourceId: notification.source_id,
    });
  }

  private isTerminalNotificationSuppressed(taskId: string): boolean {
    return (
      this.tasks.get(taskId)?.terminalNotificationSuppressed === true ||
      this.ghosts.get(taskId)?.terminalNotificationSuppressed === true
    );
  }

  private markDeliveredNotification(origin: TaskNotificationOrigin): void {
    const key = notificationKey(origin);
    this.scheduledNotificationKeys.delete(key);
    this.pendingNotificationRequests.delete(key);
    this.deliveredNotificationKeys.add(key);
  }

  private clearPendingNotification(key: string, request: TaskNotificationStepRequest): void {
    if (this.pendingNotificationRequests.get(key) !== request) return;
    this.pendingNotificationRequests.delete(key);
    if (!this.deliveredNotificationKeys.has(key) && !this.hasDeliveredNotification(key)) {
      this.scheduledNotificationKeys.delete(key);
    }
  }

  private hasDeliveredNotification(key: string): boolean {
    return this.context.get().some((message) => {
      return isTaskOrigin(message.origin) && notificationKey(message.origin) === key;
    });
  }

  private resolveWaiters(entry: ManagedTask): void {
    const waiters = entry.waiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  private installForegroundSignal(entry: ManagedTask): void {
    const signal = entry.options.signal;
    if (signal === undefined) return;

    const abortFromSignal = (): void => {
      if (this.isDetached(entry)) return;
      const userReason = userCancellationReason();
      void this.terminateWithGrace(entry, {
        stopReason: userReason.message,
        abortReason: signal.reason,
        finalStatus: 'killed',
      });
    };
    if (signal.aborted) {
      abortFromSignal();
      return;
    }
    signal.addEventListener('abort', abortFromSignal, { once: true });
    entry.foregroundSignalCleanup = () => {
      signal.removeEventListener('abort', abortFromSignal);
    };
  }

  private toInfo(entry: ManagedTask): AgentTaskInfo {
    const base: AgentTaskInfoBase = {
      taskId: entry.taskId,
      description: entry.task?.description ?? entry.options.description ?? '',
      status: entry.status,
      detached: this.isDetached(entry) ? true : false,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      stopReason: entry.stopReason,
      terminalNotificationSuppressed: entry.terminalNotificationSuppressed,
      timeoutMs: entry.options.timeoutMs,
    };
    if (entry.toInfoFn) return entry.toInfoFn(base);
    return entry.task!.toInfo(base);
  }
}

function emptyOutputSnapshot(): AgentTaskOutputSnapshot {
  return {
    outputSizeBytes: 0,
    previewBytes: 0,
    truncated: false,
    fullOutputAvailable: false,
    preview: '',
  };
}

function agentTaskNotificationChildren(
  output: AgentTaskOutputSnapshot,
): readonly string[] | undefined {
  if (output.fullOutputAvailable && output.outputPath !== undefined) {
    return [renderOutputFileBlock(output.outputPath, output.outputSizeBytes)];
  }
  if (output.preview.length === 0) return undefined;
  return [renderOutputPreviewBlock(output)];
}

function renderOutputFileBlock(outputPath: string, outputSizeBytes: number): string {
  return [
    `<output-file path="${escapeXmlAttr(outputPath)}" bytes="${String(outputSizeBytes)}">`,
    `Read the output file to retrieve the result: ${escapeXml(outputPath)}`,
    '</output-file>',
  ].join('\n');
}

function renderOutputPreviewBlock(output: AgentTaskOutputSnapshot): string {
  return [
    `<output-preview bytes="${String(output.previewBytes)}" total_bytes="${String(output.outputSizeBytes)}" truncated="${String(output.truncated)}">`,
    output.truncated
      ? `Showing the last ${String(output.previewBytes)} bytes. No persisted full output is available.`
      : 'No persisted full output is available; this preview is the currently buffered task output.',
    escapeXml(output.preview),
    '</output-preview>',
  ].join('\n');
}

function shouldListTask(info: AgentTaskInfo, activeOnly: boolean): boolean {
  if (!TERMINAL_STATUSES.has(info.status)) return true;
  if (activeOnly) return false;
  return info.detached !== false;
}

function isCompactionSplice(splice: {
  readonly deleteCount: number;
  readonly messages: readonly { readonly origin?: { readonly kind: string } | undefined }[];
}): boolean {
  return (
    splice.deleteCount > 0 &&
    splice.messages.some((message) => message.origin?.kind === 'compaction_summary')
  );
}

function newerRestoredTask(
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

type TaskNotificationOrigin = Pick<TaskOrigin, 'taskId' | 'status' | 'notificationId'>;

function isTaskOrigin(origin: unknown): origin is TaskNotificationOrigin {
  if (typeof origin !== 'object' || origin === null) return false;
  const value = origin as Record<string, unknown>;
  return (
    (value['kind'] === 'background_task' || value['kind'] === 'task') &&
    typeof value['taskId'] === 'string' &&
    typeof value['status'] === 'string' &&
    typeof value['notificationId'] === 'string'
  );
}

function notificationKey(origin: TaskNotificationOrigin): string {
  return `${origin.taskId}\0${origin.status}\0${origin.notificationId}`;
}

function taskOriginFromMessage(message: unknown): TaskNotificationOrigin | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const origin = (message as { readonly origin?: unknown }).origin;
  return isTaskOrigin(origin) ? origin : undefined;
}

function buildAgentTaskNotificationBody(info: AgentTaskInfo): string {
  const baseLine =
    info.status === 'timed_out'
      ? `${info.description} timed out.`
      : info.status === 'killed' && isSerializedUserCancellation(info.stopReason)
        ? `${info.description} was stopped by user.`
        : info.stopReason
          ? `${info.description} ${info.status === 'killed' ? 'was stopped' : info.status}. Reason: ${info.stopReason}`
          : `${info.description} ${info.status}.`;

  if (info.kind !== 'agent') return baseLine;
  if (info.status === 'completed') return baseLine;
  const agentId = info.agentId;
  if (agentId === undefined || agentId === info.taskId) return baseLine;

  const recovery = [
    '',
    `To recover or continue this subagent, call Agent(resume="${agentId}", prompt="Pick up where you left off; redo the last tool call if its result was never observed.").`,
    `Use agent_id ("${agentId}"), NOT source_id / task_id ("${info.taskId}") — the two look alike but only agent_id is accepted by the resume parameter.`,
    'Add run_in_background=true to keep it backgrounded, or omit it to take the result inline in the current turn.',
    'The subagent retains its full prior context across the restart, but any in-flight tool call lost its result and may need to be redone.',
  ].join('\n');

  return `${baseLine}${recovery}`;
}

function generateTaskId(kind: string): string {
  const bytes = randomBytes(8);
  let suffix = '';
  for (let index = 0; index < 8; index++) {
    suffix += TASK_ID_ALPHABET[bytes[index]! % TASK_ID_ALPHABET.length];
  }
  return `${kind}-${suffix}`;
}

function normalizeReason(reason: string | undefined): string | undefined {
  const trimmed = reason?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function isSerializedUserCancellation(reason: string | undefined): boolean {
  return reason === userCancellationReason().message;
}

function createForegroundRelease(): ForegroundRelease {
  let resolve!: (reason: ForegroundTaskReleaseReason) => void;
  const promise = new Promise<ForegroundTaskReleaseReason>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}


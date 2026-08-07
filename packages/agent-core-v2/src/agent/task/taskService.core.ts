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

import { randomBytes } from "node:crypto";
import { join } from "pathe";

import {
  LifecycleScope,
  ScopeActivation,
  registerScopedService,
} from "#/_base/di/scope";

import type { ContentPart } from "#/kosong/contract/message";

import { Disposable } from "#/_base/di/lifecycle";
import { ILogService } from "#/_base/log/log";
import { defineState } from "#/_base/state/stateRegistry";
import { abortable, userCancellationReason } from "#/_base/utils/abort";
import { escapeXml, escapeXmlAttr } from "#/_base/utils/xml-escape";
import { IEventBus } from "#/app/event/eventBus";
import { Error2, ErrorCodes } from "#/errors";
import { defineCheckpointedModel } from "#/agent/contextMemory/conversationTime";
import { IAgentConversationUndoParticipantRegistry } from "#/agent/contextMemory/conversationUndoParticipants";
import type { ContextMessage, TaskOrigin } from "#/agent/contextMemory/types";
import { IAgentContextInjectorService } from "#/agent/contextInjector/contextInjector";
import { IAgentLoopService } from "#/agent/loop/loop";
import { MessageStepRequest } from "#/agent/loop/stepRequest";
import { IAgentScopeContext } from "#/agent/scopeContext/scopeContext";
import { IAgentStateService } from "#/agent/state/agentState";
import {
  ITaskService,
  type ITaskHandle,
  TERMINAL_TASK_STATES,
} from "#/app/task/task";
import {
  TERMINAL_STATUSES,
  type AgentTaskInfoBase,
  type AgentTaskSettlement,
} from "./types";
import { renderNotificationXml } from "./notificationXml";

import { IAgentContextMemoryService } from "#/agent/contextMemory/contextMemory";
import { IConfigService } from "#/app/config/config";
import { ISessionContext } from "#/session/sessionContext/sessionContext";
import { IAtomicDocumentStore } from "#/persistence/interface/atomicDocumentStore";
import { IFileSystemStorageService } from "#/persistence/interface/storage";
import { ITelemetryService } from "#/app/telemetry/telemetry";
import { IWireService } from "#/wire/wire";
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
} from "./task";
import { resolveAgentTaskConfig } from "./configSection";
import { AgentTaskPersistence } from "./persist";
import { TaskModel, taskStarted, taskTerminated } from "./taskOps";
import { formatTaskList } from "#/agent/tools/task/task-list/taskListTool";
import "#/agent/tools/task/task-output/taskOutputTool";
import "#/agent/tools/task/task-stop/taskStopTool";
import {
  createForegroundRelease,
  emptyOutputSnapshot,
  errorMessage,
  generateTaskId,
  isCompactionSplice,
  isTaskOrigin,
  newerRestoredTask,
  normalizeReason,
  notificationKey,
  shouldListTask,
  taskOriginFromMessage,
  TaskNotificationDeliveryModel,
} from "./taskService.support";

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

const SIGTERM_GRACE_MS = 5_000;
const TASK_ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const SESSION_CLOSED_REASON = "Session closed";
const NOTIFICATION_FALLBACK_PREVIEW_BYTES = 3_000;
const ACTIVE_BACKGROUND_TASK_INJECTION_VARIANT = "background_task_status";
const ACTIVE_BACKGROUND_TASK_GUIDANCE = [
  "The conversation was compacted, so the earlier messages that started these background tasks are gone — but the tasks are still running from before.",
  "Do not start duplicates. Use TaskList to list them, TaskOutput for a non-blocking status/output snapshot, and TaskStop to cancel one — completion arrives via automatic notification.",
].join(" ");

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

export class AgentTaskServiceCore
  extends Disposable
  implements IAgentTaskService
{
  declare readonly _serviceBrand: undefined;

  private readonly tasks = new Map<string, ManagedTask>();
  private readonly buildingNotificationKeys = new Set<string>();
  private readonly pendingNotificationRequests = new Map<
    string,
    TaskNotificationStepRequest
  >();
  private readonly persistence: AgentTaskPersistence;
  private notificationRestoreQueue: Promise<void> = Promise.resolve();

  constructor(
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentContextMemoryService
    private readonly context: IAgentContextMemoryService,
    @IConfigService private readonly config: IConfigService,
    @IAtomicDocumentStore atomicDocs: IAtomicDocumentStore,
    @IFileSystemStorageService byteStore: IFileSystemStorageService,
    @ISessionContext session: ISessionContext,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @ITaskService private readonly taskService: ITaskService,
    @IWireService private readonly wire: IWireService,
    @IEventBus private readonly eventBus: IEventBus,
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentConversationUndoParticipantRegistry
    undoParticipants: IAgentConversationUndoParticipantRegistry,
    @ILogService private readonly log: ILogService,
    @IAgentStateService private readonly states: IAgentStateService,
  ) {
    super();
    this.states.register(taskGhostsKey);
    this.states.register(taskScheduledNotificationKeysKey);
    this.states.register(taskDeliveredNotificationKeysKey);
    this.states.register(taskActiveTaskReminderPendingKey);
    const fallbackRoot =
      scopeContext.agentId === "main"
        ? { dir: session.sessionDir, scope: session.scope() }
        : undefined;
    this.persistence = new AgentTaskPersistence(
      join(session.sessionDir, "agents", scopeContext.agentId),
      scopeContext.scope(),
      atomicDocs,
      byteStore,
      fallbackRoot,
    );
    this._register(
      undoParticipants.register({
        id: "task.notificationDelivery",
        reconcileAfterUndo: () => this.reconcileNotificationDeliveryAfterUndo(),
      }),
    );
    this._register(
      this.wire.hooks.onDidRestore.register("task", async (_ctx, next) => {
        for (const key of this.wire.getModel(TaskNotificationDeliveryModel)
          .current) {
          this.deliveredNotificationKeys.add(key);
        }
        await this.restoreAfterReplay();
        await next();
      }),
    );
    this._register(
      this.eventBus.subscribe("context.spliced", (e) => {
        if (isCompactionSplice(e)) {
          this.activeTaskReminderPending = true;
        }
        for (const message of e.messages) {
          if (isTaskOrigin(message.origin)) {
            this.markDeliveredNotification(message.origin);
          }
        }
      }),
    );
    this._register(
      injector.register(ACTIVE_BACKGROUND_TASK_INJECTION_VARIANT, () =>
        this.activeBackgroundTaskReminder(),
      ),
    );
  }

  private get ghosts(): Map<string, AgentTaskInfo> {
    return this.states.get(taskGhostsKey);
  }

  private get scheduledNotificationKeys(): Set<string> {
    return this.states.get(taskScheduledNotificationKeysKey);
  }

  private get deliveredNotificationKeys(): Set<string> {
    return this.states.get(taskDeliveredNotificationKeysKey);
  }

  private get activeTaskReminderPending(): boolean {
    return this.states.get(taskActiveTaskReminderPendingKey);
  }

  private set activeTaskReminderPending(value: boolean) {
    this.states.set(taskActiveTaskReminderPendingKey, value);
  }

  private async restoreAfterReplay(): Promise<void> {
    this.restoreGhostsFromWire();
    await this.loadFromDisk({ replace: false });
    await this.reconcile();
  }

  private activeBackgroundTaskReminder(): string | undefined {
    if (!this.activeTaskReminderPending) return undefined;
    this.activeTaskReminderPending = false;
    const tasks = this.list(true);
    if (tasks.length === 0) return undefined;
    return `${ACTIVE_BACKGROUND_TASK_GUIDANCE}\n\n${formatTaskList(tasks, true)}`;
  }

  private restoreGhostsFromWire(): void {
    for (const [taskId, info] of this.wire.getModel(TaskModel)) {
      if (this.tasks.has(taskId)) continue;
      this.ghosts.set(taskId, info);
    }
  }

  registerTask(
    task: AgentTask,
    options: RegisterAgentTaskOptions = {},
  ): string {
    const detached = options.detached ?? true;
    const timeoutMs = options.timeoutMs ?? task.timeoutMs;
    const entryOptions: RegisterAgentTaskOptions = {
      detached,
      timeoutMs,
      detachTimeoutMs: options.detachTimeoutMs,
      autoBackgroundOnTimeout: options.autoBackgroundOnTimeout,
      signal: detached ? undefined : options.signal,
    };
    this.assertCanRegister(detached);
    const entry: ManagedTask = {
      taskId: generateTaskId(task.idPrefix),
      task,
      handle: undefined,
      outputChunks: [],
      outputSizeBytes: 0,
      retainedOutputBytes: 0,
      outputLimitTripped: false,
      status: "running",
      options: entryOptions,
      startedAt: Date.now(),
      endedAt: null,
      foregroundRelease: detached ? undefined : createForegroundRelease(),
      abortController: new AbortController(),
      lifecyclePromise: Promise.resolve(),
      persistWriteQueue: Promise.resolve(),
      outputWriteQueue: Promise.resolve(),
      pendingOutput: [],
      pendingOutputBytes: 0,
      outputPersistStarted: detached,
      waiters: [],
      terminalFired: false,
      timedOut: false,
    };
    this.tasks.set(entry.taskId, entry);
    this.ghosts.delete(entry.taskId);

    if (timeoutMs !== undefined && timeoutMs > 0) {
      this.armManagerTimeout(entry, timeoutMs);
    }

    entry.lifecyclePromise = Promise.resolve()
      .then(() =>
        task.start({
          signal: entry.abortController.signal,
          appendOutput: (chunk) => {
            this.appendOutput(entry, chunk);
          },
          settle: (settlement) =>
            this.settleTask(entry, coerceTimeoutSettlement(entry, settlement)),
        }),
      )
      .catch(async (error: unknown) => {
        const aborted = entry.abortController.signal.aborted;
        let status: AgentTaskStatus;
        if (entry.timedOut) {
          status = "timed_out";
        } else if (aborted) {
          status = "killed";
        } else {
          status = "failed";
        }
        await this.settleTask(entry, {
          status,
          stopReason: status === "failed" ? errorMessage(error) : undefined,
        });
      });
    this.installForegroundSignal(entry);

    if (this.isDetached(entry)) {
      void this.persistLive(entry);
      this.recordTaskStarted(this.toInfo(entry));
    }
    return entry.taskId;
  }

  track(handle: ITaskHandle, options: AgentTaskTrackOptions): IAgentTaskEntry {
    const detached = options.detached ?? true;
    this.assertCanRegister(detached);

    const taskId = generateTaskId(options.idPrefix ?? "task");
    const timeoutMs = options.timeoutMs;

    const entry: ManagedTask = {
      taskId,
      task: undefined,
      handle,
      toInfoFn: options.toInfo,
      forceStopFn: options.forceStop,
      onDetachFn: options.onDetach,
      outputChunks: [],
      outputSizeBytes: 0,
      retainedOutputBytes: 0,
      outputLimitTripped: false,
      status: "running",
      options: {
        detached,
        timeoutMs,
        detachTimeoutMs: options.detachTimeoutMs,
        signal: detached ? undefined : options.signal,
        description: options.description,
      },
      startedAt: Date.now(),
      endedAt: null,
      foregroundRelease: detached ? undefined : createForegroundRelease(),
      abortController: new AbortController(),
      lifecyclePromise: Promise.resolve(),
      persistWriteQueue: Promise.resolve(),
      outputWriteQueue: Promise.resolve(),
      pendingOutput: [],
      pendingOutputBytes: 0,
      outputPersistStarted: detached,
      waiters: [],
      terminalFired: false,
      timedOut: false,
    };
    this.tasks.set(taskId, entry);
    this.ghosts.delete(taskId);

    if (timeoutMs !== undefined && timeoutMs > 0) {
      this.armManagerTimeout(entry, timeoutMs);
    }

    const outputSub = handle.onDidOutput((chunk) => {
      this.appendOutput(entry, chunk);
    });

    const stateSub = handle.onDidChangeState((state) => {
      if (!TERMINAL_TASK_STATES.has(state)) return;
      const status = entry.timedOut
        ? ("timed_out" as const)
        : state === "cancelled"
          ? ("killed" as const)
          : state === "failed"
            ? ("failed" as const)
            : ("completed" as const);
      void this.settleTask(entry, { status, stopReason: entry.stopReason });
    });

    entry.handleSubscription = {
      dispose() {
        outputSub.dispose();
        stateSub.dispose();
      },
    };

    entry.lifecyclePromise = handle.result.then(
      () => {},
      () => {},
    );

    this.installForegroundSignal(entry);

    if (this.isDetached(entry)) {
      void this.persistLive(entry);
      this.recordTaskStarted(this.toInfo(entry));
    }

    return {
      taskId,
      onDidDetach:
        entry.foregroundRelease?.promise ??
        Promise.resolve("terminal" as const),
    };
  }

  getTask(taskId: string): AgentTaskInfo | undefined {
    const entry = this.tasks.get(taskId);
    return entry === undefined ? this.ghosts.get(taskId) : this.toInfo(entry);
  }

  list(activeOnly = true, limit?: number): readonly AgentTaskInfo[] {
    const result: AgentTaskInfo[] = [];
    for (const entry of this.tasks.values()) {
      const info = this.toInfo(entry);
      if (!shouldListTask(info, activeOnly)) continue;
      result.push(info);
      if (limit !== undefined && result.length >= limit) return result;
    }
    if (!activeOnly) {
      for (const ghost of this.ghosts.values()) {
        if (!shouldListTask(ghost, activeOnly)) continue;
        result.push(ghost);
        if (limit !== undefined && result.length >= limit) return result;
      }
    }
    return result;
  }

  private async reconcileNotificationDeliveryAfterUndo(): Promise<void> {
    const restoredKeys = new Set(
      this.wire.getModel(TaskNotificationDeliveryModel).current,
    );
    for (const [key, request] of this.pendingNotificationRequests) {
      if (request.aborted) this.clearPendingNotification(key, request);
    }
    this.deliveredNotificationKeys.clear();
    for (const key of restoredKeys) this.deliveredNotificationKeys.add(key);
    for (const key of this.scheduledNotificationKeys) {
      if (restoredKeys.has(key) || !this.pendingNotificationRequests.has(key)) {
        this.scheduledNotificationKeys.delete(key);
      }
    }
    await this.restoreAgentTaskNotifications();
  }

  persistOutput(taskId: string): void {
    const entry = this.tasks.get(taskId);
    if (entry === undefined) return;
    this.startOutputPersist(entry);
  }

  async loadFromDisk(options: AgentTaskLoadOptions = {}): Promise<void> {
    const persistence = this.persistence;
    if (options.replace !== false) {
      this.ghosts.clear();
    }
    const tasks = await persistence.listTasks();
    for (const task of tasks) {
      if (this.tasks.has(task.taskId)) continue;
      const existing = this.ghosts.get(task.taskId);
      if (existing !== undefined) {
        this.ghosts.set(task.taskId, newerRestoredTask(existing, task));
        continue;
      }
      this.ghosts.set(task.taskId, task);
    }
  }

  async reconcile(): Promise<readonly AgentTaskInfo[]> {
    const lostTasks = await this.markLoadedTasksLost();
    for (const info of lostTasks) {
      this.recordTaskTerminated(info);
    }
    await this.restoreAgentTaskNotifications();
    return lostTasks;
  }

  async getOutputSnapshot(
    taskId: string,
    maxPreviewBytes: number,
  ): Promise<AgentTaskOutputSnapshot> {
    if (this.getTask(taskId) === undefined) return emptyOutputSnapshot();

    await this.tasks.get(taskId)?.outputWriteQueue;

    const previewLimit = Math.max(0, Math.trunc(maxPreviewBytes));
    const persistence = this.persistence;
    const persisted = await persistence.readTaskOutputSnapshot(
      taskId,
      previewLimit,
    );
    if (persisted !== undefined) {
      return {
        ...persisted,
        fullOutputAvailable: true,
      };
    }

    const entry = this.tasks.get(taskId);
    if (entry === undefined) return emptyOutputSnapshot();

    const available = Buffer.from(entry.outputChunks.join(""), "utf-8");
    const previewBytes = Math.min(
      previewLimit,
      available.byteLength,
      entry.outputSizeBytes,
    );
    const previewOffset = Math.max(0, available.byteLength - previewBytes);
    return {
      outputSizeBytes: entry.outputSizeBytes,
      previewBytes,
      truncated: entry.outputSizeBytes > previewBytes,
      fullOutputAvailable: false,
      preview: available.subarray(previewOffset).toString("utf-8"),
    };
  }

  async readOutput(taskId: string, tail?: number): Promise<string> {
    const output = (
      await this.getOutputSnapshot(taskId, Number.MAX_SAFE_INTEGER)
    ).preview;
    if (tail === undefined) return output;
    return output.slice(-Math.max(0, Math.trunc(tail)));
  }

  async suppressTerminalNotification(taskId: string): Promise<void> {
    const entry = this.tasks.get(taskId);
    if (entry !== undefined) {
      if (entry.terminalNotificationSuppressed === true) return;
      entry.terminalNotificationSuppressed = true;
      await this.persistLive(entry);
      return;
    }

    const ghost = this.ghosts.get(taskId);
    if (ghost !== undefined) return;
  }

  detach(taskId: string): AgentTaskInfo | undefined {
    const entry = this.tasks.get(taskId);
    if (entry === undefined) return this.ghosts.get(taskId);
    return this.detachEntry(entry, false);
  }

  private detachEntry(
    entry: ManagedTask,
    viaTimeout: boolean,
  ): AgentTaskInfo | undefined {
    if (TERMINAL_STATUSES.has(entry.status)) return this.toInfo(entry);

    const foregroundRelease = entry.foregroundRelease;
    if (foregroundRelease === undefined) return this.toInfo(entry);

    entry.foregroundRelease = undefined;
    entry.foregroundSignalCleanup?.();
    entry.foregroundSignalCleanup = undefined;
    this.applyDetachTimeout(entry);
    try {
      const onDetach =
        entry.onDetachFn ??
        (entry.task === undefined
          ? undefined
          : entry.task.onDetach?.bind(entry.task));
      onDetach?.();
    } catch {}
    this.startOutputPersist(entry);
    void this.persistLive(entry);
    this.recordTaskStarted(this.toInfo(entry));
    foregroundRelease.resolve(viaTimeout ? "timeout_detached" : "detached");
    return this.toInfo(entry);
  }

  private applyDetachTimeout(entry: ManagedTask): void {
    const timeoutMs = entry.options.detachTimeoutMs;
    if (timeoutMs === undefined) return;
    entry.options = { ...entry.options, timeoutMs };
    if (entry.timeoutHandle !== undefined) {
      clearTimeout(entry.timeoutHandle);
      entry.timeoutHandle = undefined;
    }
    if (timeoutMs > 0) {
      this.armManagerTimeout(entry, timeoutMs);
    }
  }

  private armManagerTimeout(entry: ManagedTask, timeoutMs: number): void {
    entry.timeoutHandle = setTimeout(() => {
      entry.timeoutHandle = undefined;
      if (this.canAutoBackgroundOnTimeout(entry)) {
        this.detachEntry(entry, true);
        return;
      }
      void this.terminateWithGrace(entry, {
        abortReason: "Timed out",
        finalStatus: "timed_out",
      });
    }, timeoutMs);
    entry.timeoutHandle.unref?.();
  }

  private canAutoBackgroundOnTimeout(entry: ManagedTask): boolean {
    return (
      entry.options.autoBackgroundOnTimeout === true && !this.isDetached(entry)
    );
  }

  async stop(
    taskId: string,
    reason?: string,
  ): Promise<AgentTaskInfo | undefined> {
    const entry = this.tasks.get(taskId);
    if (entry === undefined) return undefined;
    const normalized = normalizeReason(reason);
    return this.terminateWithGrace(entry, {
      stopReason: normalized,
      abortReason: normalized,
      finalStatus: "killed",
    });
  }

  async stopByUser(taskId: string): Promise<AgentTaskInfo | undefined> {
    const entry = this.tasks.get(taskId);
    if (entry === undefined) return undefined;
    const reason = userCancellationReason();
    return this.terminateWithGrace(entry, {
      stopReason: reason.message,
      abortReason: reason,
      finalStatus: "killed",
    });
  }
}

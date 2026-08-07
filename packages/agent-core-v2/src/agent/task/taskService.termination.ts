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

import { AgentTaskServiceCore } from "./taskService.core";

export class AgentTaskServiceTermination extends AgentTaskServiceCore {
  private async terminateWithGrace(
    entry: ManagedTask,
    options: {
      readonly stopReason?: string;
      readonly abortReason: unknown;
      readonly finalStatus: "killed" | "timed_out";
    },
  ): Promise<AgentTaskInfo | undefined> {
    if (TERMINAL_STATUSES.has(entry.status)) {
      await entry.persistWriteQueue;
      return this.toInfo(entry);
    }

    if (entry.timeoutHandle !== undefined) {
      clearTimeout(entry.timeoutHandle);
      entry.timeoutHandle = undefined;
    }
    if (options.finalStatus === "timed_out") {
      entry.timedOut = true;
    }
    entry.stopReason = options.stopReason;
    if (entry.handle) {
      entry.handle.cancel();
    } else {
      entry.abortController.abort(options.abortReason);
    }

    const graceMs =
      resolveAgentTaskConfig(this.config)?.killGracePeriodMs ??
      SIGTERM_GRACE_MS;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const graceful = await Promise.race([
      entry.lifecyclePromise.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        graceTimer = setTimeout(() => {
          resolve(false);
        }, graceMs);
        graceTimer.unref?.();
      }),
    ]);
    if (graceTimer !== undefined) clearTimeout(graceTimer);

    if (TERMINAL_STATUSES.has(entry.status)) {
      await entry.persistWriteQueue;
      return this.toInfo(entry);
    }

    if (!graceful) {
      try {
        const forceStop =
          entry.forceStopFn ??
          (entry.task === undefined
            ? undefined
            : entry.task.forceStop?.bind(entry.task));
        await forceStop?.();
      } catch {}
    }

    if (TERMINAL_STATUSES.has(entry.status)) {
      await entry.persistWriteQueue;
      return this.toInfo(entry);
    }

    await this.settleTask(entry, {
      status: options.finalStatus,
      stopReason: options.stopReason,
    });
    await entry.persistWriteQueue;
    return this.toInfo(entry);
  }

  async stopAll(reason?: string): Promise<readonly AgentTaskInfo[]> {
    const results = await Promise.all(
      Array.from(this.tasks.keys()).map((taskId) => this.stop(taskId, reason)),
    );
    return results.filter((info): info is AgentTaskInfo => info !== undefined);
  }

  async stopAllOnExit(reason: string): Promise<readonly AgentTaskInfo[]> {
    if (this.keepAliveOnExit()) return [];
    const active = this.list(true);
    await Promise.all(
      active
        .filter((task) => task.detached === true)
        .map((task) => this.suppressTerminalNotification(task.taskId)),
    );
    return this.stopAll(reason);
  }

  override dispose(): void {
    if (!this.keepAliveOnExit()) {
      for (const entry of this.tasks.values()) {
        if (TERMINAL_STATUSES.has(entry.status)) continue;
        if (entry.timeoutHandle !== undefined) {
          clearTimeout(entry.timeoutHandle);
          entry.timeoutHandle = undefined;
        }
        if (entry.handle !== undefined) {
          entry.handle.cancel();
        } else {
          entry.abortController.abort(SESSION_CLOSED_REASON);
        }
        this.forceStopOnDispose(entry);
      }
    }
    super.dispose();
  }

  private forceStopOnDispose(entry: ManagedTask): void {
    const forceStop =
      entry.forceStopFn ??
      (entry.task === undefined
        ? undefined
        : entry.task.forceStop?.bind(entry.task));
    if (forceStop === undefined) return;
    try {
      void forceStop().catch(() => {});
    } catch {}
  }

  private keepAliveOnExit(): boolean {
    return resolveAgentTaskConfig(this.config)?.keepAliveOnExit === true;
  }

  async wait(
    taskId: string,
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<AgentTaskInfo | undefined> {
    const entry = this.tasks.get(taskId);
    if (entry === undefined) return this.ghosts.get(taskId);
    if (TERMINAL_STATUSES.has(entry.status)) {
      await entry.persistWriteQueue;
      return this.toInfo(entry);
    }
    if (timeoutMs <= 0) {
      return this.toInfo(entry);
    }

    let waiter: (() => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const pending = Promise.race([
        new Promise<void>((resolve) => {
          waiter = resolve;
          entry.waiters.push(resolve);
        }),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, timeoutMs);
          timeout.unref?.();
        }),
      ]);
      await (signal === undefined ? pending : abortable(pending, signal));
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (waiter !== undefined) {
        const index = entry.waiters.indexOf(waiter);
        if (index !== -1) entry.waiters.splice(index, 1);
      }
    }

    if (TERMINAL_STATUSES.has(entry.status)) {
      await entry.persistWriteQueue;
    }
    return this.toInfo(entry);
  }

  async waitForForegroundRelease(
    taskId: string,
  ): Promise<ForegroundTaskReleaseReason | undefined> {
    const entry = this.tasks.get(taskId);
    if (entry === undefined) return undefined;
    if (TERMINAL_STATUSES.has(entry.status)) {
      await entry.persistWriteQueue;
      return "terminal";
    }
    if (this.isDetached(entry)) return "detached";

    const foregroundRelease = entry.foregroundRelease;
    if (foregroundRelease === undefined) return "detached";
    const foregroundReleasePromise = foregroundRelease.promise;
    const reason = await Promise.race([
      foregroundReleasePromise,
      entry.lifecyclePromise.then(() => "terminal" as const),
    ]);
    if (reason === "terminal") {
      await entry.persistWriteQueue;
    }
    return reason;
  }

  private assertCanRegister(detached: boolean): void {
    const maxRunningTasks = resolveAgentTaskConfig(
      this.config,
    )?.maxRunningTasks;
    if (maxRunningTasks === undefined) return;
    if (!detached) return;
    if (this.activeTaskCount() < maxRunningTasks) return;
    throw new Error2(
      ErrorCodes.TASK_LIMIT_EXCEEDED,
      "Too many background tasks are already running.",
      {
        details: { running: this.activeTaskCount(), max: maxRunningTasks },
      },
    );
  }

  private activeTaskCount(): number {
    let count = 0;
    for (const entry of this.tasks.values()) {
      if (!TERMINAL_STATUSES.has(entry.status) && this.startsDetached(entry))
        count++;
    }
    return count;
  }

  private startsDetached(entry: ManagedTask): boolean {
    return entry.options.detached !== false;
  }

  private isDetached(entry: ManagedTask): boolean {
    return entry.foregroundRelease === undefined;
  }

  private async markLoadedTasksLost(): Promise<readonly AgentTaskInfo[]> {
    const lostTasks: AgentTaskInfo[] = [];
    const persistence = this.persistence;
    for (const [taskId, info] of this.ghosts) {
      if (TERMINAL_STATUSES.has(info.status)) continue;
      const updated: AgentTaskInfo = {
        ...info,
        status: "lost",
        endedAt: info.endedAt ?? Date.now(),
      };
      this.ghosts.set(taskId, updated);
      await persistence.writeTask(updated);
      lostTasks.push(updated);
    }
    return lostTasks;
  }

  private persistLive(entry: ManagedTask): Promise<void> {
    const persistence = this.persistence;
    const info = this.toInfo(entry);
    entry.persistWriteQueue = entry.persistWriteQueue
      .then(() => persistence.writeTask(info))
      .catch(() => {});
    return entry.persistWriteQueue;
  }

  private appendOutput(entry: ManagedTask, chunk: string): void {
    const chunkBytes = Buffer.byteLength(chunk, "utf-8");
    entry.outputSizeBytes += chunkBytes;
    this.appendRetainedOutput(entry, chunk, chunkBytes);

    if (
      !entry.outputLimitTripped &&
      entry.task?.kind === "process" &&
      entry.outputSizeBytes > MAX_TASK_OUTPUT_BYTES
    ) {
      entry.outputLimitTripped = true;
      void this.stop(entry.taskId, outputLimitReason());
    }

    if (entry.outputLimitTripped) return;

    if (!entry.outputPersistStarted) {
      entry.pendingOutput.push(chunk);
      entry.pendingOutputBytes += chunkBytes;
      if (entry.pendingOutputBytes > MAX_OUTPUT_BYTES) {
        this.startOutputPersist(entry);
      }
      return;
    }
    this.appendTaskOutput(entry, chunk);
  }

  private appendTaskOutput(entry: ManagedTask, chunk: string): void {
    const persistence = this.persistence;
    entry.outputWriteQueue = entry.outputWriteQueue
      .then(() => persistence.appendTaskOutput(entry.taskId, chunk))
      .catch(() => {});
  }

  private startOutputPersist(entry: ManagedTask): void {
    if (entry.outputPersistStarted) return;
    entry.outputPersistStarted = true;
    if (entry.pendingOutput.length > 0) {
      this.appendTaskOutput(entry, entry.pendingOutput.join(""));
    }
    entry.pendingOutput = [];
    entry.pendingOutputBytes = 0;
  }

  private appendRetainedOutput(
    entry: ManagedTask,
    chunk: string,
    chunkBytes: number,
  ): void {
    if (chunkBytes >= MAX_OUTPUT_BYTES) {
      const retained = Buffer.from(chunk, "utf-8")
        .subarray(chunkBytes - MAX_OUTPUT_BYTES)
        .toString("utf-8");
      entry.outputChunks.length = 0;
      entry.outputChunks.push(retained);
      entry.retainedOutputBytes = Buffer.byteLength(retained, "utf-8");
      return;
    }

    entry.outputChunks.push(chunk);
    entry.retainedOutputBytes += chunkBytes;
    while (entry.retainedOutputBytes > MAX_OUTPUT_BYTES) {
      const removed = entry.outputChunks.shift();
      if (removed === undefined) break;
      entry.retainedOutputBytes -= Buffer.byteLength(removed, "utf-8");
    }
  }

  private async settleTask(
    entry: ManagedTask,
    settlement: AgentTaskSettlement,
  ): Promise<boolean> {
    if (TERMINAL_STATUSES.has(entry.status)) return false;
    entry.status = settlement.status;
    entry.endedAt = Date.now();
    entry.stopReason =
      settlement.stopReason ??
      (settlement.status === "killed" ? entry.stopReason : undefined);
    entry.foregroundSignalCleanup?.();
    entry.foregroundSignalCleanup = undefined;
    entry.handleSubscription?.dispose();
    entry.handleSubscription = undefined;
    if (entry.timeoutHandle !== undefined) {
      clearTimeout(entry.timeoutHandle);
      entry.timeoutHandle = undefined;
    }
    const foregroundRelease = entry.foregroundRelease;
    if (entry.outputPersistStarted) {
      await this.persistLive(entry);
    } else {
      entry.pendingOutput = [];
      entry.pendingOutputBytes = 0;
    }
    this.fireTerminalEffects(entry);
    foregroundRelease?.resolve("terminal");
    this.resolveWaiters(entry);
    return true;
  }

  private fireTerminalEffects(entry: ManagedTask): void {
    if (entry.terminalFired) return;
    if (!this.isDetached(entry)) return;
    entry.terminalFired = true;
    const info = this.toInfo(entry);
    void this.notifyAgentTask(info).catch((error) => {
      this.log.error("task notification delivery failed", {
        taskId: info.taskId,
        error,
      });
    });
    this.recordTaskTerminated(info, this.retainedOutputTail(entry));
  }

  private retainedOutputTail(entry: ManagedTask): string | undefined {
    if (entry.outputChunks.length === 0) return undefined;
    const retained = Buffer.from(entry.outputChunks.join(""), "utf-8");
    const offset = Math.max(
      0,
      retained.byteLength - TERMINAL_OUTPUT_TAIL_BYTES,
    );
    return retained.subarray(offset).toString("utf-8");
  }

  private recordTaskStarted(info: AgentTaskInfo): void {
    this.wire.dispatch(taskStarted({ info }));
    this.telemetry.track2("background_task_created", {
      task_id: info.taskId,
      kind: info.kind === "process" ? "bash" : info.kind,
    });
  }

  private recordTaskTerminated(info: AgentTaskInfo, outputTail?: string): void {
    this.wire.dispatch(taskTerminated({ info, outputTail }));
    this.telemetry.track2("background_task_completed", {
      task_id: info.taskId,
      kind: info.kind,
      duration_ms: info.endedAt !== null ? info.endedAt - info.startedAt : null,
      status: info.status,
    });
  }
}

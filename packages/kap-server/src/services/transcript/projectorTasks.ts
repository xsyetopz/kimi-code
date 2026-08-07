import type { StepUsage, TranscriptOperation, TranscriptTask } from "@moonshot-ai/transcript";
import { epochMsToIso, mapTaskKind, nowIso } from "./projectorMappings";
import type { AgentRef, ToolCallFrame } from "@moonshot-ai/transcript";
import { ProjectorTools } from "./projectorTools";

export abstract class ProjectorTasks extends ProjectorTools {
  protected readonly tasks = new Map<string, TranscriptTask>();
  protected readonly shellTasks = new Map<string, string>();

  constructor(lookups?: import("./projectorTypes").ProjectorLookups) {
    super(lookups);
  }

  protected onTaskNotified(event: {
    notificationType: string;
    title: string;
    body: string;
    severity: string;
    sourceKind: string;
    sourceId: string;
  }): TranscriptOperation[] {
    const step = this.currentStep;
    const turn = this.currentTurn;
    const midTurn =
      step !== undefined &&
      turn !== undefined &&
      step.state === "running" &&
      turn.state === "running";
    if (!midTurn) return [];
    const frame: TextFrame = {
      kind: "text",
      frameId: `${step.stepId}.f${++this.frameOrdinal}`,
      role: "user",
      text: `${event.title}\n${event.body}`.trim(),
      taskId: event.sourceId,
    };
    return [
      { op: "frame.upsert", turnId: turn.turnId, stepId: step.stepId, frame },
    ];
  }

  protected onTaskLifecycle(event: {
    type: "task.started" | "task.terminated";
    info: {
      taskId: string;
      kind: string;
      description: string;
      status: TranscriptTask["state"];
      detached?: boolean;
      agentId?: string;
      startedAt: number;
      endedAt: number | null;
    };
  }): TranscriptOperation[] {
    const { info } = event;
    const task = this.upsertTask(info.taskId, (prev) => ({
      taskId: info.taskId,
      kind: mapTaskKind(info.kind),
      state: info.status,
      // `detached` is false while a tool call waits in the foreground; legacy
      // records omit the flag and are treated as detached (see AgentTaskInfoBase).
      detached: info.detached ?? prev?.detached ?? true,
      description: info.description,
      agentId: info.agentId ?? prev?.agentId,
      outputTail: prev?.outputTail ?? "",
      startedAt: prev?.startedAt ?? epochMsToIso(info.startedAt),
      endedAt:
        info.endedAt === null ? prev?.endedAt : epochMsToIso(info.endedAt),
    }));
    const ops: TranscriptOperation[] = [{ op: "task.upsert", task }];
    if (event.type === "task.started") {
      ops.push({
        op: "taskref.upsert",
        item: {
          kind: "taskref",
          refId: `ref-${info.taskId}`,
          taskId: info.taskId,
          at: nowIso(),
        },
      });
    }
    return ops;
  }

  protected onShellStarted(event: {
    commandId: string;
    taskId: string;
  }): TranscriptOperation[] {
    this.shellTasks.set(event.commandId, event.taskId);
    // Known limitation: the `shell.*` payloads carry no command text (see
    // `shellCommandService.ts`), so shell-task descriptions stay empty in v1.
    const task = this.upsertTask(event.taskId, (prev) => ({
      taskId: event.taskId,
      kind: "shell",
      state: "running",
      detached: prev?.detached ?? false,
      description: prev?.description,
      agentId: prev?.agentId,
      outputTail: prev?.outputTail ?? "",
      startedAt: prev?.startedAt ?? nowIso(),
      endedAt: prev?.endedAt,
    }));
    return [
      { op: "task.upsert", task },
      {
        op: "taskref.upsert",
        item: {
          kind: "taskref",
          refId: `ref-${event.taskId}`,
          taskId: event.taskId,
          at: nowIso(),
        },
      },
    ];
  }

  /**
   * Resolve the transcript task for a `shell.*` event: the id learned at
   * `shell.started`, else the id the event carries (mid-command attach), else
   * a synthetic per-command id. The fallback matters for commands that fail
   * before `onForegroundTaskStart` runs (Bash validation/spawn errors): their
   * events all arrive taskId-less, and dropping them would lose the stderr
   * and the terminal state of a command that did run.
   */
  protected shellTaskId(event: { commandId: string; taskId?: string }): string {
    const taskId =
      this.shellTasks.get(event.commandId) ??
      event.taskId ??
      `shell-${event.commandId}`;
    this.shellTasks.set(event.commandId, taskId);
    return taskId;
  }

  protected onShellOutput(event: {
    commandId: string;
    taskId?: string;
    update: { kind: string; text?: string };
  }): TranscriptOperation[] {
    const taskId = this.shellTaskId(event);
    // progress/status/custom updates carry no transcript text; only
    // stdout/stderr chunks append (see `toolUpdateSchema`).
    const text = event.update.text;
    if (typeof text !== "string" || text.length === 0) return [];
    const ops: TranscriptOperation[] = [];
    let task = this.tasks.get(taskId);
    if (task === undefined) {
      // Seed the task so the chunk has somewhere to land (the attach missed
      // `shell.started`, and the terminal upsert would otherwise clobber the
      // output with an empty tail) — plus its timeline taskref, exactly like
      // `onShellStarted` emits.
      task = this.upsertTask(taskId, (prev) => ({
        taskId,
        kind: "shell",
        state: "running",
        detached: prev?.detached ?? false,
        description: prev?.description,
        agentId: prev?.agentId,
        outputTail: prev?.outputTail ?? "",
        startedAt: prev?.startedAt ?? nowIso(),
        endedAt: prev?.endedAt,
      }));
      ops.push(
        { op: "task.upsert", task },
        {
          op: "taskref.upsert",
          item: {
            kind: "taskref",
            refId: `ref-${taskId}`,
            taskId,
            at: nowIso(),
          },
        },
      );
    }
    const offset = task.outputTail.length;
    this.tasks.set(taskId, { ...task, outputTail: task.outputTail + text });
    ops.push({ op: "append", target: { type: "task", taskId }, offset, text });
    return ops;
  }

  /**
   * `shell.completed` — terminal state for a foreground `!` command (the task
   * lifecycle never reports foreground tasks, so without this the transcript
   * task would stay 'running' forever). Detached runs report through
   * `task.*` instead.
   */
  protected onShellCompleted(event: {
    commandId: string;
    taskId?: string;
    isError: boolean;
  }): TranscriptOperation[] {
    const taskId = this.shellTaskId(event);
    const hadTask = this.tasks.has(taskId);
    const task = this.upsertTask(taskId, (prev) => ({
      taskId,
      kind: prev?.kind ?? "shell",
      state: event.isError ? "failed" : "completed",
      detached: prev?.detached ?? false,
      description: prev?.description,
      agentId: prev?.agentId,
      outputTail: prev?.outputTail ?? "",
      startedAt: prev?.startedAt ?? nowIso(),
      endedAt: nowIso(),
    }));
    const ops: TranscriptOperation[] = [{ op: "task.upsert", task }];
    if (!hadTask) {
      // The whole command was missed (only the completion arrived) — the
      // timeline still needs the taskref to render the task.
      ops.push({
        op: "taskref.upsert",
        item: { kind: "taskref", refId: `ref-${taskId}`, taskId, at: nowIso() },
      });
    }
    return ops;
  }

  protected upsertTask(
    taskId: string,
    build: (prev: TranscriptTask | undefined) => TranscriptTask,
  ): TranscriptTask {
    const task = build(this.tasks.get(taskId));
    this.tasks.set(taskId, task);
    return task;
  }

  // ---------------------------------------------------------------- subagents

  protected onSubagentSpawned(event: {
    subagentId: string;
    subagentName: string;
    parentToolCallId: string;
    description?: string;
    swarmIndex?: number;
    runInBackground: boolean;
  }): TranscriptOperation[] {
    const task = this.upsertTask(event.subagentId, (prev) => ({
      taskId: event.subagentId,
      kind: "subagent",
      state: "running",
      // `runInBackground` subagents are detached from birth; foreground runs
      // may flip `detached` later via the task lifecycle.
      detached: event.runInBackground,
      description: event.description ?? prev?.description,
      agentId: event.subagentId,
      outputTail: prev?.outputTail ?? "",
      startedAt: prev?.startedAt ?? nowIso(),
      endedAt: prev?.endedAt,
    }));
    const ops: TranscriptOperation[] = [{ op: "task.upsert", task }];
    // Link the spawning tool call to the new agent (Agent / AgentSwarm tool
    // frames). The spawned payload carries no task id of its own — the
    // subagent task above is keyed by the agent id instead. The lookup falls
    // back to store adoption for a call that started (and was backfilled)
    // before this projector attached.
    const hit =
      this.toolFrames.get(event.parentToolCallId) ??
      this.adoptToolFrame(event.parentToolCallId);
    if (hit !== undefined) {
      const ref: AgentRef = {
        agentId: event.subagentId,
        role: event.swarmIndex !== undefined ? "member" : "child",
      };
      const frame: ToolCallFrame = {
        ...hit.frame,
        agentRefs: [...(hit.frame.agentRefs ?? []), ref],
      };
      this.toolFrames.set(event.parentToolCallId, { ...hit, frame });
      ops.push({
        op: "frame.upsert",
        turnId: hit.turnId,
        stepId: hit.stepId,
        frame,
      });
    }
    return ops;
  }

  protected onSubagentRun(event: {
    type:
      | "subagent.started"
      | "subagent.completed"
      | "subagent.failed"
      | "subagent.suspended";
    subagentId: string;
    resultSummary?: string;
    usage?: StepUsage;
    error?: string;
    reason?: string;
  }): TranscriptOperation[] {
    // The transcript task vocabulary has no 'suspended' state; a suspended
    // subagent is still alive, so it reads as 'running' (with the raw
    // suspension observable through `stateReason` and the `subagent.suspended`
    // WS event). Only the event that carries a field updates it — an absent
    // field keeps the prior value.
    const state: TranscriptTask["state"] =
      event.type === "subagent.completed"
        ? "completed"
        : event.type === "subagent.failed"
          ? "failed"
          : "running";
    const task = this.upsertTask(event.subagentId, (prev) => ({
      taskId: event.subagentId,
      kind: "subagent",
      state,
      detached: prev?.detached ?? true,
      description: prev?.description,
      agentId: event.subagentId,
      outputTail: prev?.outputTail ?? "",
      startedAt: prev?.startedAt ?? nowIso(),
      endedAt:
        event.type === "subagent.completed" || event.type === "subagent.failed"
          ? nowIso()
          : prev?.endedAt,
      resultSummary: event.resultSummary ?? prev?.resultSummary,
      usage: event.usage ?? prev?.usage,
      error: event.error ?? prev?.error,
      stateReason: event.reason ?? prev?.stateReason,
    }));
    return [{ op: "task.upsert", task }];
  }
}

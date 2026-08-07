import type { ToolCallFrame, TranscriptOperation, TranscriptTodo } from "@moonshot-ai/transcript";
import { TODO_ENTITY_ID, TODO_LIST_TOOL_NAME, nowIso, parseToolArgs, todoWriteItems } from "./projectorMappings";
import type { ToolFrameRecord } from "./projectorTypes";
import { ProjectorTurnFrames } from "./projectorTurnFrames";

export abstract class ProjectorTools extends ProjectorTurnFrames {
  protected readonly toolFrames = new Map<string, ToolFrameRecord>();

  constructor(lookups?: import("./projectorTypes").ProjectorLookups) {
    super(lookups);
  }

  protected onToolCallDelta(event: {
    turnId: number;
    toolCallId: string;
    name?: string;
    argumentsPart?: string;
  }): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [];
    const prev = this.toolFrames.get(event.toolCallId);
    if (prev !== undefined) {
      const frame: ToolCallFrame = {
        ...prev.frame,
        inputText: (prev.frame.inputText ?? "") + (event.argumentsPart ?? ""),
      };
      this.toolFrames.set(event.toolCallId, { ...prev, frame });
      ops.push({
        op: "frame.upsert",
        turnId: prev.turnId,
        stepId: prev.stepId,
        frame,
      });
      return ops;
    }
    const turnId = `t${event.turnId}`;
    const step = this.ensureStep(turnId, ops);
    const frameId = `${step.stepId}.${event.toolCallId}`;
    const frame: ToolCallFrame = {
      kind: "tool",
      frameId,
      toolCallId: event.toolCallId,
      // The delta's name is optional (some providers stream arguments before
      // naming the call); the empty string converges at `tool.call.started`.
      name: event.name ?? "",
      state: "running",
      inputText: event.argumentsPart ?? "",
    };
    this.toolFrames.set(event.toolCallId, {
      turnId,
      stepId: step.stepId,
      frame,
    });
    ops.push({ op: "frame.upsert", turnId, stepId: step.stepId, frame });
    return ops;
  }

  /**
   * `tool.progress` — the newest execution update overwrites the frame's
   * `progress` (whole-frame upsert, as for every tool frame mutation).
   */
  protected onToolProgress(event: {
    toolCallId: string;
    update: ToolFrameProgress;
  }): TranscriptOperation[] {
    const hit =
      this.toolFrames.get(event.toolCallId) ??
      this.adoptToolFrame(event.toolCallId);
    // No frame to hang the update on (the attach raced the call and the
    // backfill has not landed either) — drop it; the terminal `tool.result`
    // still converges the frame.
    if (hit === undefined) return [];
    const frame: ToolCallFrame = {
      ...hit.frame,
      progress: {
        kind: event.update.kind,
        text: event.update.text,
        percent: event.update.percent,
        customKind: event.update.customKind,
        customData: event.update.customData,
      },
    };
    this.toolFrames.set(event.toolCallId, { ...hit, frame });
    return [
      { op: "frame.upsert", turnId: hit.turnId, stepId: hit.stepId, frame },
    ];
  }

  protected onToolCallStarted(event: {
    turnId: number;
    toolCallId: string;
    name: string;
    args: unknown;
    display?: unknown;
  }): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [];
    const turnId = `t${event.turnId}`;
    const step = this.ensureStep(turnId, ops);
    const frameId = `${step.stepId}.${event.toolCallId}`;
    const input = parseToolArgs(event.args);
    const frame: ToolCallFrame = {
      kind: "tool",
      frameId,
      toolCallId: event.toolCallId,
      name: event.name,
      state: "running",
      input,
      // Argument text accumulated from `tool.call.delta` before this event.
      inputText: this.toolFrames.get(event.toolCallId)?.frame.inputText,
      display: event.display,
      todoId:
        event.name === TODO_LIST_TOOL_NAME &&
        todoWriteItems(input) !== undefined
          ? TODO_ENTITY_ID
          : undefined,
    };
    this.toolFrames.set(event.toolCallId, {
      turnId,
      stepId: step.stepId,
      frame,
    });
    ops.push({ op: "frame.upsert", turnId, stepId: step.stepId, frame });
    return ops;
  }

  protected onToolResult(event: {
    toolCallId: string;
    output: unknown;
    isError?: boolean;
  }): TranscriptOperation[] {
    const hit =
      this.toolFrames.get(event.toolCallId) ??
      this.adoptToolFrame(event.toolCallId);
    if (hit === undefined) return [];
    const isError = event.isError === true;
    const frame: ToolCallFrame = {
      ...hit.frame,
      state: isError ? "error" : "done",
      output: event.output,
      error:
        isError && typeof event.output === "string" ? event.output : undefined,
    };
    this.toolFrames.set(event.toolCallId, { ...hit, frame });
    const ops: TranscriptOperation[] = [
      { op: "frame.upsert", turnId: hit.turnId, stepId: hit.stepId, frame },
    ];
    // A confirmed TodoList write replaces the global todo document (the frame
    // keeps its own point-in-time snapshot in `display`).
    if (!isError && frame.name === TODO_LIST_TOOL_NAME) {
      const items = todoWriteItems(frame.input);
      if (items !== undefined) {
        const todo: TranscriptTodo = {
          todoId: TODO_ENTITY_ID,
          items,
          updatedAt: nowIso(),
        };
        ops.push({ op: "todo.upsert", todo });
      }
    }
    return ops;
  }

  /**
   * Mid-bind adoption: the transcript may have attached after `tool.call.started`
   * (the backfill seeded the frame from the persisted assistant toolCalls) but
   * before `tool.result`. This projector's map is empty then and the result
   * would be dropped; adopt the seeded frame so the result lands where a live
   * observer put it.
   */
  protected adoptToolFrame(toolCallId: string): ToolFrameRecord | undefined {
    const hit = this.lookups?.toolFrame?.(toolCallId);
    if (hit === undefined) return undefined;
    this.toolFrames.set(toolCallId, hit);
    return hit;
  }
}

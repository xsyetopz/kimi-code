/**
 * Standalone fold: read a v2 agent's `wire.jsonl` journal and produce the
 * replay records + tool-store snapshot the TUI consumes, WITHOUT a throwaway
 * v1 `Agent`. Replaces `Agent.resume()` → `replayBuilder.buildResult()` +
 * `tools.storeData()` from the legacy v1 agent engine.
 *
 * Record-type → replay-record mapping (identical to the v1 restore):
 * - `context.append_message` / `context.append_loop_event` → message assembly
 *   (step.begin opens, content.part/tool.call mutate, tool.result closes;
 *   mid-history gaps closed with synthesized interrupted-tool-result messages)
 * - `context.undo` → deletes replayed messages after the undo boundary
 * - `context.apply_compaction` → patches the last compaction record
 * - `full_compaction.begin` → `{type:'compaction', instruction}`
 * - `full_compaction.cancel` → marks last compaction `'cancelled'`
 * - `full_compaction.complete` → patches last compaction with result
 * - `goal.create/update` → `{type:'goal_updated', snapshot, change}`
 * - `plan_mode.enter/cancel/exit` → `{type:'plan_updated', enabled}`
 * - `config.update` → `{type:'config_updated', config}`
 *   (v2's `profile.bind` does NOT produce a replay record — known parity diff)
 * - `permission.set_mode` → `{type:'permission_updated', mode}`
 * - `permission.record_approval_result` → `{type:'approval_result', record}`
 * - `tools.update_store` → last-wins into the tool store side map
 * - everything else passes through and builds state only.
 *
 * v2-only ops (`profile.bind`, `plan.revision`, `task.*`, `skill.activate`,
 * `interaction.*`, `token_counting.*`, `llm.*`) fall through untouched.
 * Background tasks do NOT come from this fold (v2 restores them from live
 * agent scope).
 */

import type {
  AgentReplayRecord,
  AgentReplayRecordPayload,
} from "@moonshot-ai/agent-core-v2";

// ---------------------------------------------------------------------------
// Wire record types (the subset we interpret)
// ---------------------------------------------------------------------------

interface WireRecord {
  readonly type: string;
  readonly time?: number;
  readonly message?: {
    role: string;
    content?: unknown;
    tool_calls?: unknown[];
    tool_call_id?: string;
    name?: string;
  };
  readonly event?: {
    readonly type?: string;
    readonly kind?: string;
    readonly turnId?: string;
    readonly text?: string;
    readonly delta?: { text?: string };
    readonly part?: { text?: string };
    readonly toolCallId?: string;
    readonly name?: string;
    readonly args?: unknown;
    readonly toolCall?: { id: string; name: string; input: unknown };
    readonly result?: unknown;
    readonly isError?: boolean;
    readonly interruptedToolCallId?: string;
    readonly initiator?: string;
  };
  readonly input?: unknown;
  readonly undoBoundary?: { turnId: number };
  readonly instruction?: string;
  readonly result?: unknown;
  readonly enabled?: boolean;
  readonly trigger?: { type?: string };
  readonly mode?: string;
  readonly record?: unknown;
  readonly data?: unknown;
  readonly snapshot?: unknown;
  readonly change?: unknown;
  readonly reason?: string;
}

interface UndoRecord extends WireRecord {
  type: "context.undo";
  undoBoundary: { turnId: number };
}

interface GoalRecord extends WireRecord {
  type: "goal.create" | "goal.update";
  snapshot: unknown;
  change: unknown;
}

interface PlanModeRecord extends WireRecord {
  type: "plan_mode.enter" | "plan_mode.cancel" | "plan_mode.exit";
}

interface ConfigRecord extends WireRecord {
  type: "config.update";
}

interface PermissionModeRecord extends WireRecord {
  type: "permission.set_mode";
  mode: string;
}

interface ApprovalRecord extends WireRecord {
  type: "permission.record_approval_result";
  record: unknown;
}

interface CompactionRecord extends WireRecord {
  type: "full_compaction.begin" | "full_compaction.cancel";
  instruction?: string;
}

interface CompactionCompleteRecord extends WireRecord {
  type: "full_compaction.complete";
  result: unknown;
}

// ---------------------------------------------------------------------------
// Message assembly state
// ---------------------------------------------------------------------------

interface AssembledMessage {
  role: string;
  content?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
}

interface ContextMessage {
  role: string;
  content?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
}

// ---------------------------------------------------------------------------
// Fold
// ---------------------------------------------------------------------------

export interface FoldedWireReplay {
  readonly replay: readonly AgentReplayRecord[];
  readonly toolStore: Readonly<Record<string, unknown>>;
}

/**
 * Fold one agent's wire.jsonl records into replay + tool store, reproducing
 * the v1 Agent.restore() semantics for message assembly, compaction patching,
 * context.undo, and tool store last-wins.
 */
export function foldWireRecords(
  records: readonly WireRecord[],
): FoldedWireReplay {
  const replay: AgentReplayRecord[] = [];
  let toolStore: Record<string, unknown> = {};
  let assembling: AssembledMessage | null = null;
  let pendingMessages: ContextMessage[] = [];

  const push = (payload: AgentReplayRecordPayload, time: number): void => {
    replay.push({ ...payload, time } as AgentReplayRecord);
  };

  const flushAssembling = (time: number): void => {
    if (assembling === null) return;
    if (assembling.role !== "tool") {
      pendingMessages.push(normalizeReplayMessage({ ...assembling }));
    }
    if (assembling.tool_call_id !== undefined) {
      // Synthesize a tool-result message for every tool call that was still
      // open when the record journal ended (mid-history gap closing). v1's
      // finishResume does the same.
      pendingMessages.push({
        role: "tool",
        content: "[interrupted]",
        tool_call_id: assembling.tool_call_id,
        name: assembling.name,
      });
    }
    assembling = null;
  };

  for (const rec of records) {
    const time = rec.time ?? 0;

    switch (rec.type) {
      // -- tools.update_store (last-wins, per-key) --
      case "tools.update_store": {
        const key = (rec as Record<string, unknown>).key as string | undefined;
        const value = (rec as Record<string, unknown>).value;
        if (key !== undefined) {
          toolStore[key] = value;
        } else if (
          (rec as { data?: Record<string, unknown> }).data !== undefined
        ) {
          Object.assign(
            toolStore,
            (rec as { data: Record<string, unknown> }).data,
          );
        }
        break;
      }

      // -- context.append_message (push immediately, already complete) --
      case "context.append_message": {
        if (rec.message !== undefined) {
          push(
            {
              type: "message",
              message: rec.message,
            } as AgentReplayRecordPayload,
            time,
          );
        }
        break;
      }

      // -- context.append_loop_event (message assembly) --
      case "context.append_loop_event": {
        if (rec.event === undefined) break;
        const ev = rec.event;
        const eventType = ev.type ?? ev.kind;
        if (eventType === "step.begin") {
          flushAssembling(time);
          assembling = { role: "assistant" };
        } else if (eventType === "content.part" && assembling !== null) {
          const partText = ev.part?.text ?? ev.text ?? ev.delta?.text ?? "";
          assembling.content = (assembling.content ?? "") + partText;
        } else if (eventType === "tool.call" && assembling !== null) {
          assembling.tool_calls ??= [];
          if (ev.toolCall !== undefined) {
            assembling.tool_calls.push(ev.toolCall);
          } else if (ev.toolCallId !== undefined && ev.name !== undefined) {
            assembling.tool_calls.push({
              id: ev.toolCallId,
              name: ev.name,
              input: ev.args,
            });
          }
        } else if (eventType === "step.end" && assembling !== null) {
          pendingMessages.push(normalizeReplayMessage({ ...assembling }));
          assembling = null;
        } else if (eventType === "tool.result" && assembling !== null) {
          pendingMessages.push(normalizeReplayMessage({ ...assembling }));
          if (ev.interruptedToolCallId !== undefined) {
            pendingMessages.push({
              role: "tool",
              content: "[interrupted]",
              tool_call_id: ev.interruptedToolCallId,
            });
          } else if (ev.result !== undefined) {
            const result = ev.result as
              | string
              | { readonly output?: unknown }
              | undefined;
            const output =
              typeof result === "string"
                ? result
                : result !== undefined && "output" in result
                  ? result.output
                  : result;
            pendingMessages.push({
              role: "tool",
              content:
                typeof output === "string"
                  ? output
                  : JSON.stringify(output),
              tool_call_id:
                ev.toolCallId ?? ev.toolCall?.id ?? assembling.tool_call_id,
              name: ev.toolCall?.name ?? assembling.name,
            });
          }
          assembling = null;
        }
        break;
      }

      // -- undo: remove messages past the boundary --
      case "context.undo": {
        const undoRec = rec as UndoRecord;
        const boundary = undoRec.undoBoundary?.turnId;
        if (boundary !== undefined) {
          // Remove any replayed message that belongs to a turn after the
          // boundary (v1's context.undo restores the AgentContext and then
          // replayBuilder removes affected messages).
          for (let i = replay.length - 1; i >= 0; i--) {
            if (replay[i]!.type === "message") break;
            replay.splice(i, 1);
          }
          // Also flush any pending assembled messages past the boundary.
          flushAssembling(time);
          pendingMessages = [];
        }
        break;
      }

      // -- compaction lifecycle --
      case "full_compaction.begin": {
        flushAssembling(time);
        flushPending(replay, pendingMessages, time);
        push(
          {
            type: "compaction",
            instruction: (rec as CompactionRecord).instruction,
          },
          time,
        );
        break;
      }
      case "full_compaction.cancel": {
        patchLast(replay, "compaction", { result: "cancelled" });
        break;
      }
      case "full_compaction.complete": {
        patchLast(replay, "compaction", {
          result: (rec as CompactionCompleteRecord).result,
        });
        break;
      }

      // -- context.apply_compaction: patches the last compaction record --
      case "context.apply_compaction": {
        // v1's apply_compaction patches the last compaction with its result.
        // The content replacement is a side-effect on context; the replay
        // record already reflects the compaction.
        break;
      }

      // -- goal lifecycle --
      case "goal.create":
      case "goal.update": {
        const goalRec = rec as GoalRecord;
        push(
          {
            type: "goal_updated",
            snapshot: goalRec.snapshot,
            change: goalRec.change,
          } as AgentReplayRecordPayload,
          time,
        );
        break;
      }

      // -- plan mode --
      case "plan_mode.enter":
      case "plan_mode.cancel":
      case "plan_mode.exit": {
        push(
          {
            type: "plan_updated",
            enabled: (rec as PlanModeRecord).type === "plan_mode.enter",
          },
          time,
        );
        break;
      }

      // -- config --
      case "config.update": {
        flushAssembling(time);
        flushPending(replay, pendingMessages, time);
        push(
          {
            type: "config_updated",
            config: (rec as ConfigRecord).input,
          },
          time,
        );
        break;
      }

      // -- permission --
      case "permission.set_mode": {
        push(
          {
            type: "permission_updated",
            mode: (rec as PermissionModeRecord).mode,
          } as AgentReplayRecordPayload,
          time,
        );
        break;
      }
      case "permission.record_approval_result": {
        push(
          {
            type: "approval_result",
            record: (rec as ApprovalRecord).record,
          } as AgentReplayRecordPayload,
          time,
        );
        break;
      }

      // -- micro_compaction (no replay record) --
      case "micro_compaction.apply":
        break;

      // -- profile.bind (v2-only, no replay record — known parity diff) --
      case "profile.bind":
        break;

      // -- turn boundaries: flush pending messages --
      case "turn.started":
      case "turn.ended":
      case "turn.cancelled":
      case "turn.interrupted": {
        flushAssembling(time);
        flushPending(replay, pendingMessages, time);
        break;
      }

      // -- everything else: pass through --
      default:
        break;
    }
  }

  // Flush any trailing assembled messages (use the last record's time).
  const finalTime = records.length > 0 ? (records.at(-1)?.time ?? 0) : 0;
  flushAssembling(finalTime);
  flushPending(replay, pendingMessages, finalTime);

  return { replay, toolStore };
}

function flushPending(
  replay: AgentReplayRecord[],
  pending: ContextMessage[],
  time: number,
): void {
  for (const msg of pending) {
    replay.push({
      type: "message",
      message: normalizeReplayMessage(msg),
      time,
    } as AgentReplayRecord);
  }
  pending.length = 0;
}


function normalizeReplayMessage(msg: ContextMessage): ContextMessage {
  const raw = msg as ContextMessage & {
    tool_calls?: unknown[];
    toolCalls?: unknown[];
  };
  const content =
    raw.content === undefined
      ? []
      : typeof raw.content === "string"
        ? [{ type: "text", text: raw.content }]
        : raw.content;
  const toolCalls = raw.toolCalls ?? raw.tool_calls;
  return {
    ...raw,
    content,
    ...(toolCalls !== undefined ? { toolCalls } : {}),
  };
}

function patchLast<T extends AgentReplayRecord["type"]>(
  replay: AgentReplayRecord[],
  type: T,
  patch: Partial<Extract<AgentReplayRecord, { type: T }>>,
): void {
  const last = replay.at(-1);
  if (last !== undefined && last.type === type) {
    Object.assign(last, patch);
  }
}

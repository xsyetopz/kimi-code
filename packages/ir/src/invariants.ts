import type {
  AssistantTurn,
  Conversation,
  ConversationRecord,
  ToolCall,
  ToolResult,
} from "./types";

export class IrInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IrInvariantError";
  }
}

function assertToolCallIdsStable(turn: AssistantTurn): void {
  const seen = new Set<string>();
  for (const call of turn.toolCalls) {
    if (!call.id) throw new IrInvariantError("ToolCall id must be non-empty");
    if (seen.has(call.id)) {
      throw new IrInvariantError(`Duplicate ToolCall id in turn: ${call.id}`);
    }
    seen.add(call.id);
    if (call.arguments === null || call.arguments === undefined) {
      throw new IrInvariantError(
        `ToolCall ${call.id} arguments must be assembled before use`,
      );
    }
  }
}

function collectCalls(records: Conversation): Map<string, ToolCall> {
  const map = new Map<string, ToolCall>();
  for (const r of records) {
    if (r.kind === "assistant") {
      for (const c of r.toolCalls) map.set(c.id, c);
    }
  }
  return map;
}

function collectResults(records: Conversation): ToolResult[] {
  return records.filter((r): r is ToolResult => r.kind === "tool_result");
}

/**
 * Fail-closed conversation invariant check (ARCHITECTURE invariants 1–4, 6).
 */
export function assertConversationInvariants(records: Conversation): void {
  const calls = collectCalls(records);
  const results = collectResults(records);
  const resultByCall = new Map<string, ToolResult>();

  for (const turn of records) {
    if (turn.kind === "assistant") {
      assertToolCallIdsStable(turn);
      if (
        turn.reasoning.mode !== "none" &&
        turn.reasoning.mode !== "opaque" &&
        turn.reasoning.mode !== "exposed"
      ) {
        const _exhaustive: never = turn.reasoning.mode;
        throw new IrInvariantError(`Invalid reasoning mode: ${_exhaustive}`);
      }
      if (
        turn.reasoning.mode === "opaque" &&
        !turn.reasoning.opaque &&
        !turn.reasoning.providerPayload
      ) {
        throw new IrInvariantError(
          "Opaque reasoning must retain opaque payload or providerPayload",
        );
      }
    }
  }

  for (const result of results) {
    if (!calls.has(result.callId)) {
      throw new IrInvariantError(
        `ToolResult ${result.id} references unknown ToolCall ${result.callId}`,
      );
    }
    if (resultByCall.has(result.callId)) {
      throw new IrInvariantError(
        `Multiple ToolResults for ToolCall ${result.callId}`,
      );
    }
    resultByCall.set(result.callId, result);
  }
}

export function isConversationRecord(
  value: unknown,
): value is ConversationRecord {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  return (
    kind === "system" ||
    kind === "user" ||
    kind === "assistant" ||
    kind === "tool_result" ||
    kind === "compact_checkpoint"
  );
}

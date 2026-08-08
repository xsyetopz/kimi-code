import { describe, expect, it } from "vitest";
import {
  applyStreamEvent,
  assembleAssistantTurn,
  assertConversationInvariants,
  createTurnAssembler,
  IrInvariantError,
  type Conversation,
} from "../src/index";

describe("ir invariants", () => {
  it("accepts matching tool call and result", () => {
    const records: Conversation = [
      {
        kind: "assistant",
        id: "a1",
        text: [],
        reasoning: { mode: "none" },
        toolCalls: [{ id: "c1", name: "bash", arguments: '{"cmd":"ls"}' }],
        preserved: {},
      },
      {
        kind: "tool_result",
        id: "r1",
        callId: "c1",
        content: "ok",
        isError: false,
      },
    ];
    expect(() => assertConversationInvariants(records)).not.toThrow();
  });

  it("rejects orphan tool result", () => {
    const records: Conversation = [
      {
        kind: "tool_result",
        id: "r1",
        callId: "missing",
        content: "x",
        isError: false,
      },
    ];
    expect(() => assertConversationInvariants(records)).toThrow(
      IrInvariantError,
    );
  });
});

describe("turn assembler", () => {
  it("assembles text and tool calls from canonical events", () => {
    const state = createTurnAssembler();
    for (const event of [
      { type: "response.start" as const },
      { type: "text.start" as const },
      { type: "text.delta" as const, text: "Hi" },
      { type: "text.end" as const },
      { type: "tool.start" as const, id: "t1", name: "read" },
      {
        type: "tool.arguments.delta" as const,
        id: "t1",
        argumentsDelta: '{"path":',
      },
      {
        type: "tool.arguments.delta" as const,
        id: "t1",
        argumentsDelta: '"a.ts"}',
      },
      { type: "tool.end" as const, id: "t1" },
      { type: "response.end" as const },
    ]) {
      applyStreamEvent(state, event);
    }
    const turn = assembleAssistantTurn(state, "asst-1");
    expect(turn.text).toEqual(["Hi"]);
    expect(turn.toolCalls).toEqual([
      { id: "t1", name: "read", arguments: '{"path":"a.ts"}' },
    ]);
    expect(turn.partial).toBe(false);
  });
});

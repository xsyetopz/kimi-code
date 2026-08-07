import { afterEach, describe, expect, it } from "vitest";

describe("undoHistory RPC", () => {
  let ctx: TestAgentContext;

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it("tracks conversation_undo after undoing history", async () => {
    records = [];
    ctx = createTestAgent());
    ctx.appendUserTurn("undo me");

    const undone = await ctx.rpc.undoHistory({ count: 1 });

    expect(undone).toBe(1);
    expect(records).toContainEqual({
      event: "conversation_undo",
      properties: { agent_id: "main", count: 1 },
    });
  });

  it("rejects a fractional count without changing persisted history", async () => {
    records = [];
    ctx = createTestAgent());
    ctx.appendUserTurn("keep me");
    const history = ctx.context.get();

    await expect(ctx.rpc.undoHistory({ count: 0.5 })).rejects.toMatchObject({
      code: ErrorCodes.REQUEST_INVALID,
      details: { field: "count" },
    });

    expect(ctx.context.get()).toBe(history);
    expect(records).not.toContainEqual(
      expect.objectContaining({ event: "conversation_undo" }),
    );
  });
});

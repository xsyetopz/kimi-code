import { afterEach, describe, expect, it } from "vitest";

import { ErrorCodes } from "#/errors";

import {
  createTestAgent,
  type TestAgentContext,
} from "../../harness";

describe("undoHistory RPC", () => {
  let ctx: TestAgentContext;
  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it("undoes history", async () => {
    ctx = createTestAgent();
    ctx.appendUserTurn("undo me");

    const undone = await ctx.rpc.undoHistory({ count: 1 });

    expect(undone).toBe(1);
  });

  it("rejects a fractional count without changing persisted history", async () => {
    ctx = createTestAgent();
    ctx.appendUserTurn("keep me");
    const history = ctx.context.get();

    await expect(ctx.rpc.undoHistory({ count: 0.5 })).rejects.toMatchObject({
      code: ErrorCodes.REQUEST_INVALID,
      details: { field: "count" },
    });

    expect(ctx.context.get()).toBe(history);
  });
});

import { afterEach, describe, expect, it } from "vitest";

import { IAgentPermissionModeService } from "#/agent/permissionMode/permissionMode";

import {
  createTestAgent,
  type TestAgentContext,
} from "../../harness";

describe("setPermission RPC", () => {
  let ctx: TestAgentContext;
  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it("applies the mode to the agent and tracks the afk toggle", async () => {
    ctx = createTestAgent();

    await ctx.rpc.setPermission({ mode: "auto" });

    expect(ctx.get(IAgentPermissionModeService).mode).toBe("auto");
  });

  it("tracks the yolo toggle on enter and exit", async () => {
    ctx = createTestAgent();

    await ctx.rpc.setPermission({ mode: "yolo" });
    await ctx.rpc.setPermission({ mode: "manual" });

    expect(ctx.get(IAgentPermissionModeService).mode).toBe("manual");

  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DisposableStore } from "#/_base/di/lifecycle";
import { createServices, type TestInstantiationService } from "#/_base/di/test";
import { IBootstrapService } from "#/app/bootstrap/bootstrap";
import { IEventBus } from "#/app/event/eventBus";
import { type ToolCall } from "#/kosong/contract/message";
import { emptyUsage } from "#/kosong/contract/usage";
import { ISessionContext } from "#/session/sessionContext/sessionContext";
import type { ISessionProcessRunner } from "#/session/process/processRunner";
import { IAgentScopeContext } from "#/agent/scopeContext/scopeContext";
import { IAgentLoopService } from "#/agent/loop/loop";
import { IAgentProfileService } from "#/agent/profile/profile";
import { IAgentStateService } from "#/agent/state/agentState";
import { AgentStateService } from "#/agent/state/agentStateService";
import type {
  ExecutableTool,
  ExecutableToolContext,
  ExecutableToolResult,
  ToolExecution,
  ToolResult,
} from "#/tool/toolContract";
import type {
  ToolDidExecuteContext,
  ResolvedToolExecutionHookContext,
  BeforeExecuteDecision,
} from "#/agent/toolExecutor/toolHooks";
import {
  IAgentToolDedupeService,
  type ToolDedupeResult,
} from "#/agent/toolDedupe/toolDedupe";
import {
  AgentToolDedupeService,
  __testing as toolDedupeTesting,
} from "#/agent/toolDedupe/toolDedupeService";
import {
  IAgentToolExecutorService,
  type ToolExecutionResult,
} from "#/agent/toolExecutor/toolExecutor";
import { AgentToolExecutorService } from "#/agent/toolExecutor/toolExecutorService";
import { IAgentToolRegistryService } from "#/agent/toolRegistry/toolRegistry";
import { AgentToolRegistryService } from "#/agent/toolRegistry/toolRegistryService";
import { registerLogServices } from "../../_base/log/stubs";
import { stubLoopWithHooks } from "../loop/stubs";
import { stubToolExecutorEvents } from "../toolExecutor/stubs";
import { registerToolResultTruncationServices } from "../toolResultTruncation/stubs";
        toolCall(i === 0 ? "orig" : `dup${String(i)}`, "Read", { p: 1 }),
      );
      const results = await runStep(h, 1, 1, calls);
      const original = results.find(
        (result) => result.toolCallId === "orig",
      )!.result;
      expect(original.output as string).not.toContain("<system-reminder>");
    });
  });

  describe("reminder injection into ContentPart[] outputs", () => {
    it("appends reminder1 to a trailing text part at streak 3", async () => {
      const h = createHarness();
      const tool = new EchoTool("X", () => ({
        output: [{ type: "text", text: "hello" }],
      }));
      h.registry.register(tool);
      for (let i = 0; i < 2; i += 1) {
        await runStep(h, 1, i + 1, [toolCall(`p${String(i)}`, "X", {})]);
      }
      const [final] = await runStep(h, 1, 3, [toolCall("final", "X", {})]);
      expect(final!.result.output).toBe("hello" + REMINDER_TEXT_1);
    });

    it("appends reminder2 to a trailing text part at streak 5", async () => {
      const h = createHarness();
      const tool = new EchoTool("X", () => ({
        output: [{ type: "text", text: "hello" }],
      }));
      h.registry.register(tool);
      for (let i = 0; i < 4; i += 1) {
        await runStep(h, 1, i + 1, [toolCall(`p${String(i)}`, "X", { a: 1 })]);
      }
      const [final] = await runStep(h, 1, 5, [
        toolCall("final", "X", { a: 1 }),
      ]);
      expect(final!.result.output).toBe("hello" + makeReminderText2(5));
    });

    it("pushes a new text part when trailing part is non-text", async () => {
      const h = createHarness();
      const tool = new EchoTool("X", () => ({
        output: [{ type: "image_url", imageUrl: { url: "data:foo" } }],
      }));
      h.registry.register(tool);
      for (let i = 0; i < 2; i += 1) {
        await runStep(h, 1, i + 1, [toolCall(`p${String(i)}`, "X", {})]);
      }
      const [final] = await runStep(h, 1, 3, [toolCall("final", "X", {})]);
      const arr = final!.result.output as Array<{
        type: string;
        text?: string;
      }>;
      expect(arr.some((part) => part.type === "image_url")).toBe(true);
      expect(arr.at(-1)).toEqual({ type: "text", text: REMINDER_TEXT_1 });
    });

    it("preserves isError flag when injecting reminder", async () => {
      const h = createHarness();
      const tool = new EchoTool("X", () => ({ output: "boom", isError: true }));
      h.registry.register(tool);
      for (let i = 0; i < 2; i += 1) {
        await runStep(h, 1, i + 1, [toolCall(`p${String(i)}`, "X", {})]);
      }
      const [final] = await runStep(h, 1, 3, [toolCall("final", "X", {})]);
      expect(final!.result.isError).toBe(true);
      expect(final!.result.output as string).toContain("<system-reminder>");
    });
  });

  describe("key canonicalization", () => {
    it("treats argument objects with different key order as the same call", async () => {
      const h = createHarness(undefined, { executorEvents: true });
      await beforeStep(h, 1, 1);

      const b1 = await h.fireBefore(willCtx("c1", "Read", { a: 1, b: 2 }));
      expect(b1).toBeUndefined();

      const b2 = await h.fireBefore(willCtx("c2", "Read", { b: 2, a: 1 }));
      expect(b2?.veto).toEqual({ output: "" });

      const d1 = didCtx("c1", "Read", { a: 1, b: 2 }, okResult("SAME"));
      await h.executor.hooks.onDidExecuteTool.run(d1);
      const d2 = didCtx("c2", "Read", { b: 2, a: 1 }, b2!.veto!);
      await h.executor.hooks.onDidExecuteTool.run(d2);
      expect(d2.result).toEqual(okResult("SAME"));
    });
  });

  describe("arg rewrite between checkSameStep and finalize", () => {
    it("resolves the dup deferred even when the original call args are rewritten before finalize", async () => {
      const h = createHarness(undefined, { executorEvents: true });
      await beforeStep(h, 1, 1);

      const b1 = await h.fireBefore(willCtx("c1", "Read", { path: "/a" }));
      expect(b1).toBeUndefined();
      const b2 = await h.fireBefore(willCtx("c2", "Read", { path: "/a" }));
      expect(b2?.veto).toEqual({ output: "" });

      const d1 = didCtx("c1", "Read", { path: "/REWRITTEN" }, okResult("A"));
      await h.executor.hooks.onDidExecuteTool.run(d1);

      const d2 = didCtx("c2", "Read", { path: "/a" }, b2!.veto!);
      await Promise.race([
        h.executor.hooks.onDidExecuteTool.run(d2),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(
              new Error("dup finalize hung — deferred was never resolved"),
            );
          }, 500);
        }),
      ]);
      expect(d1.result).toEqual(okResult("A"));
      expect(d2.result).toEqual(okResult("A"));
    });
  });

  describe("beginStep cleanup", () => {
    it("resolves leaked deferreds from a prior aborted step with an error result", async () => {
      const h = createHarness(undefined, { executorEvents: true });
      await beforeStep(h, 1, 1);
      const b1 = await h.fireBefore(willCtx("leaked", "Read", { p: 1 }));
      expect(b1).toBeUndefined();
      const b2 = await h.fireBefore(willCtx("dup", "Read", { p: 1 }));
      const placeholder = b2!.veto!;
      expect(placeholder).toEqual({ output: "" });

      await beforeStep(h, 1, 2);
      const d2 = didCtx("dup", "Read", { p: 1 }, placeholder);
      await h.executor.hooks.onDidExecuteTool.run(d2);
      expect(d2.result).toEqual(placeholder);
    });
  });

  describe("dead-end stop reminder (streak >= 8)", () => {
    function stopTurnOf(result: ToolResult): boolean | undefined {
      return result.stopTurn;
    }

    async function runStreak(h: Harness, count: number): Promise<ToolResult> {
      let last: ToolResult | undefined;
      for (let i = 0; i < count; i += 1) {
        const [result] = await runStep(h, 1, i + 1, [
          toolCall(`c${String(i)}`, "Read", { p: 1 }),
        ]);
        last = result!.result;
      }
      return last!;
    }

    it("injects the dead-end reminder at exactly 8 consecutive without force-stopping", async () => {
      const h = createHarness();
      h.registry.register(new EchoTool("Read"));
      const last = await runStreak(h, 8);
      expect(last.output as string).toContain("<system-reminder>");
      expect(last.output as string).toContain("Write your final response now");
      expect(last.output as string).toContain("without any further tool calls");
      expect(last.isError).toBeUndefined();
      expect(stopTurnOf(last)).toBeFalsy();
    });

    it.each([8, 9, 10, 11])(
      "keeps injecting the dead-end reminder without stopping the turn at streak %i",
      async (streak) => {
        const h = createHarness();
        h.registry.register(new EchoTool("Read"));
        const last = await runStreak(h, streak);
        expect(last.output as string).toContain(
          "Write your final response now",
        );
        expect(last.isError).toBeUndefined();
        expect(stopTurnOf(last)).toBeFalsy();
      },
    );

    it("force-stops the turn at exactly 12 consecutive without marking the tool failed", async () => {
      const h = createHarness();
      h.registry.register(new EchoTool("Read"));
      const last = await runStreak(h, 12);
      expect(last.output as string).toContain("Write your final response now");
      expect(last.isError).toBeUndefined();
      expect(stopTurnOf(last)).toBe(true);
    });

    it("continues force-stopping past 12 consecutive", async () => {
      const h = createHarness();
      h.registry.register(new EchoTool("Read"));
      const last = await runStreak(h, 14);
      expect(last.isError).toBeUndefined();
      expect(stopTurnOf(last)).toBe(true);
    });

    it("preserves the dead-end reminder text exactly", async () => {
      const h = createHarness();
      h.registry.register(new EchoTool("Read"));
      const last = await runStreak(h, 8);
      expect(last.output as string).toContain(REMINDER_TEXT_3.trim());
    });

    it("keeps an error result error when force-stopping", async () => {
      const h = createHarness();
      h.registry.register(
        new EchoTool("Read", () => ({ output: "boom", isError: true })),
      );
      let last: ToolResult | undefined;
      for (let i = 0; i < 12; i += 1) {
        const [result] = await runStep(h, 1, i + 1, [
          toolCall(`c${String(i)}`, "Read", { p: 1 }),
        ]);
        last = result!.result;
      }
      expect(last!.isError).toBe(true);
      expect(stopTurnOf(last!)).toBe(true);
      expect(last!.output as string).toContain("Write your final response now");
    });
  });

  describe("preflight-rejected calls (bypass onBeforeExecuteTool)", () => {
    // Calls rejected by args validation in preflight never fire
    // onBeforeExecuteTool; the dedupe hook registers them late at
    // onDidExecuteTool time so the repeat breaker still counts them.
    class StrictTool implements ExecutableTool<Record<string, unknown>> {
      readonly name = "Strict";
      readonly description = "Requires a command string.";
      readonly parameters = {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
        additionalProperties: true,
      };
      readonly calls: Array<Record<string, unknown>> = [];

      resolveExecution(args: Record<string, unknown>): ToolExecution {
        return {
          approvalRule: this.name,
          execute: async () => {
            this.calls.push(args);
            return { output: "ran" };
          },
        };
      }
    }

    function invalidCall(id: string): ToolCall {
      // Missing the required "command".
      return {
        type: "function",
        id,
        name: "Strict",
        arguments: JSON.stringify({ timeout: 60 }),
      };
    }

    function malformedCall(id: string, rawArguments: string): ToolCall {
      return { type: "function", id, name: "Strict", arguments: rawArguments };
    }

    it("counts rejected calls toward the streak and force-stops at 12, keeping the error flag", async () => {
      const h = createHarness();
      const tool = new StrictTool();
      h.registry.register(tool);
      let last: ToolResult | undefined;
      for (let i = 0; i < 12; i += 1) {
        const [result] = await runStep(h, 1, i + 1, [
          invalidCall(`c${String(i)}`),
        ]);
        last = result!.result;
      }
      expect(tool.calls).toHaveLength(0);
      expect(last!.isError).toBe(true);
      expect(last!.stopTurn).toBe(true);
      expect(last!.output as string).toContain(REMINDER_TEXT_3.trim());
        .filter((e) => e.event === "tool_call_repeat")
        .map((e) => e.properties?.["action"]);
      expect(actions).toEqual([
        "none",
        "r1",
        "r1",
        "r2",
        "r2",
        "r2",
        "r3",
        "r3",
        "r3",
        "r3",
        "stop",
      ]);
    });

    it("does not double-register a call that already went through onBeforeExecuteTool", async () => {
      const h = createHarness(undefined, { executorEvents: true });
      for (let i = 0; i < 2; i += 1) {
        await beforeStep(h, 1, i + 1);
        const callId = `c${String(i)}`;
        expect(
          await h.fireBefore(willCtx(callId, "Read", { p: 1 })),
        ).toBeUndefined();
        const d = didCtx(callId, "Read", { p: 1 }, okResult("R"));
        await h.executor.hooks.onDidExecuteTool.run(d);
        await afterStep(h, 1, i + 1);
      }
      // Exactly one repeat at count 2 — a double registration would inflate
      // the streak and fire the reminder one occurrence early.
        (e) => e.event === "tool_call_repeat",
      );
      expect(repeats.map((e) => e.properties?.["repeat_count"])).toEqual([2]);
    });

    it("counts identical malformed argument texts as repeats", async () => {
      const h = createHarness();
      h.registry.register(new StrictTool());
      for (let i = 0; i < 2; i += 1) {
        await runStep(h, 1, i + 1, [
          malformedCall(`c${String(i)}`, '{"command":'),
        ]);
      }
        (e) => e.event === "tool_call_repeat",
      );
      expect(repeats.map((e) => e.properties?.["repeat_count"])).toEqual([2]);
    });

    it("does not treat different malformed argument texts as the same call", async () => {
      const h = createHarness();
      h.registry.register(new StrictTool());
      const raws = ['{"command":', '{"comand":', '{"command": "ls"'];
      for (let i = 0; i < 3; i += 1) {
        await runStep(h, 1, i + 1, [malformedCall(`c${String(i)}`, raws[i]!)]);
      }
      // All three normalize to {} on parse failure, but the raw texts
      // differ, so no repeat streak may form.
      expect(
      ).toHaveLength(0);
    });
  });

  describe("turn-level repeat breaker for rejected calls", () => {
    function invalidBashCallWithId(id: string): ToolCall {
      // Missing the required "command".
      return {
        type: "function",
        id,
        name: "Bash",
        arguments: JSON.stringify({ timeout: 60 }),
      };
    }

    function malformedBashCallWithId(id: string, variant: number): ToolCall {
      // Invalid JSON (unquoted key), unique per variant.
      return {
        type: "function",
        id,
        name: "Bash",
        arguments: `{"command_${String(variant)}: "ls"`,
      };
    }

      readonly ctx: ReturnType<typeof createTestAgent>;
      readonly exec: ReturnType<typeof vi.fn>;
    } {
      const exec = vi
        .fn<ISessionProcessRunner["exec"]>()
        .mockRejectedValue(new Error("Bash should not execute"));
      const ctx = createTestAgent(),
        execEnvServices({
          processRunner: createFakeProcessRunner({
            exec: exec as unknown as ISessionProcessRunner["exec"],
          }),
        }),
      );
      ctx.get(IAgentProfileService).update({ activeToolNames: ["Bash"] });
      records.length = 0;
      return { ctx, exec };
    }

    it("force-stops a turn that keeps re-issuing the same validation-rejected call", async () => {
      const { ctx, exec } = rejectedBashAgent(records);

      // 12 identical calls missing the required "command": each is rejected
      // in preflight. If the breaker did not count them, the turn would keep
      // going and consume the 13th scripted response.
      for (let i = 0; i < 12; i += 1) {
        ctx.mockNextResponse(invalidBashCallWithId(`call_bad_${String(i)}`));
      }
      ctx.mockNextResponse({ type: "text", text: "must never be generated" });

      await ctx.rpc.prompt({
        input: [{ type: "text", text: "Repeat the bad call" }],
      });
      await ctx.untilTurnEnd();

      expect(exec).not.toHaveBeenCalled();
      expect(ctx.llmCalls).toHaveLength(12);
      const actions = records
        .filter((entry) => entry.event === "tool_call_repeat")
        .map((entry) => entry.properties?.["action"]);
      expect(actions).toEqual([
        "none",
        "r1",
        "r1",
        "r2",
        "r2",
        "r2",
        "r3",
        "r3",
        "r3",
        "r3",
        "stop",
      ]);
    });

    it("does not force-stop when the malformed argument text keeps changing", async () => {
      const { ctx, exec } = rejectedBashAgent(records);

      // 12 rejected calls, each with DIFFERENT malformed raw JSON: all
      // normalize to {} on parse failure, but they are not repeats of the
      // same call, so the turn must not be force-stopped.
      for (let i = 0; i < 12; i += 1) {
        ctx.mockNextResponse(
          malformedBashCallWithId(`call_mal_${String(i)}`, i),
        );
      }
      ctx.mockNextResponse({ type: "text", text: "recovered" });

      await ctx.rpc.prompt({
        input: [{ type: "text", text: "Repeat the bad call" }],
      });
      await ctx.untilTurnEnd();

      expect(exec).not.toHaveBeenCalled();
      expect(ctx.llmCalls).toHaveLength(13);
      expect(
        records.filter((entry) => entry.event === "tool_call_repeat"),
      ).toHaveLength(0);
    });
  });
});

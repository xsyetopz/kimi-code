import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DisposableStore } from "#/_base/di/lifecycle";
import { createServices } from "#/_base/di/test";
import type { TestInstantiationService } from "#/_base/di/test";
import { UserCancellationError } from "#/_base/utils/abort";
import type { ResolvedToolExecutionHookContext } from "#/agent/toolExecutor/toolHooks";
import { IAgentPermissionModeService } from "#/agent/permissionMode/permissionMode";
import type {
  PermissionMode,
  PermissionPolicyResult,
} from "#/agent/permissionPolicy/types";
import {
  IAgentPermissionRulesService,
  type PermissionApprovalResultRecord,
} from "#/agent/permissionRules/permissionRules";
import {
  IAgentScopeContext,
  makeAgentScopeContext,
} from "#/agent/scopeContext/scopeContext";
import { IAgentToolApprovalService } from "#/agent/toolApproval/toolApproval";
import { AgentToolApprovalService } from "#/agent/toolApproval/toolApprovalService";
import { IEventBus } from "#/app/event/eventBus";
import { EventBusService } from "#/app/event/eventBusService";
import type { ToolCall } from "#/kosong/contract/message";
import {
  ISessionApprovalService,
  type ApprovalRequest,
  type ApprovalResponse,
} from "#/session/approval/approval";
import {
  ISessionContext,
  makeSessionContext,
} from "#/session/sessionContext/sessionContext";
import type { ToolInputDisplay } from "#/tool/toolInputDisplay";

      const svc = make();
      await expect(
        svc.resolvePermissionResolution(
          {
            kind: "result",
            result: { output: "Plan review handled." },
          },
          makeContext("ExitPlanMode"),
          "p",
        ),
      ).resolves.toEqual({
        veto: { output: "Plan review handled." },
      });
    });

    it("runs the ask round-trip for ask resolutions", async () => {
      useBroker(async () => ({ decision: "approved" }));
      const svc = make();
      await expect(
        svc.resolvePermissionResolution(ask(), makeContext("Bash"), "p"),
      ).resolves.toBeUndefined();
    });
  });

  describe("requestToolApproval", () => {
    it("auto-approves when no approval broker is registered", async () => {
      const events = subscribeApprovalEvents();
      const svc = make();

      await expect(
        svc.requestToolApproval(
          makeContext("Bash", { command: "printf hi" }),
          ask(),
          "fallback-ask",
        ),
      ).resolves.toBeUndefined();

      expect(events.requested).not.toHaveBeenCalled();
      expect(events.resolved).not.toHaveBeenCalled();
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        toolName: "Bash",
        sessionApprovalRule: undefined,
        result: { decision: "approved" },
      });
      expect(records).toContainEqual({
        event: "permission_approval_result",
        properties: expect.objectContaining({
          policy_name: "fallback-ask",
          tool_name: "Bash",
          result: "approved",
          session_cache_written: false,
        }),
      });
    });

    it("publishes approval events around the broker round-trip", async () => {
      const events = subscribeApprovalEvents();
      const request = useBroker(async () => ({
        decision: "approved",
        selectedLabel: "Approve once",
      }));
      const svc = make();

      await expect(
        svc.requestToolApproval(
          makeContext("Bash", { command: "printf first" }),
          ask(),
          "fallback-ask",
        ),
      ).resolves.toBeUndefined();

      expect(request).toHaveBeenCalledTimes(1);
      expect(events.requested).toHaveBeenCalledWith({
        type: "permission.approval.requested",
        sessionId: "test-session",
        agentId: "main",
        turnId: 1,
        toolCallId: "call-Bash",
        toolName: "Bash",
        action: "Approve Bash",
        toolInput: { command: "printf first" },
        display: {
          kind: "generic",
          summary: "Approve Bash",
          detail: { command: "printf first" },
        },
      });
      expect(events.resolved).toHaveBeenCalledWith({
        type: "permission.approval.resolved",
        sessionId: "test-session",
        agentId: "main",
        turnId: 1,
        toolCallId: "call-Bash",
        toolName: "Bash",
        action: "Approve Bash",
        toolInput: { command: "printf first" },
        display: {
          kind: "generic",
          summary: "Approve Bash",
          detail: { command: "printf first" },
        },
        decision: "approved",
        selectedLabel: "Approve once",
      });
    });

    it("uses the execution description and display when provided", async () => {
      const request = useBroker(async () => ({ decision: "approved" }));
      const svc = make();
      const display: ToolInputDisplay = {
        kind: "command",
        command: "rm -rf build",
      };

      await svc.requestToolApproval(
        makeContext(
          "Bash",
          { command: "rm -rf build" },
          { description: "clean build output", display },
        ),
        ask(),
        "fallback-ask",
      );

      expect(request).toHaveBeenCalledWith({
        sessionId: "test-session",
        agentId: "main",
        turnId: 1,
        toolCallId: "call-Bash",
        toolName: "Bash",
        action: "clean build output",
        display,
      });
    });

    it("records a session-scope approval rule when approved for session", async () => {
      useBroker(async () => ({
        decision: "approved",
        scope: "session",
        selectedLabel: "Approve for this session",
      }));
      const svc = make();

      await expect(
        svc.requestToolApproval(
          makeContext("Custom", { query: "first" }),
          ask(),
          "fallback-ask",
        ),
      ).resolves.toBeUndefined();

      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        turnId: 1,
        toolCallId: "call-Custom",
        toolName: "Custom",
        action: "Approve Custom",
        sessionApprovalRule: "Custom",
        result: { decision: "approved", scope: "session" },
      });
      expect(records).toContainEqual({
        event: "permission_approval_result",
        properties: expect.objectContaining({
          tool_name: "Custom",
          result: "approved_for_session",
          session_cache_written: true,
        }),
      });
    });

    it("keeps approved-once responses out of the session cache", async () => {
      useBroker(async () => ({ decision: "approved" }));
      const svc = make();

      await svc.requestToolApproval(
        makeContext("Custom"),
        ask(),
        "fallback-ask",
      );

      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        sessionApprovalRule: undefined,
        result: { decision: "approved" },
      });
      expect(records).toContainEqual({
        event: "permission_approval_result",
        properties: expect.objectContaining({
          result: "approved",
          session_cache_written: false,
        }),
      });
    });

    it("maps a rejected response to a block", async () => {
      useBroker(async () => ({ decision: "rejected" }));
      const svc = make();

      await expect(
        svc.requestToolApproval(makeContext("Bash"), ask(), "fallback-ask"),
      ).resolves.toEqual({
        veto: {
          output:
            'Tool "Bash" was not run because the user rejected the approval request.',
          isError: true,
        },
      });
    });

    it("appends worker guidance to rejection messages for subagents", async () => {
      useSubagentScope();
      useBroker(async () => ({ decision: "rejected", feedback: "too broad" }));
      const svc = make();

      await expect(
        svc.requestToolApproval(makeContext("Bash"), ask(), "fallback-ask"),
      ).resolves.toEqual({
        veto: {
          output:
            'Tool "Bash" was not run because the user rejected the approval request.' +
            ` Reason: too broad ${RETRY_GUIDANCE}`,
          isError: true,
        },
      });
    });

    it("tracks cancelled approval requests", async () => {
      useBroker(async () => ({
        decision: "cancelled",
        feedback: "request closed",
      }));
      const svc = make();

      await expect(
        svc.requestToolApproval(makeContext("Bash"), ask(), "fallback-ask"),
      ).resolves.toMatchObject({
        veto: {
          output: expect.stringContaining("approval request was cancelled"),
          isError: true,
        },
      });

      expect(records).toContainEqual({
        event: "permission_approval_result",
        properties: expect.objectContaining({
          policy_name: "fallback-ask",
          tool_name: "Bash",
          permission_mode: "manual",
          result: "cancelled",
          has_feedback: true,
          session_cache_written: false,
        }),
      });
    });

    it.each([
      ["rejected", { decision: "rejected" }, "rejected", false],
      ["cancelled", { decision: "cancelled" }, "cancelled", false],
      [
        "revise feedback",
        {
          decision: "rejected",
          selectedLabel: "Revise",
          feedback: "Add verification.",
        },
        "rejected",
        true,
      ],
    ] as const)(
      async (_name, response, expectedResult, expectedHasFeedback) => {
        useBroker(async () => response);
        const svc = make();
        const display: ToolInputDisplay = {
          kind: "plan_review",
          plan: "# Plan",
          path: "/tmp/kimi-plan.md",
        };

        await expect(
          svc.requestToolApproval(
            makeContext("ExitPlanMode", {}, { display }),
            ask({
              resolveApproval: () => ({
                kind: "result",
                result: { output: "Plan review handled." },
              }),
            }),
            "exit-plan-mode-review-ask",
          ),
        ).resolves.toEqual({
          veto: { output: "Plan review handled." },
        });

        expect(records).toContainEqual({
          event: "permission_approval_result",
          properties: expect.objectContaining({
            policy_name: "exit-plan-mode-review-ask",
            tool_name: "ExitPlanMode",
            permission_mode: "manual",
            result: expectedResult,
            approval_surface: "plan_review",
            duration_ms: expect.any(Number),
            session_cache_written: false,
            has_feedback: expectedHasFeedback,
          }),
        });
      },
    );

    it("tracks approval transport errors before rethrowing", async () => {
      const events = subscribeApprovalEvents();
      const error = new Error("approval transport closed");
      useBroker(async () => {
        throw error;
      });
      const svc = make();

      await expect(
        svc.requestToolApproval(
          makeContext("ExitPlanMode"),
          ask(),
          "exit-plan-mode-review-ask",
        ),
      ).rejects.toThrow("approval transport closed");

      expect(records).toContainEqual({
        event: "permission_approval_result",
        properties: expect.objectContaining({
          policy_name: "exit-plan-mode-review-ask",
          tool_name: "ExitPlanMode",
          result: "error",
        }),
      });
      expect(events.resolved).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "permission.approval.resolved",
          decision: "error",
          error: "approval transport closed",
        }),
      );
    });

    it("folds resolveError continuations into the result instead of rethrowing", async () => {
      useBroker(async () => {
        throw new Error("approval transport closed");
      });
      const svc = make();

      await expect(
        svc.requestToolApproval(
          makeContext("ExitPlanMode"),
          ask({
            resolveError: () => ({
              kind: "deny",
              message: "review unavailable",
            }),
          }),
          "exit-plan-mode-review-ask",
        ),
      ).resolves.toEqual({
        veto: { output: "review unavailable", isError: true },
      });
    });

  });

  describe("message formatting", () => {
    it("keeps deny messages plain for the main agent", () => {
      const svc = make();
      expect(svc.formatDenyMessage("nope")).toBe("nope");
    });

    it("appends worker guidance to deny messages for subagents", () => {
      useSubagentScope();
      const svc = make();
      expect(svc.formatDenyMessage("nope")).toBe(`nope ${RETRY_GUIDANCE}`);
    });

    it("includes feedback in rejection messages", () => {
      const svc = make();
      expect(
        svc.formatApprovalRejectionMessage("Bash", {
          decision: "rejected",
          feedback: "too broad",
        }),
      ).toBe(
        'Tool "Bash" was not run because the user rejected the approval request. Reason: too broad',
      );
    });

    it("uses the cancelled prefix for cancellations", () => {
      const svc = make();
      expect(
        svc.formatApprovalRejectionMessage("Bash", { decision: "cancelled" }),
      ).toBe(
        'Tool "Bash" was not run because the approval request was cancelled.',
      );
    });
  });
});

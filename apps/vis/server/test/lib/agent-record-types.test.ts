import { describe, expect, it } from "vitest";
import type {
  AgentRecordOf,
  BackgroundTaskInfo,
} from "../../src/lib/agent-record-types";

describe("v2 wire record type boundary", () => {
  it("keeps the metadata discriminant and payload fields typed", () => {
    const metadata = {
      type: "metadata",
      protocol_version: "1.5",
      created_at: 1,
    } satisfies AgentRecordOf<"metadata">;

    expect(metadata.protocol_version).toBe("1.5");
    expect(metadata.created_at).toBe(1);
  });

  it("uses v2 task info shapes for persisted task entries", () => {
    const task = {
      taskId: "bash-1",
      description: "list files",
      status: "completed",
      startedAt: 1,
      endedAt: 2,
      kind: "process",
      command: "ls",
      pid: 42,
      exitCode: 0,
    } satisfies BackgroundTaskInfo;

    expect(task.kind).toBe("process");
    expect(task.exitCode).toBe(0);
  });
});

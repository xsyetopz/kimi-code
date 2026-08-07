import { describe, expect, it, vi } from "vitest";

import { ToolCallComponent } from "#/tui/components/messages/tool-call";
import { STATUS_BULLET } from "#/tui/constant/symbols";
import { projectToolCallBodyLines } from "#/tui/projections/tool-call/body";
import { projectAgentSwarmResultSummaryLines } from "#/tui/projections/tool-call/agent-swarm-result";
import { projectWriteEditPreviewLines } from "#/tui/projections/tool-call/call-preview";
import { projectToolCallHeader } from "#/tui/projections/tool-call/header";
import { projectSingleSubagentHeader } from "#/tui/projections/tool-call/subagent";
import { darkColors } from "#/tui/theme/colors";
import { currentTheme } from "#/tui/theme";

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, "");
}

function liveBodyContainsProjectedLines(
  live: string,
  projectedLines: readonly string[],
): void {
  const liveLines = live.split("\n").map((line) => line.trimEnd());
  for (const projected of projectedLines) {
    const needle = strip(projected).trimEnd();
    expect(liveLines.some((line) => line.includes(needle))).toBe(true);
  }
}

describe("projectToolCallHeader", () => {
  it("uses the shared status bullet for a finished Read call", () => {
    currentTheme.setPalette(darkColors);
    const header = projectToolCallHeader({
      toolCall: {
        id: "call_read",
        name: "Read",
        args: { path: "foo.ts" },
      },
      result: {
        tool_call_id: "call_read",
        output: "line one\nline two",
        is_error: false,
      },
    });
    const plain = strip(header);
    expect(plain).toContain(`${STATUS_BULLET}Used Read`);
    expect(plain).toContain("(foo.ts)");
    expect(plain).toContain("2 lines");
  });

  it("labels Bash with action wording instead of repeating the command", () => {
    currentTheme.setPalette(darkColors);
    const header = projectToolCallHeader({
      toolCall: {
        id: "call_bash",
        name: "Bash",
        args: { command: "echo hi" },
      },
      result: undefined,
    });
    expect(strip(header)).toContain("Running a command");
    expect(strip(header)).not.toContain("echo hi");
  });
});

describe("projectToolCallBodyLines", () => {
  it("renders the Bash command in the body with a shell prompt", () => {
    currentTheme.setPalette(darkColors);
    const lines = projectToolCallBodyLines({
      toolCall: {
        id: "call_bash",
        name: "Bash",
        args: { command: "echo hi" },
      },
      result: undefined,
    });
    expect(lines.some((line) => strip(line).includes("$ echo hi"))).toBe(true);
  });

  it("reuses registry renderers for generic tool output", () => {
    currentTheme.setPalette(darkColors);
    const lines = projectToolCallBodyLines({
      toolCall: {
        id: "call_grep",
        name: "Grep",
        args: { pattern: "foo" },
      },
      result: {
        tool_call_id: "call_grep",
        output: "src/a.ts:1:foo\nsrc/b.ts:2:foo",
        is_error: false,
      },
      width: 120,
    });
    const plain = lines.map(strip).join("\n");
    expect(plain).toContain("src/a.ts");
  });

  it("projects Write streaming preview lines matching the live component", () => {
    currentTheme.setPalette(darkColors);
    const lines: string[] = [];
    for (let i = 1; i <= 30; i++) lines.push(`line${String(i)}`);
    const escaped = lines.join("\\n");
    const toolCall = {
      id: "call_write_stream",
      name: "Write" as const,
      args: { file_path: "foo.ts", content: lines.join("\n") },
      streamingArguments: `{"file_path":"foo.ts","content":"${escaped}`,
    };
    const component = new ToolCallComponent(toolCall, undefined);
    const live = strip(component.render(100).join("\n"));
    const projectedLines = projectWriteEditPreviewLines({ toolCall });
    const projected = strip(projectedLines.join("\n"));
    expect(projected).toContain("line21");
    expect(projected).toContain("line30");
    expect(projected).not.toContain("line1");
    liveBodyContainsProjectedLines(live, projectedLines);
  });

  it("projects capped Write preview lines matching the live component", () => {
    currentTheme.setPalette(darkColors);
    const lines: string[] = [];
    for (let i = 1; i <= 30; i++) lines.push(`line${String(i)}`);
    const toolCall = {
      id: "call_write_pending",
      name: "Write" as const,
      args: { file_path: "foo.ts", content: lines.join("\n") },
    };
    const component = new ToolCallComponent(toolCall, undefined);
    const live = strip(component.render(100).join("\n"));
    const projectedLines = projectToolCallBodyLines({
      toolCall,
      result: undefined,
    });
    const projected = strip(projectedLines.join("\n"));
    expect(projected).toContain("line1");
    expect(projected).toContain("line10");
    expect(projected).not.toContain("line11");
    expect(projected).toContain("ctrl+o to expand");
    liveBodyContainsProjectedLines(live, projectedLines);
  });

  it("projects Edit streaming progress matching the live component", () => {
    currentTheme.setPalette(darkColors);
    vi.useFakeTimers();
    vi.setSystemTime(4000);
    const streaming = '{"file_path":"foo.ts","old_string":"old","new_string":"new';
    const toolCall = {
      id: "call_edit_stream",
      name: "Edit" as const,
      args: { file_path: "foo.ts", old_string: "old", new_string: "new" },
      streamingArguments: streaming,
      streamingStartedAtMs: 0,
    };
    const component = new ToolCallComponent(toolCall, undefined);
    const live = strip(component.render(100).join("\n"));
    const projectedLines = projectWriteEditPreviewLines({
      toolCall,
      nowMs: 4000,
    });
    const projected = strip(projectedLines.join("\n"));
    expect(projected).toContain("Preparing changes for foo.ts...");
    expect(projected).toContain("4s elapsed");
    liveBodyContainsProjectedLines(live, projectedLines);
    vi.useRealTimers();
  });
});

describe("projectSingleSubagentHeader", () => {
  it("labels a running subagent with the braille spinner and agent name", () => {
    currentTheme.setPalette(darkColors);
    const header = projectSingleSubagentHeader({
      toolCall: {
        id: "call_agent",
        name: "Agent",
        args: { description: "Explore auth flow", subagent_type: "explore" },
      },
      result: undefined,
      card: {
        phase: "running",
        agentName: "explore",
        spinnerFrame: 0,
        toolActivities: [],
        subagentText: "",
        subagentThinkingText: "",
        lastStreamKind: "text",
        detachedFromForeground: false,
      },
    });
    const plain = strip(header);
    expect(plain).toContain("Explore Agent");
    expect(plain).toContain("Running");
    expect(plain).toContain("(Explore auth flow)");
  });
});

describe("projectAgentSwarmResultSummaryLines", () => {
  it("matches the live AgentSwarm result summary", () => {
    currentTheme.setPalette(darkColors);
    const output = [
      "<agent_swarm_result>",
      "<summary>completed: 1, failed: 1, aborted: 1</summary>",
      '<subagent index="1" outcome="completed">Reviewed src/a.ts.</subagent>',
      '<subagent index="2" outcome="failed">Agent timed out.</subagent>',
      '<subagent index="3" outcome="aborted">User aborted.</subagent>',
      "</agent_swarm_result>",
    ].join("\n");
    const component = new ToolCallComponent(
      {
        id: "call_swarm",
        name: "AgentSwarm",
        args: { description: "Review changed files" },
      },
      {
        tool_call_id: "call_swarm",
        output,
        is_error: false,
      },
    );
    const projected = projectAgentSwarmResultSummaryLines({
      tool_call_id: "call_swarm",
      output,
      is_error: false,
    });
    const body = projectToolCallBodyLines({
      toolCall: {
        id: "call_swarm",
        name: "AgentSwarm",
        args: { description: "Review changed files" },
      },
      result: {
        tool_call_id: "call_swarm",
        output,
        is_error: false,
      },
    });
    const live = strip(component.render(120).join("\n"));
    liveBodyContainsProjectedLines(live, projected);
    liveBodyContainsProjectedLines(live, body);
  });
});

describe("captureToolCallProjection", () => {
  it("includes subagentCard once subagent state is wired", () => {
    const component = new ToolCallComponent(
      {
        id: "call_agent",
        name: "Agent",
        args: { description: "Run explore agent" },
      },
      undefined,
    );
    component.onSubagentSpawned({
      agentId: "sub-1",
      agentName: "explore",
      runInBackground: false,
    });
    component.onSubagentStarted({
      agentId: "sub-1",
      agentName: "explore",
      runInBackground: false,
    });
    const projection = component.captureToolCallProjection();
    expect(projection.subagentCard?.phase).toBe("running");
    expect(projection.subagentCard?.agentName).toBe("explore");
  });
});

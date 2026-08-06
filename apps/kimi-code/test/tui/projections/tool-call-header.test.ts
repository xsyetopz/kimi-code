import { describe, expect, it } from "vitest";

import { ToolCallComponent } from "#/tui/components/messages/tool-call";
import { STATUS_BULLET } from "#/tui/constant/symbols";
import { projectToolCallBodyLines } from "#/tui/projections/tool-call/body";
import { projectToolCallHeader } from "#/tui/projections/tool-call/header";
import { projectSingleSubagentHeader } from "#/tui/projections/tool-call/subagent";
import { darkColors } from "#/tui/theme/colors";
import { currentTheme } from "#/tui/theme";

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, "");
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

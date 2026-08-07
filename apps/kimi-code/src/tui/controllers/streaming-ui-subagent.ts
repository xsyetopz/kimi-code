import { AgentGroupComponent } from "../components/messages/agent-group";
import { ToolCallComponent } from "../components/messages/tool-call";

export interface StreamingUISubagentHost {
  readonly state: {
    readonly transcriptContainer: {
      readonly children: readonly unknown[];
    };
  };
  forEachPendingToolComponent(visitor: (tc: ToolCallComponent) => void): void;
}

/**
 * Push the actual terminal status of a background agent task into the
 * matching `Agent` tool call component.
 */
export function applyBackgroundTaskTerminalStatus(
  host: StreamingUISubagentHost,
  pendingToolComponents: Map<string, ToolCallComponent>,
  args: {
    agentId?: string | undefined;
    description: string;
    status: "completed" | "failed" | "timed_out" | "killed" | "lost";
    errorText?: string | undefined;
  },
): boolean {
  const useAgentIdOnly = args.agentId !== undefined;
  let agentIdMatch: ToolCallComponent | undefined;
  let descMatch: ToolCallComponent | undefined;
  let descAmbiguous = false;
  const visit = (tc: ToolCallComponent): void => {
    if (agentIdMatch !== undefined) return;
    if (useAgentIdOnly) {
      if (tc.getSubagentAgentId() === args.agentId) agentIdMatch = tc;
      return;
    }
    if (tc.getAgentToolDescription() !== args.description) return;
    if (descMatch !== undefined) {
      descAmbiguous = true;
      return;
    }
    descMatch = tc;
  };

  for (const tc of pendingToolComponents.values()) {
    visit(tc);
    if (agentIdMatch !== undefined) break;
  }
  if (agentIdMatch === undefined) {
    for (const child of host.state.transcriptContainer.children) {
      if (child instanceof ToolCallComponent) {
        visit(child);
      } else if (child instanceof AgentGroupComponent) {
        for (const tc of child.getToolComponents()) {
          visit(tc);
          if (agentIdMatch !== undefined) break;
        }
      }
      if (agentIdMatch !== undefined) break;
    }
  }
  const target = useAgentIdOnly
    ? agentIdMatch
    : descAmbiguous
      ? undefined
      : descMatch;
  if (target === undefined) return false;
  target.setBackgroundTaskTerminalStatus(args.status, {
    errorText: args.errorText,
  });
  return true;
}

/** Mark a foreground subagent card as detached-to-background. */
export function markSubagentBackgrounded(
  host: StreamingUISubagentHost,
  pendingToolComponents: Map<string, ToolCallComponent>,
  agentId: string | undefined,
): boolean {
  if (agentId === undefined) return false;
  const visit = (tc: ToolCallComponent): boolean => {
    if (tc.getSubagentAgentId() !== agentId) return false;
    const phase = tc.getSubagentSnapshot().phase;
    if (phase !== "running" && phase !== "queued" && phase !== "spawning")
      return false;
    tc.markBackgrounded();
    return true;
  };
  for (const tc of pendingToolComponents.values()) {
    if (visit(tc)) return true;
  }
  for (const child of host.state.transcriptContainer.children) {
    if (child instanceof ToolCallComponent) {
      if (visit(child)) return true;
    } else if (child instanceof AgentGroupComponent) {
      for (const tc of child.getToolComponents()) {
        if (visit(tc)) return true;
      }
    }
  }
  return false;
}

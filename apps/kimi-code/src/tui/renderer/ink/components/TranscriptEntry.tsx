import { type ReactNode } from "react";

import type { TranscriptEntry } from "../../../types";

import { AssistantMessage } from "./AssistantMessage";
import { UserMessage } from "./UserMessage";
import { ToolCall } from "./ToolCall";
import { Thinking } from "./Thinking";
import { StatusMessage } from "./StatusMessage";
import { GoalEntry } from "./GoalEntry";
import { SkillActivation } from "./SkillActivation";
import { PluginCommand } from "./PluginCommand";
import { CronMessage } from "./CronMessage";
import { BackgroundAgentStatus } from "./BackgroundAgentStatus";

export interface TranscriptEntryProps {
  readonly entry: TranscriptEntry;
  readonly workspaceDir?: string;
}

/**
 * Dispatch a single TranscriptEntry to the right React component.
 * Mirrors the dispatch logic in kimi-tui.ts `createTranscriptComponent`.
 */
export function TranscriptEntryView({
  entry,
  workspaceDir,
}: TranscriptEntryProps): ReactNode {
  // Compaction entries
  if (entry.compactionData) {
    return <StatusMessage entry={entry} />;
  }

  switch (entry.kind) {
    case "welcome":
      return null;

    case "user":
      return <UserMessage entry={entry} />;

    case "assistant":
      return <AssistantMessage entry={entry} />;

    case "tool_call":
      if (entry.backgroundAgentStatus) {
        return <BackgroundAgentStatus entry={entry} />;
      }
      return <ToolCall entry={entry} workspaceDir={workspaceDir} />;

    case "thinking":
      return <Thinking entry={entry} />;

    case "status":
      if (entry.backgroundAgentStatus) {
        return <BackgroundAgentStatus entry={entry} />;
      }
      return <StatusMessage entry={entry} />;

    case "skill_activation":
      return <SkillActivation entry={entry} />;

    case "plugin_command":
      return <PluginCommand entry={entry} />;

    case "cron":
      return <CronMessage entry={entry} />;

    case "goal":
      return <GoalEntry entry={entry} />;

    default:
      return null;
  }
}

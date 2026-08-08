import type {
  CompactCheckpoint,
  Conversation,
  ConversationRecord,
  SystemMessage,
  UserMessage,
} from "@kimi-next/ir";

export interface TransformContextOptions {
  readonly maxRecent?: number;
}

function isSystemMessage(record: ConversationRecord): record is SystemMessage {
  return record.kind === "system";
}

function leadingSystemMessages(archive: Conversation): SystemMessage[] {
  const system: SystemMessage[] = [];
  for (const record of archive) {
    if (isSystemMessage(record)) {
      system.push(record);
      continue;
    }
    break;
  }
  return system;
}

function checkpointToUserMessage(checkpoint: CompactCheckpoint): UserMessage {
  const files =
    checkpoint.filesTouched.length > 0
      ? checkpoint.filesTouched.map((file) => `- ${file}`).join("\n")
      : "(none)";
  const text = [
    "[Session compact checkpoint]",
    "",
    "## Progress",
    checkpoint.progress,
    "",
    "## Files touched",
    files,
    "",
    "## Validation",
    checkpoint.validation,
    "",
    "## Next steps",
    checkpoint.nextSteps,
  ].join("\n");

  return {
    kind: "user",
    id: `compact-context-${checkpoint.id}`,
    content: [{ type: "text", text }],
  };
}

function latestCheckpointIndex(archive: Conversation): number {
  let latest = -1;
  for (let i = 0; i < archive.length; i++) {
    if (archive[i]?.kind === "compact_checkpoint") {
      latest = i;
    }
  }
  return latest;
}

function limitTail(
  records: readonly ConversationRecord[],
  maxRecent?: number,
): ConversationRecord[] {
  if (maxRecent === undefined || records.length <= maxRecent) {
    return [...records];
  }
  return records.slice(records.length - maxRecent);
}

function withoutCheckpoints(records: readonly ConversationRecord[]): ConversationRecord[] {
  return records.filter((record) => record.kind !== "compact_checkpoint");
}

function transformWithoutCheckpoint(
  archive: Conversation,
  maxRecent?: number,
): Conversation {
  const system = leadingSystemMessages(archive);
  const rest = withoutCheckpoints(archive.slice(system.length));
  return [...system, ...limitTail(rest, maxRecent)];
}

export function transformContext(
  archive: Conversation,
  options?: TransformContextOptions,
): Conversation {
  const maxRecent = options?.maxRecent;
  const checkpointIndex = latestCheckpointIndex(archive);
  if (checkpointIndex < 0) {
    return transformWithoutCheckpoint(archive, maxRecent);
  }

  const checkpoint = archive[checkpointIndex] as CompactCheckpoint;
  const system = leadingSystemMessages(archive);
  const tail = withoutCheckpoints(archive.slice(checkpointIndex + 1));

  return [
    ...system,
    checkpointToUserMessage(checkpoint),
    ...limitTail(tail, maxRecent),
  ];
}

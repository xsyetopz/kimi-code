import { Box, Text } from "ink";
import type { WysiwygToggles } from "../toggles";
import { ToolCard } from "./ToolCard";

export type TranscriptEntry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; thinking?: string; raw?: string }
  | { kind: "tool"; name: string; id?: string }
  | { kind: "tool_result"; content: string; isError: boolean }
  | { kind: "system"; text: string };

export interface TranscriptProps {
  readonly entries: readonly TranscriptEntry[];
  readonly streamingText: string;
  readonly toggles: WysiwygToggles;
  /** Keep last N entries visible (dense transcript). */
  readonly maxEntries?: number;
}

export function Transcript({
  entries,
  streamingText,
  toggles,
  maxEntries = 80,
}: TranscriptProps) {
  const visible =
    entries.length > maxEntries ? entries.slice(-maxEntries) : entries;
  const merged = mergeToolPairs(visible);

  return (
    <Box flexDirection="column" flexGrow={1}>
      {merged.map((entry, index) => (
        <Box key={index} flexDirection="column" marginBottom={0}>
          {renderEntry(entry, toggles)}
        </Box>
      ))}
      {streamingText ? (
        <Box marginTop={0}>
          <Text color="green">{streamingText}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

type MergedEntry =
  | TranscriptEntry
  | {
      kind: "tool_pair";
      name: string;
      id?: string;
      result?: string;
      isError?: boolean;
    };

function mergeToolPairs(entries: readonly TranscriptEntry[]): MergedEntry[] {
  const out: MergedEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.kind === "tool") {
      const next = entries[i + 1];
      if (next?.kind === "tool_result") {
        if (entry.id !== undefined) {
          out.push({
            kind: "tool_pair",
            name: entry.name,
            id: entry.id,
            result: next.content,
            isError: next.isError,
          });
        } else {
          out.push({
            kind: "tool_pair",
            name: entry.name,
            result: next.content,
            isError: next.isError,
          });
        }
        i++;
        continue;
      }
      if (entry.id !== undefined) {
        out.push({ kind: "tool_pair", name: entry.name, id: entry.id });
      } else {
        out.push({ kind: "tool_pair", name: entry.name });
      }
      continue;
    }
    out.push(entry);
  }
  return out;
}

function renderEntry(entry: MergedEntry, toggles: WysiwygToggles) {
  switch (entry.kind) {
    case "user":
      return (
        <Text>
          <Text color="magenta" bold>
            ›{" "}
          </Text>
          <Text>{entry.text}</Text>
        </Text>
      );
    case "assistant":
      return (
        <Box flexDirection="column">
          {toggles.showThinking && entry.thinking ? (
            <Text dimColor color="yellow">
              [thinking] {entry.thinking}
            </Text>
          ) : null}
          <Text>{entry.text}</Text>
          {toggles.showRawAssistant && entry.raw ? (
            <Text dimColor>[raw] {entry.raw.slice(0, 200)}</Text>
          ) : null}
        </Box>
      );
    case "tool":
      if (entry.id !== undefined) {
        return <ToolCard name={entry.name} id={entry.id} />;
      }
      return <ToolCard name={entry.name} />;
    case "tool_result":
      return (
        <ToolCard
          name="result"
          result={entry.content}
          isError={entry.isError}
        />
      );
    case "tool_pair": {
      if (entry.id !== undefined && entry.result !== undefined) {
        return (
          <ToolCard
            name={entry.name}
            id={entry.id}
            result={entry.result}
            isError={entry.isError === true}
          />
        );
      }
      if (entry.result !== undefined) {
        return (
          <ToolCard
            name={entry.name}
            result={entry.result}
            isError={entry.isError === true}
          />
        );
      }
      if (entry.id !== undefined) {
        return <ToolCard name={entry.name} id={entry.id} />;
      }
      return <ToolCard name={entry.name} />;
    }
    case "system":
      return <Text dimColor>{entry.text}</Text>;
    default: {
      const _exhaustive: never = entry;
      return _exhaustive;
    }
  }
}

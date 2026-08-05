/**
 * Resume replay fold — rebuilds the `AgentReplayRecord[]` / `toolStore` pair
 * from a v2 agent's `wire.jsonl`.
 *
 * The v2 engine persists each agent's journal at
 * `<sessionDir>/agents/<agentId>/wire.jsonl` using v1's record vocabulary for
 * every replay-relevant op. The fold in `./resume-replay-fold.ts` reproduces
 * the v1 engine's restore semantics (assistant-message assembly from loop
 * events, mid-history gap closing with synthesized interrupted results,
 * context.undo, compaction lifecycle) WITHOUT instantiating a throwaway v1
 * `Agent` — it reads the records directly and produces the same
 * AgentReplayRecord[] + toolStore snapshot the TUI consumes.
 *
 * Any failure — missing/corrupt file, newer protocol, unexpected record —
 * degrades to an empty result instead of failing the session resume.
 */

import { readFile } from "node:fs/promises";

import type { AgentReplayRecord } from "@moonshot-ai/agent-core-v2";

import { foldWireRecords, type FoldedWireReplay } from "./resume-replay-fold";

export interface FoldedAgentReplay {
  readonly replay: readonly AgentReplayRecord[];
  readonly toolStore: Readonly<Record<string, unknown>>;
}

const EMPTY_FOLD: FoldedAgentReplay = { replay: [], toolStore: {} };

/**
 * Fold one agent's `wire.jsonl` into the replay records and tool-store
 * snapshot. Best-effort: unreadable or malformed journals yield an empty
 * fold, never a rejected resume.
 */
export async function foldAgentWireReplay(
  wirePath: string,
): Promise<FoldedAgentReplay> {
  try {
    const records = parseWireRecords(await readFile(wirePath, "utf-8"));
    if (records.length === 0) return EMPTY_FOLD;
    return foldWireRecords(records);
  } catch {
    return EMPTY_FOLD;
  }
}

/**
 * The v1 line reader's rules: blank lines skipped, a truncated TAIL line
 * tolerated (the last write may have crashed mid-flush), corruption anywhere
 * else is an error.
 */
function parseWireRecords(content: string): Record<string, unknown>[] {
  const lines = content.split("\n");
  const records: Record<string, unknown>[] = [];
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) continue;
    try {
      records.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      if (index === lines.length - 1) break;
      throw new Error(`corrupt wire.jsonl at line ${index + 1}`);
    }
  }
  return records;
}

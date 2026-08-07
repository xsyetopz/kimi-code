import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  promptMetadataTextFromPayload,
  promptMetadataTextFromPluginCommand,
  promptMetadataTextFromSkill,
} from "@moonshot-ai/agent-core-v2";

import { ErrorCodes, KimiError } from "#/compat";

export type WireRecord = Record<string, unknown>;

interface MainTurnSlice {
  readonly records: readonly WireRecord[];
  readonly cutoffTime: number | undefined;
  readonly lastPrompt: string | undefined;
}

export function assertForkTurnIndex(turnIndex: number | undefined): void {
  if (turnIndex === undefined) return;
  if (Number.isSafeInteger(turnIndex) && turnIndex >= 0) return;
  throw new KimiError(
    ErrorCodes.REQUEST_INVALID,
    "forkSession turnIndex must be a non-negative safe integer",
    { details: { turnIndex } },
  );
}

export async function assertHistoricalTurnAvailable(
  sourceSessionId: string,
  sourceSessionDir: string,
  turnIndex: number,
): Promise<void> {
  const records = await readWireRecords(
    join(sourceSessionDir, "agents", "main", "wire.jsonl"),
  );
  const turnStarts: number[] = [];
  for (let index = 0; index < records.length; index += 1) {
    if (isUserVisibleTurnRecord(records[index]!)) turnStarts.push(index);
  }
  if (turnStarts[turnIndex] === undefined) {
    throw new KimiError(
      ErrorCodes.REQUEST_INVALID,
      `Turn ${String(turnIndex)} was not found in session "${sourceSessionId}"`,
      { details: { turnIndex, availableTurns: turnStarts.length } },
    );
  }
}

export async function truncateForkedSessionAtTurn(
  sessionDir: string,
  sourceSessionId: string,
  turnIndex: number,
  state: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const agents = state["agents"];
  if (!isRecord(agents) || !isRecord(agents["main"])) {
    throw new KimiError(
      ErrorCodes.SESSION_STATE_INVALID,
      `Session "${sourceSessionId}" has no main agent metadata`,
    );
  }

  const mainAgentDir = join(sessionDir, "agents", "main");
  const mainWirePath = join(mainAgentDir, "wire.jsonl");
  const mainRecords = await readWireRecords(mainWirePath);
  const mainSlice = sliceMainRecordsAtTurn(
    mainRecords,
    sourceSessionId,
    turnIndex,
  );
  await writeWireRecords(mainWirePath, mainSlice.records);

  const retainedAgents: Record<string, unknown> = {
    main: withAgentHomedir(agents["main"], mainAgentDir),
  };
  for (const [agentId, agentMeta] of Object.entries(agents)) {
    if (agentId === "main") continue;
    const agentDir = join(sessionDir, "agents", agentId);
    const retained = await truncateSubagentAtTime(agentDir, mainSlice.cutoffTime);
    if (retained) {
      retainedAgents[agentId] = withAgentHomedir(agentMeta, agentDir);
      continue;
    }
    await rm(agentDir, { recursive: true, force: true });
  }
  dropAgentsWithMissingParents(retainedAgents);

  for (const agentId of Object.keys(agents)) {
    if (retainedAgents[agentId] !== undefined) continue;
    await rm(join(sessionDir, "agents", agentId), {
      recursive: true,
      force: true,
    });
  }

  for (const agentId of Object.keys(retainedAgents)) {
    const agentDir = join(sessionDir, "agents", agentId);
    await Promise.all([
      rm(join(agentDir, "tasks"), { recursive: true, force: true }),
      rm(join(agentDir, "cron"), { recursive: true, force: true }),
    ]);
  }

  const next = {
    ...state,
    lastPrompt: mainSlice.lastPrompt,
    agents: retainedAgents,
  };
  await writeFile(
    join(sessionDir, "state.json"),
    `${JSON.stringify(next, null, 2)}\n`,
    "utf-8",
  );
  return next;
}

export async function appendForkedMarkers(
  state: Record<string, unknown>,
): Promise<void> {
  const record: WireRecord = { type: "forked", time: Date.now() };
  const agents = state["agents"];
  if (!isRecord(agents)) return;

  const paths = new Set<string>();
  for (const agentMeta of Object.values(agents)) {
    if (!isRecord(agentMeta)) continue;
    const homedir = agentMeta["homedir"];
    if (typeof homedir !== "string") continue;
    paths.add(join(homedir, "wire.jsonl"));
  }

  await Promise.all(
    [...paths].map(async (path) => {
      const records = await readWireRecords(path);
      records.push(record);
      await writeWireRecords(path, records);
    }),
  );
}

function withAgentHomedir(agentMeta: unknown, homedir: string): unknown {
  return isRecord(agentMeta) ? { ...agentMeta, homedir } : agentMeta;
}

async function readWireRecords(path: string): Promise<WireRecord[]> {
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const lines = content.split("\n");
  const records: WireRecord[] = [];
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) continue;
    try {
      records.push(JSON.parse(line) as WireRecord);
    } catch {
      if (index === lines.length - 1) break;
      throw new Error(`corrupt wire.jsonl at line ${index + 1}`);
    }
  }
  return records;
}

async function writeWireRecords(
  path: string,
  records: readonly WireRecord[],
): Promise<void> {
  const body =
    records.length === 0 ? "" : `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
  await writeFile(path, body, "utf-8");
}

function sliceMainRecordsAtTurn(
  records: readonly WireRecord[],
  sourceSessionId: string,
  turnIndex: number,
): MainTurnSlice {
  const turnStarts: number[] = [];
  for (let index = 0; index < records.length; index += 1) {
    if (isUserVisibleTurnRecord(records[index]!)) turnStarts.push(index);
  }
  const start = turnStarts[turnIndex];
  if (start === undefined) {
    throw new KimiError(
      ErrorCodes.REQUEST_INVALID,
      `Turn ${String(turnIndex)} was not found in session "${sourceSessionId}"`,
      { details: { turnIndex, availableTurns: turnStarts.length } },
    );
  }

  const end = turnStarts[turnIndex + 1] ?? records.length;
  const retainedTurnInputs = turnInputIndicesThrough(records, turnIndex);
  const retained = records
    .slice(0, end)
    .filter(
      (record, index) =>
        !isUserVisibleTurnInputRecord(record) ||
        retainedTurnInputs.has(index),
    );
  const cutoffTimes = retained
    .map(recordTime)
    .filter((time): time is number => time !== undefined);
  const lastPrompt = promptMetadataFromTurnRecord(records[start]!);
  return {
    records: retained,
    cutoffTime: cutoffTimes.length === 0 ? undefined : Math.max(...cutoffTimes),
    lastPrompt,
  };
}

async function truncateSubagentAtTime(
  agentDir: string,
  cutoffTime: number | undefined,
): Promise<boolean> {
  if (cutoffTime === undefined) return false;
  const wirePath = join(agentDir, "wire.jsonl");
  const records = await readWireRecords(wirePath);
  let end = records.length;
  for (let index = 0; index < records.length; index += 1) {
    const time = recordTime(records[index]!);
    if (time !== undefined && time > cutoffTime) {
      end = index;
      break;
    }
  }
  const retained = records.slice(0, end);
  if (retained.length === 0) return false;
  await writeWireRecords(wirePath, retained);
  return true;
}

function dropAgentsWithMissingParents(agents: Record<string, unknown>): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const [agentId, agentMeta] of Object.entries(agents)) {
      if (agentId === "main" || !isRecord(agentMeta)) continue;
      const parentAgentId = agentMeta["parentAgentId"];
      if (
        typeof parentAgentId === "string" &&
        parentAgentId !== "main" &&
        agents[parentAgentId] === undefined
      ) {
        delete agents[agentId];
        changed = true;
      }
    }
  }
}

function recordTime(record: WireRecord): number | undefined {
  const time = record["time"];
  if (typeof time === "number" && Number.isFinite(time)) return time;
  if (record["type"] === "metadata") {
    const createdAt = record["created_at"];
    if (typeof createdAt === "number" && Number.isFinite(createdAt)) {
      return createdAt;
    }
  }
  return undefined;
}

function isUserVisibleTurnRecord(record: WireRecord): boolean {
  if (record["type"] !== "context.append_message") return false;
  const message = record["message"];
  if (!isRecord(message) || message["role"] !== "user") return false;
  const origin = message["origin"];
  const kind = isRecord(origin) ? origin["kind"] : undefined;
  switch (kind) {
    case undefined:
    case "user":
      return true;
    case "skill_activation":
    case "plugin_command":
      return origin?.["trigger"] === "user-slash";
    case "shell_command":
      return origin?.["phase"] === "input";
    case "background_task":
    case "compaction_summary":
    case "cron_job":
    case "cron_missed":
    case "hook_result":
    case "injection":
    case "retry":
    case "system_trigger":
      return false;
    default:
      return false;
  }
}

function isUserVisibleTurnInputRecord(record: WireRecord): boolean {
  const type = record["type"];
  if (type !== "turn.prompt" && type !== "turn.steer") return false;
  const origin = record["origin"];
  if (!isRecord(origin)) return false;
  switch (origin["kind"]) {
    case "user":
      return true;
    case "skill_activation":
    case "plugin_command":
      return origin["trigger"] === "user-slash";
    case "shell_command":
      return origin["phase"] === "input";
    case "background_task":
    case "compaction_summary":
    case "cron_job":
    case "cron_missed":
    case "hook_result":
    case "injection":
    case "retry":
    case "system_trigger":
      return false;
    default:
      return false;
  }
}

function turnInputIndicesThrough(
  records: readonly WireRecord[],
  turnIndex: number,
): ReadonlySet<number> {
  const pending: number[] = [];
  const retained = new Set<number>();
  let visibleTurnIndex = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (isUserVisibleTurnInputRecord(record)) {
      pending.push(index);
      continue;
    }
    if (!isUserVisibleTurnRecord(record)) continue;

    const matchAt = findMatchingTurnInput(records, pending, record);
    if (matchAt !== -1) {
      const [inputIndex] = pending.splice(matchAt, 1);
      if (visibleTurnIndex <= turnIndex && inputIndex !== undefined) {
        retained.add(inputIndex);
      }
    }
    visibleTurnIndex += 1;
  }
  return retained;
}

function findMatchingTurnInput(
  records: readonly WireRecord[],
  pending: readonly number[],
  turnRecord: WireRecord,
): number {
  const exact = pending.findIndex((index) =>
    turnInputMatchesRecord(records[index]!, turnRecord, true),
  );
  if (exact !== -1) return exact;
  return pending.findIndex((index) =>
    turnInputMatchesRecord(records[index]!, turnRecord, false),
  );
}

function turnInputMatchesRecord(
  inputRecord: WireRecord,
  turnRecord: WireRecord,
  compareContent: boolean,
): boolean {
  const inputType = inputRecord["type"];
  if (
    (inputType !== "turn.prompt" && inputType !== "turn.steer") ||
    turnRecord["type"] !== "context.append_message"
  ) {
    return false;
  }
  const message = turnRecord["message"];
  if (!isRecord(message) || message["role"] !== "user") return false;
  const inputOrigin = inputRecord["origin"];
  const messageOrigin = message["origin"];
  const inputKind = isRecord(inputOrigin) ? inputOrigin["kind"] : undefined;
  const messageKind = isRecord(messageOrigin) ? messageOrigin["kind"] : undefined;
  if (!sameTurnOrigin(String(inputKind ?? "user"), messageKind)) return false;
  return (
    !compareContent ||
    JSON.stringify(inputRecord["input"]) === JSON.stringify(message["content"])
  );
}

function sameTurnOrigin(
  inputKind: string,
  messageKind: string | undefined,
): boolean {
  if (inputKind === "user") return messageKind === undefined || messageKind === "user";
  return inputKind === messageKind;
}

function promptMetadataFromTurnRecord(record: WireRecord): string | undefined {
  if (record["type"] !== "context.append_message") return undefined;
  const message = record["message"];
  if (!isRecord(message) || message["role"] !== "user") return undefined;
  const origin = message["origin"];
  if (isRecord(origin) && origin["kind"] === "skill_activation") {
    return promptMetadataTextFromSkill({
      name: String(origin["skillName"] ?? ""),
      args: origin["skillArgs"],
    });
  }
  if (isRecord(origin) && origin["kind"] === "plugin_command") {
    return promptMetadataTextFromPluginCommand({
      pluginId: String(origin["pluginId"] ?? ""),
      commandName: String(origin["commandName"] ?? ""),
      args: origin["commandArgs"],
    });
  }
  return promptMetadataTextFromPayload({ input: message["content"] });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

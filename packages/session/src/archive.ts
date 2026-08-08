import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import type { Conversation, ConversationRecord } from "@kimi-next/ir";

export interface SessionHandle {
  readonly dir: string;
  readonly id: string;
  readonly path: string;
}

type ArchiveRecordLine = ConversationRecord & {
  readonly type: "record";
  readonly parentId?: string;
};

interface ArchiveMetaLine {
  readonly type: "meta";
  readonly event: string;
  readonly sessionId?: string;
  readonly recordId?: string;
  readonly parentId?: string;
  readonly parentSessionId?: string;
  readonly [key: string]: unknown;
}

type ArchiveLine = ArchiveRecordLine | ArchiveMetaLine;

function sessionPath(dir: string, id: string): string {
  return join(dir, `${id}.jsonl`);
}

function serializeRecord(record: ConversationRecord): string {
  const line: ArchiveRecordLine = {
    type: "record",
    ...record,
  };
  return `${JSON.stringify(line)}\n`;
}

function parseRecordLine(line: ArchiveRecordLine): ConversationRecord {
  const { type: _type, parentId: _parentId, ...record } = line;
  return record as ConversationRecord;
}

function isRecordLine(value: ArchiveLine): value is ArchiveRecordLine {
  return value.type === "record" && "kind" in value;
}

export async function createSession(
  dir: string,
  id?: string,
): Promise<SessionHandle> {
  const sessionId = id ?? randomUUID();
  await mkdir(dir, { recursive: true });
  const path = sessionPath(dir, sessionId);
  const meta: ArchiveMetaLine = {
    type: "meta",
    event: "session_created",
    sessionId,
  };
  await appendFile(path, `${JSON.stringify(meta)}\n`, "utf8");
  return { dir, id: sessionId, path };
}

export async function listSessions(dir: string): Promise<SessionHandle[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }
  const sessions: SessionHandle[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const id = entry.name.slice(0, -".jsonl".length);
    const path = sessionPath(dir, id);
    const details = await stat(path);
    if (details.isFile()) sessions.push({ dir, id, path });
  }
  sessions.sort((a, b) => a.id.localeCompare(b.id));
  return sessions;
}

export async function openSession(
  dir: string,
  id: string,
): Promise<SessionHandle> {
  const handle = { dir, id, path: sessionPath(dir, id) };
  await stat(handle.path);
  return handle;
}

export async function forkSession(
  handle: SessionHandle,
  dir = handle.dir,
): Promise<SessionHandle> {
  const fork = await createSession(dir);
  const raw = await readFile(handle.path, "utf8");
  const parentMeta: ArchiveMetaLine = {
    type: "meta",
    event: "session_forked",
    sessionId: fork.id,
    parentSessionId: handle.id,
  };
  const records = raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .filter((line) => {
      const parsed = JSON.parse(line) as ArchiveLine;
      return isRecordLine(parsed);
    });
  await appendFile(
    fork.path,
    `${JSON.stringify(parentMeta)}\n${records.map((line) => `${line}\n`).join("")}`,
    "utf8",
  );
  return fork;
}

export async function append(
  handle: SessionHandle,
  record: ConversationRecord,
): Promise<void> {
  await appendFile(handle.path, serializeRecord(record), "utf8");
}

export async function load(handle: SessionHandle): Promise<Conversation> {
  let raw: string;
  try {
    raw = await readFile(handle.path, "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }

  const records: ConversationRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const parsed = JSON.parse(trimmed) as ArchiveLine;
    if (isRecordLine(parsed)) {
      records.push(parseRecordLine(parsed));
    }
  }
  return records;
}

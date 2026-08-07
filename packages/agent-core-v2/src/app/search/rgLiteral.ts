/**
 * `search` domain — ripgrep literal fallback over session wire.jsonl files.
 *
 * Scans `<sessionsDir>/<workspaceId>/<sessionId>/` wire logs when the SQLite
 * index is stale or its literal candidate pass is incomplete. Bounded by
 * candidate cap, deadline, and confirmation text budget (kap-server parity).
 */

import { spawn } from "node:child_process";
import { relative, sep } from "node:path";

import type { SessionSummary } from "#/app/sessionIndex/sessionIndex";
import { findExistingRg } from "#/os/backends/node-local/tools/rgLocator";

import type {
  GlobalSearchHit,
  GlobalSearchIncomplete,
  GlobalSearchQuery,
} from "./contract";
import {
  DEADLINE_CHECK_STRIDE,
  LITERAL_CANDIDATE_CAP,
  QUERY_DEADLINE_MS,
  QUERY_TEXT_BUDGET_CHARS,
  WIRE_FILENAME,
} from "./searchDocs";
import { makeSnippet } from "./snippet";
import { normalizeLiteral } from "./tokenize";
import { analyzeWireLine } from "./wireExtract";

export type RgSpawnFn = (
  command: string,
  args: readonly string[],
  options: { signal: AbortSignal },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

let rgSpawnOverride: RgSpawnFn | undefined;

/** Test hook — override how `rg` is spawned. */
export function setRgSpawnForTests(fn: RgSpawnFn | undefined): void {
  rgSpawnOverride = fn;
}

export interface RgLiteralOptions {
  readonly sessionsDir: string;
  readonly query: GlobalSearchQuery;
  readonly literalQuery: string;
  readonly sessions: readonly SessionSummary[];
  readonly candidateCap?: number;
  readonly deadlineMs?: number;
  readonly textBudgetChars?: number;
}

export interface RgLiteralResult {
  readonly items: GlobalSearchHit[];
  readonly hasMore: boolean;
  readonly incomplete?: GlobalSearchIncomplete;
  readonly degraded?: string;
}

interface ParsedWireLocation {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly agentId: string;
}

interface RgJsonRecord {
  readonly type: string;
  readonly data?: {
    readonly path?: { readonly text?: string };
    readonly lines?: { readonly text?: string };
  };
}

export async function searchLiteralRipgrep(
  options: RgLiteralOptions,
): Promise<RgLiteralResult> {
  const pageSize = options.query.pageSize ?? 20;
  const candidateCap = options.candidateCap ?? LITERAL_CANDIDATE_CAP;
  const deadlineAt =
    Date.now() + (options.deadlineMs ?? QUERY_DEADLINE_MS);

  const rgPath = await resolveRgPath();
  if (rgPath === undefined) {
    return {
      items: [],
      hasMore: false,
      degraded: "ripgrep (rg) is not available for literal search fallback",
    };
  }

  const summaries = new Map(
    options.sessions.map((summary) => [summary.id, summary]),
  );
  const searchRoots = resolveSearchRoots(
    options.sessionsDir,
    options.sessions,
    options.query.container?.sessionId,
  );
  if (searchRoots.length === 0) {
    return { items: [], hasMore: false };
  }

  const spawnRg = rgSpawnOverride ?? defaultRgSpawn;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineAt - Date.now());

  let stdout = "";
  let exitCode = 1;
  try {
    const result = await spawnRg(
      rgPath,
      buildRgArgs(options.query.query, searchRoots),
      { signal: controller.signal },
    );
    stdout = result.stdout;
    exitCode = result.exitCode;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).name === "AbortError") {
      return { items: [], hasMore: false, incomplete: "deadline" };
    }
    return {
      items: [],
      hasMore: false,
      degraded: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }

  if (exitCode !== 0 && exitCode !== 1) {
    return {
      items: [],
      hasMore: false,
      degraded: `ripgrep exited with code ${String(exitCode)}`,
    };
  }

  const hits: GlobalSearchHit[] = [];
  let textCharsLeft = options.textBudgetChars ?? QUERY_TEXT_BUDGET_CHARS;
  let incomplete: GlobalSearchIncomplete | undefined;
  let i = 0;

  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    if ((i++ & (DEADLINE_CHECK_STRIDE - 1)) === 0 && Date.now() > deadlineAt) {
      incomplete = "deadline";
      break;
    }
    let record: RgJsonRecord;
    try {
      record = JSON.parse(line) as RgJsonRecord;
    } catch {
      continue;
    }
    if (record.type !== "match") continue;

    const filePath = record.data?.path?.text;
    const wireLine = record.data?.lines?.text;
    if (filePath === undefined || wireLine === undefined) continue;

    const location = parseWirePath(options.sessionsDir, filePath);
    if (location === undefined) continue;

    const summary = summaries.get(location.sessionId);
    if (summary === undefined) continue;

    if (
      options.query.container?.agentId !== undefined &&
      location.agentId !== options.query.container.agentId
    ) {
      continue;
    }

    let analysis;
    try {
      analysis = analyzeWireLine(wireLine);
    } catch {
      continue;
    }

    for (const message of analysis.messages) {
      textCharsLeft -= message.text.length;
      if (textCharsLeft < 0) {
        incomplete = "deadline";
        break;
      }

      if (options.query.role !== undefined && message.role !== options.query.role) {
        continue;
      }

      const norm = normalizeLiteral(message.text);
      const at = norm.indexOf(options.literalQuery);
      if (at === -1) continue;

      const time = message.time ?? summary.updatedAt;
      if (options.query.startTime !== undefined && time < options.query.startTime) {
        continue;
      }
      if (options.query.endTime !== undefined && time > options.query.endTime) {
        continue;
      }

      hits.push({
        sessionId: location.sessionId,
        workspaceId: location.workspaceId,
        sessionTitle: summary.title ?? "",
        agentId: location.agentId,
        role: message.role,
        snippet: makeSnippet(message.text, options.query.query, 80, {
          at,
          len: options.literalQuery.length,
        }),
        time,
        score: 0,
      });

      if (hits.length > candidateCap) {
        hits.length = candidateCap;
        incomplete = "candidate_cap";
        break;
      }
    }

    if (incomplete !== undefined) break;
  }

  hits.sort((a, b) => b.time - a.time || a.sessionId.localeCompare(b.sessionId));
  const page = hits.slice(0, pageSize);
  const hasMore = hits.length > pageSize || incomplete === "candidate_cap";

  return {
    items: page,
    hasMore,
    incomplete,
  };
}

async function resolveRgPath(): Promise<string | undefined> {
  const found = await findExistingRg({
    exec: async () => ({ exitCode: 0 }),
  });
  return found?.path;
}

function resolveSearchRoots(
  sessionsDir: string,
  sessions: readonly SessionSummary[],
  sessionId: string | undefined,
): string[] {
  if (sessionId !== undefined) {
    const summary = sessions.find((s) => s.id === sessionId);
    if (summary === undefined) return [];
    return [`${sessionsDir}/${summary.workspaceId}/${summary.id}`];
  }
  if (sessions.length === 0) return [sessionsDir];
  const roots = new Set<string>();
  for (const summary of sessions) {
    roots.add(`${sessionsDir}/${summary.workspaceId}/${summary.id}`);
  }
  return [...roots];
}

function buildRgArgs(pattern: string, searchRoots: readonly string[]): string[] {
  return [
    "--json",
    "-F",
    "-i",
    "--no-ignore",
    "--glob",
    WIRE_FILENAME,
    "--glob",
    `**/agents/**/${WIRE_FILENAME}`,
    pattern,
    ...searchRoots,
  ];
}

function parseWirePath(
  sessionsDir: string,
  filePath: string,
): ParsedWireLocation | undefined {
  const rel = relative(sessionsDir, filePath);
  const parts = rel.split(sep);
  if (parts.length < 3) return undefined;
  const workspaceId = parts[0]!;
  const sessionId = parts[1]!;
  if (parts[2] === WIRE_FILENAME) {
    return { workspaceId, sessionId, agentId: "main" };
  }
  if (
    parts[2] === "agents" &&
    parts.length >= 4 &&
    parts[parts.length - 1] === WIRE_FILENAME
  ) {
    const agentId = parts.slice(3, -1).join("/");
    return { workspaceId, sessionId, agentId };
  }
  return undefined;
}

function defaultRgSpawn(
  command: string,
  args: readonly string[],
  options: { signal: AbortSignal },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { signal: options.signal });
    const stdoutChunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr,
      });
    });
  });
}

export async function isRipgrepAvailable(): Promise<boolean> {
  return (await resolveRgPath()) !== undefined;
}

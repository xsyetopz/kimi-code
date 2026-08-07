/**
 * Global search skeleton — SQLite index, wire projection, and service gating.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { SessionSummary } from "#/app/sessionIndex/sessionIndex";
import type { Page } from "#/persistence/interface/queryStore";
import { BUN_SQLITE_SEARCH_FLAG_ID } from "#/app/search/flag";
import { GlobalSearchError } from "#/app/search/globalSearch";
import { GlobalSearchService } from "#/app/search/globalSearchService";
import { SqliteSearchIndex } from "#/app/search/sqliteIndex";
import {
  collectWireFiles,
  syncWireFile,
} from "#/app/search/wireIndexer";
import type { IFlagService } from "#/app/flag/flag";
import type { ISessionIndex } from "#/app/sessionIndex/sessionIndex";

const tmpDirs: string[] = [];

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

function makeTmpDir(): string {
  const dir = join(
    "/tmp",
    `kimi-search-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  tmpDirs.push(dir);
  return dir;
}

function makeFlagService(enabled: boolean): IFlagService {
  return {
    _serviceBrand: undefined,
    registry: undefined as never,
    enabled: (id) => id === BUN_SQLITE_SEARCH_FLAG_ID && enabled,
    enabledIds: () => (enabled ? [BUN_SQLITE_SEARCH_FLAG_ID] : []),
    explain: () => undefined,
    explainAll: () => [],
    snapshot: () =>
      enabled ? { [BUN_SQLITE_SEARCH_FLAG_ID]: true } : {},
    setConfigOverrides: () => {},
  };
}

function makeSessionIndex(
  homeDir: string,
  sessions: readonly SessionSummary[],
): ISessionIndex {
  return {
    _serviceBrand: undefined,
    prepare: () => Promise.resolve(),
    status: () => "ready",
    listRecent: async (): Promise<Page<SessionSummary>> => ({
      items: sessions,
    }),
    get: async (id) => sessions.find((s) => s.id === id),
    count: async () => sessions.length,
    remove: async () => {},
    sessionsDir: join(homeDir, "sessions"),
  } as ISessionIndex;
}

function makeBootstrap(homeDir: string) {
  return {
    _serviceBrand: undefined,
    homeDir,
    sessionsDir: join(homeDir, "sessions"),
    blobsDir: join(homeDir, "blobs"),
    storeDir: join(homeDir, "store"),
    cacheDir: join(homeDir, "cache"),
    logsDir: join(homeDir, "logs"),
    configPath: join(homeDir, "config.toml"),
    cwd: homeDir,
    platform: process.platform,
    arch: process.arch,
    osHomeDir: homeDir,
    clientIdentity: { version: "0.0.0-test" },
    paths: {
      sessions: "sessions",
      blobs: "blobs",
      store: "store",
      logs: "logs",
      cache: "cache",
    },
  };
}

describe("SqliteSearchIndex", () => {
  it("indexes message docs and answers a terms query", () => {
    const dir = makeTmpDir();
    const index = SqliteSearchIndex.open(dir, { readonly: false });
    index.batch([
      {
        op: "set",
        key: "s1/main/root:0:0",
        value: {
          kind: "message",
          sessionId: "s1",
          workspaceId: "ws1",
          sessionTitle: "hello",
          agentId: "main",
          role: "user",
          text: "find the needle in the haystack",
          time: 1,
        },
      },
    ]);
    const { hits } = index.searchTerms(["needle"], { op: "AND", limit: 10 });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.value.kind).toBe("message");
    index.close();
  });
});

describe("wireIndexer", () => {
  it("projects user messages from wire.jsonl into the index", async () => {
    const home = makeTmpDir();
    const sessionDir = join(home, "sessions", "ws1", "s1");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "wire.jsonl"),
      `${JSON.stringify({
        type: "context.append_message",
        time: 1_700_000_000,
        message: {
          role: "user",
          content: [{ type: "text", text: "hello search world" }],
        },
      })}\n`,
      "utf8",
    );

    const indexDir = join(home, "search");
    const index = SqliteSearchIndex.open(indexDir, { readonly: false });
    const summary: SessionSummary = {
      id: "s1",
      workspaceId: "ws1",
      createdAt: 1,
      updatedAt: 2,
      archived: false,
    };
    const files = await collectWireFiles(sessionDir);
    expect(files).toHaveLength(1);
    await syncWireFile(
      { disposed: false, syncReplaced: false },
      index,
      summary,
      files[0]!,
    );
    const { hits } = index.searchTerms(["search"], { op: "AND", limit: 10 });
    expect(hits).toHaveLength(1);
    index.close();
  });
});

describe("GlobalSearchService", () => {
  it("rejects queries when the experimental flag is off", async () => {
    const home = makeTmpDir();
    const service = new GlobalSearchService(
      makeSessionIndex(home, []),
      makeBootstrap(home) as never,
      makeFlagService(false),
    );
    await expect(service.search({ query: "hello" })).rejects.toBeInstanceOf(
      GlobalSearchError,
    );
  });

  it("indexes a session wire file and returns a hit when enabled", async () => {
    const home = makeTmpDir();
    const sessionDir = join(home, "sessions", "ws1", "s1");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "wire.jsonl"),
      `${JSON.stringify({
        type: "context.append_message",
        time: 1_700_000_000,
        message: {
          role: "user",
          content: [{ type: "text", text: "alpha bravo charlie" }],
        },
      })}\n`,
      "utf8",
    );
    const summary: SessionSummary = {
      id: "s1",
      workspaceId: "ws1",
      title: "t",
      createdAt: 1,
      updatedAt: 2,
      archived: false,
    };
    const service = new GlobalSearchService(
      makeSessionIndex(home, [summary]),
      makeBootstrap(home) as never,
      makeFlagService(true),
    );
    const page = await service.search({ query: "bravo" });
    expect(page.source).toBe("index");
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.sessionId).toBe("s1");
    expect(page.items[0]?.snippet).toContain("bravo");
  });
});

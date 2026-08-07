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
import {
  isRipgrepAvailable,
  searchLiteralRipgrep,
  setRgSpawnForTests,
} from "#/app/search/rgLiteral";
import { SqliteSearchIndex } from "#/app/search/sqliteIndex";
import {
  collectWireFiles,
  syncWireFile,
} from "#/app/search/wireIndexer";
import type { IFlagService } from "#/app/flag/flag";
import type { ISessionIndex } from "#/app/sessionIndex/sessionIndex";

const tmpDirs: string[] = [];

afterEach(async () => {
  setRgSpawnForTests(undefined);
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

  it("answers a literal query via tri_fts", () => {
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
    const { hits } = index.searchLiteral("needle", { limit: 10 });
    expect(hits).toHaveLength(1);
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

  it("rejects literal queries shorter than 2 normalized code points", async () => {
    const home = makeTmpDir();
    const service = new GlobalSearchService(
      makeSessionIndex(home, []),
      makeBootstrap(home) as never,
      makeFlagService(true),
    );
    await expect(
      service.search({ query: "a", mode: "literal" }),
    ).rejects.toMatchObject({ reason: "invalid_query" });
  });

  it("returns literal hits from the SQLite index when ready", async () => {
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
          content: [{ type: "text", text: "literal needle here" }],
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
    const page = await service.search({ query: "needle", mode: "literal" });
    expect(page.source).toBe("index");
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.snippet).toContain("needle");
  });

  it("falls back to ripgrep for literal search when mocked", async () => {
    const home = makeTmpDir();
    const sessionDir = join(home, "sessions", "ws1", "s1");
    await mkdir(sessionDir, { recursive: true });
    const wirePath = join(sessionDir, "wire.jsonl");
    const wireRecord = {
      type: "context.append_message",
      time: 1_700_000_001,
      message: {
        role: "user",
        content: [{ type: "text", text: "rg fallback match" }],
      },
    };
    await writeFile(wirePath, `${JSON.stringify(wireRecord)}\n`, "utf8");

    const summary: SessionSummary = {
      id: "s1",
      workspaceId: "ws1",
      title: "rg title",
      createdAt: 1,
      updatedAt: 2,
      archived: false,
    };

    setRgSpawnForTests(async (_cmd, _args) => ({
      exitCode: 0,
      stdout: `${JSON.stringify({
        type: "match",
        data: {
          path: { text: wirePath },
          lines: { text: JSON.stringify(wireRecord) },
          line_number: 1,
          submatches: [{ start: 0, end: 3 }],
        },
      })}\n`,
      stderr: "",
    }));

    const result = await searchLiteralRipgrep({
      sessionsDir: join(home, "sessions"),
      query: { query: "fallback", mode: "literal" },
      literalQuery: "fallback",
      sessions: [summary],
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.sessionId).toBe("s1");
    expect(result.items[0]?.snippet).toContain("fallback");
    expect(result.items[0]?.score).toBe(0);
  });

  it("parses agent wire paths from ripgrep output", async () => {
    const home = makeTmpDir();
    const sessionDir = join(home, "sessions", "ws1", "s1");
    const agentsDir = join(sessionDir, "agents", "sub1");
    await mkdir(agentsDir, { recursive: true });
    const wirePath = join(agentsDir, "wire.jsonl");
    const wireRecord = {
      type: "context.append_loop_event",
      time: 1_700_000_002,
      event: {
        type: "content.part",
        part: { type: "text", text: "subagent says hello" },
      },
    };
    await writeFile(wirePath, `${JSON.stringify(wireRecord)}\n`, "utf8");

    const summary: SessionSummary = {
      id: "s1",
      workspaceId: "ws1",
      title: "sub",
      createdAt: 1,
      updatedAt: 2,
      archived: false,
    };

    setRgSpawnForTests(async () => ({
      exitCode: 0,
      stdout: `${JSON.stringify({
        type: "match",
        data: {
          path: { text: wirePath },
          lines: { text: JSON.stringify(wireRecord) },
        },
      })}\n`,
      stderr: "",
    }));

    const result = await searchLiteralRipgrep({
      sessionsDir: join(home, "sessions"),
      query: { query: "subagent", mode: "literal" },
      literalQuery: "subagent",
      sessions: [summary],
    });

    expect(result.items[0]?.agentId).toBe("sub1");
    expect(result.items[0]?.role).toBe("assistant");
  });
});

describe("rgLiteral integration", () => {
  it("finds literal matches via real ripgrep when available", async () => {
    if (!(await isRipgrepAvailable())) return;
      const home = makeTmpDir();
      const sessionDir = join(home, "sessions", "ws1", "s1");
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, "wire.jsonl"),
        `${JSON.stringify({
          type: "context.append_message",
          time: 1_700_000_003,
          message: {
            role: "user",
            content: [{ type: "text", text: "integration rg literal hit" }],
          },
        })}\n`,
        "utf8",
      );
      const summary: SessionSummary = {
        id: "s1",
        workspaceId: "ws1",
        title: "integration",
        createdAt: 1,
        updatedAt: 2,
        archived: false,
      };
      const result = await searchLiteralRipgrep({
        sessionsDir: join(home, "sessions"),
        query: { query: "integration", mode: "literal" },
        literalQuery: "integration",
        sessions: [summary],
      });
      expect(result.items.length).toBeGreaterThanOrEqual(1);
      expect(result.items[0]?.snippet.toLowerCase()).toContain("integration");
  });
});

import { promises as fsp } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LifecycleScope,
  ScopeActivation,
  _clearScopedRegistryForTests,
  registerScopedService,
} from "#/_base/di/scope";
import { createScopedTestHost, stubPair } from "#/_base/di/test";
import { encodeWorkDirKey } from "#/_base/utils/workdir-slug";
import { IBootstrapService } from "#/app/bootstrap/bootstrap";
import {
  ISessionIndex,
} from "#/app/sessionIndex/sessionIndex";
import { FileSessionIndex } from "#/app/sessionIndex/sessionIndexService";
import { JsonAtomicDocumentStore } from "#/persistence/backends/node-fs/atomicDocumentStore";
import { FileStorageService } from "#/persistence/backends/node-fs/fileStorageService";
import { IAtomicDocumentStore } from "#/persistence/interface/atomicDocumentStore";
import { IFileSystemStorageService } from "#/persistence/interface/storage";

import { stubBootstrap } from "../bootstrap/stubs";

const WORK_DIR = "/home/user/repo";

describe("FileSessionIndex", () => {
  let homeDir: string;
  let sessionsDir: string;
  let workspaceId: string;
  let disposeHost: (() => void) | undefined;

  beforeEach(async () => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      ISessionIndex,
      FileSessionIndex,
      ScopeActivation.OnDemand,
      "sessionIndex",
    );
    homeDir = await fsp.mkdtemp(join(os.tmpdir(), "ws-sessions-"));
    sessionsDir = join(homeDir, "sessions");
    workspaceId = encodeWorkDirKey(WORK_DIR);
  });

  afterEach(async () => {
    disposeHost?.();
    disposeHost = undefined;
    await fsp.rm(homeDir, { recursive: true, force: true });
  });

  function build(): ISessionIndex {
    const fileStorage = new FileStorageService(homeDir);
    const host = createScopedTestHost([
      stubPair(IFileSystemStorageService, fileStorage),
      stubPair(IAtomicDocumentStore, new JsonAtomicDocumentStore(fileStorage)),
      stubPair(IBootstrapService, stubBootstrap(homeDir)),
    ]);
    disposeHost = () => {
      host.dispose();
    };
    return host.app.accessor.get(ISessionIndex);
  }

  async function seedSession(
    sessionId: string,
    meta: Record<string, unknown>,
    wsId: string = workspaceId,
  ): Promise<void> {
    const dir = join(sessionsDir, wsId, sessionId, "session-meta");
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(join(dir, "state.json"), JSON.stringify(meta));
  }

  async function seedEmpty(
    sessionId: string,
    wsId: string = workspaceId,
  ): Promise<void> {
    await fsp.mkdir(join(sessionsDir, wsId, sessionId), { recursive: true });
  }

  it("prepare is a no-op and status reports uninitialized", async () => {
    const store = build();
    expect(store.status()).toEqual({
      state: "uninitialized",
      degradedCount: 0,
    });
    await expect(store.prepare()).resolves.toEqual({
      state: "uninitialized",
      degradedCount: 0,
    });
  });

  it("listRecent returns non-archived sessions by default", async () => {
    await seedSession("active", { createdAt: 1, updatedAt: 2 });
    await seedSession("archived", { archived: true });
    await seedEmpty("no-state");

    const store = build();
    const page = await store.listRecent({ workspaceIds: [workspaceId] });
    expect(page.items.map((s) => s.id)).toEqual(["active"]);
    expect(page.items[0]?.workspaceId).toBe(workspaceId);
    expect(page.items[0]?.archived).toBe(false);
  });

  it("listRecent includes archived when requested", async () => {
    await seedSession("active", {});
    await seedSession("archived", { archived: true });

    const store = build();
    const page = await store.listRecent({
      workspaceIds: [workspaceId],
      includeArchived: true,
    });
    expect(page.items.map((s) => s.id).toSorted()).toEqual([
      "active",
      "archived",
    ]);
  });

  it("get fetches a session by id across workspaces", async () => {
    await seedSession("active", { title: "hello" });

    const store = build();
    const summary = await store.get("active");
    expect(summary?.id).toBe("active");
    expect(summary?.title).toBe("hello");
    expect(await store.get("missing")).toBeUndefined();
  });

  it("recovers cwd from the metadata document (v2 cwd, v1 workDir, custom.cwd)", async () => {
    await seedSession("v2", { cwd: "/repo/v2" });
    await seedSession("v1", { workDir: "/repo/v1" });
    await seedSession("old", { custom: { cwd: "/repo/old" } });
    await seedSession("none", { title: "no cwd" });

    const store = build();
    expect((await store.get("v2"))?.cwd).toBe("/repo/v2");
    expect((await store.get("v1"))?.cwd).toBe("/repo/v1");
    expect((await store.get("old"))?.cwd).toBe("/repo/old");
    expect((await store.get("none"))?.cwd).toBeUndefined();
  });

  it("listRecent filters by sessionId without enumerating all sessions", async () => {
    await seedSession("active", { title: "hello" });
    await seedSession("archived", { archived: true });

    const store = build();
    const active = await store.listRecent({ sessionId: "active" });
    expect(active.items.map((s) => s.id)).toEqual(["active"]);

    const archived = await store.listRecent({ sessionId: "archived" });
    expect(archived.items).toEqual([]);

    const archivedIncluded = await store.listRecent({
      sessionId: "archived",
      includeArchived: true,
    });
    expect(archivedIncluded.items.map((s) => s.id)).toEqual(["archived"]);
  });

  it("listRecent filters by childOf using the parent_session_id + child_session_kind markers", async () => {
    await seedSession("parent", { createdAt: 1, updatedAt: 10 });
    await seedSession("child-a", {
      createdAt: 2,
      updatedAt: 9,
      custom: { parent_session_id: "parent", child_session_kind: "child" },
    });
    await seedSession("child-b", {
      createdAt: 3,
      updatedAt: 8,
      custom: { parent_session_id: "parent", child_session_kind: "child" },
    });
    await seedSession("fork", {
      createdAt: 4,
      updatedAt: 7,
      custom: { parent_session_id: "parent" },
    });
    await seedSession("grandchild", {
      createdAt: 5,
      updatedAt: 6,
      custom: { parent_session_id: "child-a", child_session_kind: "child" },
    });

    const store = build();
    const page = await store.listRecent({ childOf: "parent" });
    expect(page.items.map((s) => s.id).toSorted()).toEqual([
      "child-a",
      "child-b",
    ]);
  });

  it("count counts non-archived sessions by default and everything with includeArchived", async () => {
    await seedSession("a", {});
    await seedSession("b", {});
    await seedSession("archived", { archived: true });
    await seedEmpty("no-state");

    const store = build();
    expect(await store.count({ workspaceIds: [workspaceId] })).toBe(2);
    expect(
      await store.count({ workspaceIds: [workspaceId], includeArchived: true }),
    ).toBe(3);
    expect(await store.count({ workspaceIds: ["wd_unknown"] })).toBe(0);
  });

  it("listRecent merges a workspace-id set into one recency-ordered page", async () => {
    const otherId = encodeWorkDirKey("/home/user/other");
    await seedSession("a1", { createdAt: 1, updatedAt: 1 });
    await seedSession("a3", { createdAt: 3, updatedAt: 3 });
    await seedSession("b2", { createdAt: 2, updatedAt: 2 }, otherId);
    await seedSession("b4", { createdAt: 4, updatedAt: 4 }, otherId);

    const store = build();
    const page = await store.listRecent({
      workspaceIds: [workspaceId, otherId],
    });
    expect(page.items.map((s) => s.id)).toEqual(["b4", "a3", "b2", "a1"]);
    expect(page.items[0]?.workspaceId).toBe(otherId);
  });

  it("listRecent applies limit after the cross-bucket merge", async () => {
    const otherId = encodeWorkDirKey("/home/user/other");
    await seedSession("a1", { createdAt: 1, updatedAt: 1 });
    await seedSession("a3", { createdAt: 3, updatedAt: 3 });
    await seedSession("b2", { createdAt: 2, updatedAt: 2 }, otherId);

    const store = build();
    const page = await store.listRecent({
      workspaceIds: [workspaceId, otherId],
      limit: 2,
    });
    expect(page.items.map((s) => s.id)).toEqual(["a3", "b2"]);
    expect(page.nextCursor).toBe("b2");
  });

  it("listRecent filters archived across every bucket of the id set", async () => {
    const otherId = encodeWorkDirKey("/home/user/other");
    await seedSession("active", {});
    await seedSession("archived", { archived: true }, otherId);

    const store = build();
    const visible = await store.listRecent({
      workspaceIds: [workspaceId, otherId],
    });
    expect(visible.items.map((s) => s.id)).toEqual(["active"]);

    const all = await store.listRecent({
      workspaceIds: [workspaceId, otherId],
      includeArchived: true,
    });
    expect(all.items.map((s) => s.id).toSorted()).toEqual([
      "active",
      "archived",
    ]);
  });

  it("count sums over the workspace-id set", async () => {
    const otherId = encodeWorkDirKey("/home/user/other");
    await seedSession("a", {});
    await seedSession("b", {}, otherId);
    await seedSession("archived", { archived: true }, otherId);

    const store = build();
    expect(await store.count({ workspaceIds: [workspaceId, otherId] })).toBe(2);
    expect(await store.count({ workspaceIds: [otherId] })).toBe(1);
  });

  it("pages with the before/after keyset cursors", async () => {
    for (let i = 0; i < 5; i++) {
      await seedSession(`s${i}`, { createdAt: i, updatedAt: i });
    }
    const store = build();

    const page1 = await store.listRecent({
      workspaceIds: [workspaceId],
      limit: 2,
    });
    expect(page1.items.map((s) => s.id)).toEqual(["s4", "s3"]);
    expect(page1.nextCursor).toBe("s3");

    const page2 = await store.listRecent({
      workspaceIds: [workspaceId],
      limit: 2,
      before: page1.nextCursor,
    });
    expect(page2.items.map((s) => s.id)).toEqual(["s2", "s1"]);
    expect(page2.nextCursor).toBe("s1");

    const page3 = await store.listRecent({
      workspaceIds: [workspaceId],
      limit: 2,
      before: page2.nextCursor,
    });
    expect(page3.items.map((s) => s.id)).toEqual(["s0"]);
    expect(page3.nextCursor).toBeUndefined();

    const newer = await store.listRecent({
      workspaceIds: [workspaceId],
      after: "s2",
    });
    expect(newer.items.map((s) => s.id)).toEqual(["s4", "s3"]);

    const unknown = await store.listRecent({
      workspaceIds: [workspaceId],
      before: "missing",
    });
    expect(unknown.items).toEqual([]);
    expect(unknown.nextCursor).toBeUndefined();
  });

  it("remove is a no-op", async () => {
    await seedSession("a", {});
    const store = build();
    await store.remove("a");
    expect(await store.get("a")).toMatchObject({ id: "a" });
  });
});

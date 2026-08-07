import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { Disposable } from "#/_base/di/lifecycle";
import {
  type IAgentScopeHandle,
  LifecycleScope,
  ScopeActivation,
  _clearScopedRegistryForTests,
  registerScopedService,
} from "#/_base/di/scope";
import {
  type ScopedTestHost,
  createScopedTestHost,
  stubPair,
} from "#/_base/di/test";
import { Event } from "#/_base/event";
import { ILogService } from "#/_base/log/log";
import type { Hooks } from "#/hooks";
import { IBootstrapService } from "#/app/bootstrap/bootstrap";
import { IConfigService } from "#/app/config/config";
import { IHostEnvironment } from "#/os/interface/hostEnvironment";
import { IHostFileSystem } from "#/os/interface/hostFileSystem";
import { HostFileSystem } from "#/os/backends/node-local/hostFsService";
import { IHostFsWatchService } from "#/os/interface/hostFsWatch";
import { IEventService } from "#/app/event/event";
import {
  IAgentLifecycleService,
  MAIN_AGENT_ID,
} from "#/session/agentLifecycle/agentLifecycle";
import type { McpConnectionManager } from "#/mcpCore/connection-manager";
import { IWorkspaceSkillCatalog } from "#/workspace/workspaceSkillCatalog/workspaceSkillCatalog";
import { IWorkspaceAgentProfileLoader } from "#/workspace/workspaceAgentProfileLoader/workspaceAgentProfileLoader";
import { IExtraAgentProfileLoader } from "#/workspace/workspaceAgentProfileLoader/extraAgentProfileLoader";
import { IExplicitAgentProfileLoader } from "#/workspace/workspaceAgentProfileLoader/explicitAgentProfileLoader";
import { IUserAgentProfileLoader } from "#/workspace/workspaceAgentProfileLoader/userAgentProfileLoader";
import { IPluginAgentProfileLoader } from "#/workspace/workspaceAgentProfileLoader/pluginAgentProfileLoader";
import { IWorkspaceDirs } from "#/workspace/workspaceDirs/workspaceDirs";
import { WorkspaceDirsService } from "#/workspace/workspaceDirs/workspaceDirsService";
import { IWorkspaceInstructionsService } from "#/workspace/workspaceInstructions/workspaceInstructions";
import {
  IWorkspaceMcpService,
  type ISessionMcpOverlay,
} from "#/workspace/workspaceMcp/workspaceMcp";
import { IAgentPlanService } from "#/agent/plan/plan";
import { ISessionCronService } from "#/session/cron/sessionCronService";
import { ISessionSecondaryModelWarningService } from "#/session/subagent/secondaryModelWarning";
import { ICronTaskPersistence } from "#/app/cron/cronTaskPersistence";
import { CRON_SESSION_TAG, type CronTask } from "#/app/cron/cronTask";
import { IWorkspaceLifecycleService } from "#/app/workspaceLifecycle/workspaceLifecycle";
import { WorkspaceLifecycleService } from "#/app/workspaceLifecycle/workspaceLifecycleService";
import { resumeSessionById } from "#/app/workspaceLifecycle/sessionLookup";
import { ISessionLifecycleService } from "#/workspace/sessionLifecycle/sessionLifecycle";
import { SessionLifecycleService } from "#/workspace/sessionLifecycle/sessionLifecycleService";
import { IWorkspaceToolPolicy } from "#/workspace/workspaceToolPolicy/workspaceToolPolicy";
import { WorkspaceToolPolicyService } from "#/workspace/workspaceToolPolicy/workspaceToolPolicyService";
import { IAgentActivityView } from "#/agent/activityView/activityView";
import { ISessionExternalHooksService } from "#/session/externalHooks/externalHooks";
import {
  ISessionLifecycleHooks,
  type SessionLifecycleHookSlots,
} from "#/session/sessionLifecycleHooks/sessionLifecycleHooks";
import { ISessionMetadata } from "#/session/sessionMetadata/sessionMetadata";
import { ISessionToolPolicy } from "#/session/sessionToolPolicy/sessionToolPolicy";
import { ISessionProcessRunner } from "#/session/process/processRunner";
import {
  ISessionIndex,
  type SessionSummary,
} from "#/app/sessionIndex/sessionIndex";
import { IAppendLogStore } from "#/persistence/interface/appendLogStore";
import { IAtomicDocumentStore } from "#/persistence/interface/atomicDocumentStore";
import { IProjectLocalConfigService } from "#/app/projectLocalConfig/projectLocalConfig";
import { ISessionWorkspaceContext } from "#/session/workspaceContext/workspaceContext";
import { SessionWorkspaceContextService } from "#/session/workspaceContext/workspaceContextService";
import { ISessionStateService } from "#/session/state/sessionState";
import { SessionStateService } from "#/session/state/sessionStateService";
import { IAppStateService } from "#/app/state/appState";
import { AppStateService } from "#/app/state/appStateService";
import { IWorkspaceStateService } from "#/workspace/state/workspaceState";
import { WorkspaceStateService } from "#/workspace/state/workspaceStateService";
import { IWorkspaceService, type Workspace } from "#/app/workspace/workspace";
import { encodeWorkDirKey } from "#/_base/utils/workdir-slug";
import { ISessionContext } from "#/session/sessionContext/sessionContext";
import { ISessionMcpHandle } from "#/session/mcp/sessionMcpHandle";
import { Error2, ErrorCodes } from "#/errors";
    const workDir = "/tmp/proj";
    const svc = await build([
      stubPair(IWorkspaceService, persistentWorkspaceStub()),
      stubPair(ISessionIndex, sessionIndexWithSummary("s1", workDir)),
      stubPair(IAgentLifecycleService, agentLifecycleWithMainStub()),
    ]);

    const resumed = await svc.resume("s1");

    expect(resumed?.id).toBe("s1");
    expect(resumed?.accessor.get(ISessionContext).workspaceId).toBe(
      encodeWorkDirKey(workDir),
    );
  });

  it("does not cache a session whose tool policy fails to initialize", async () => {
    const svc = await build([
      stubPair(
        ISessionIndex,
        sessionIndexWithSummary("s1", "/tmp/proj", "wd_stub"),
      ),
      stubPair(ISessionToolPolicy, {
        ...sessionToolPolicyStub(),
        ready: Promise.reject(new Error("invalid tool policy")),
      }),
    ]);

    await expect(svc.resume("s1")).rejects.toThrow("invalid tool policy");
    expect(svc.get("s1")).toBeUndefined();
    await expect(svc.resume("s1")).rejects.toThrow("invalid tool policy");
  });

  it("resumes with the persisted cwd and indexed workspace id when the registry root is stale", async () => {
    const workDir = "/tmp/proj";
    const staleRoot = "/tmp/stale";
    const indexedWorkspaceId = "wd_indexed";
    const workspaces: IWorkspaceService = {
      _serviceBrand: undefined,
      list: () => Promise.resolve([]),
      get: (id) =>
        Promise.resolve(
          id === indexedWorkspaceId
            ? {
                id: indexedWorkspaceId,
                root: staleRoot,
                name: "stale",
                createdAt: 1,
                lastOpenedAt: 1,
              }
            : undefined,
        ),
      createOrTouch: (root, name) =>
        Promise.resolve({
          id: encodeWorkDirKey(root),
          root,
          name: name ?? "proj",
          createdAt: 1,
          lastOpenedAt: 1,
        }),
      update: () => Promise.resolve(undefined),
      delete: () => Promise.resolve(),
    };
    await build([
      stubPair(IWorkspaceService, workspaces),
      stubPair(
        ISessionIndex,
        sessionIndexWithSummary("s1", workDir, indexedWorkspaceId),
      ),
      stubPair(IAgentLifecycleService, agentLifecycleWithMainStub()),
    ]);

    const resumed = await resumeSessionById(host!.app.accessor, "s1");
    const ctx = resumed?.accessor.get(ISessionContext);

    expect(ctx?.cwd).toBe(workDir);
    expect(ctx?.workspaceId).toBe(indexedWorkspaceId);
    expect(ctx?.sessionDir).toBe(`/tmp/sessions/${indexedWorkspaceId}/s1`);
  });

  it("archive flags metadata, removes agents, publishes the event, and disposes the session", async () => {
    let archived: boolean | undefined;
    const removed: string[] = [];
    const published: { type: string; payload: unknown }[] = [];
    const agentHandle = {
      id: "main",
      kind: LifecycleScope.Agent,
      accessor: { get: () => ({}) },
      dispose: () => {},
    } as unknown as IAgentScopeHandle;
    const svc = await build([
      stubPair(ISessionMetadata, {
        ...metadataStub(),
        setArchived: (value: boolean) => {
          archived = value;
          return Promise.resolve();
        },
      }),
      stubPair(IAgentLifecycleService, {
        ...agentLifecycleStub(),
        _serviceBrand: undefined,
        list: () => [agentHandle],
        remove: (id: string) => {
          removed.push(id);
          return Promise.resolve();
        },
      } as unknown as IAgentLifecycleService),
      stubPair(IEventService, {
        ...eventStub(),
        publish: (event: { type: string; payload: unknown }) =>
          published.push(event),
      }),
    ]);

    await svc.create({ sessionId: "s1", workDir: "/tmp/proj" });
    await svc.archive("s1");

    expect(archived).toBe(true);
    expect(removed).toEqual(["main"]);
    expect(published).toEqual([
      { type: "event.session.archived", payload: { sessionId: "s1" } },
    ]);
    expect(svc.get("s1")).toBeUndefined();
  });

  it("restore clears the archived flag when the session exists on disk", async () => {
    let archived: boolean | undefined;
    const svc = await build([
      stubPair(
        ISessionIndex,
        sessionIndexWithSummary("s1", "/tmp/proj", "wd_stub"),
      ),
      stubPair(IAgentLifecycleService, agentLifecycleWithMainStub()),
      stubPair(ISessionMetadata, {
        ...metadataStub(),
        setArchived: (value: boolean) => {
          archived = value;
          return Promise.resolve();
        },
      }),
    ]);

    const restored = await svc.restore("s1");

    expect(restored?.id).toBe("s1");
    expect(archived).toBe(false);
  });

  describe("delete", () => {
    function recordingAppendLogStore(
      appended: { key: string; record: unknown }[],
    ): IAppendLogStore {
      return {
        ...appendLogStoreStub(),
        append: (_scope: string, key: string, record: unknown) => {
          appended.push({ key, record });
        },
      };
    }

    it("closes a live session, removes its directory, evicts the index, and appends the tombstone", async () => {
      const root = await makeTmpRoot();
      const appended: { key: string; record: unknown }[] = [];
      const removedFromIndex: string[] = [];
      const closed: string[] = [];
      const svc = await build([
        stubPair(IBootstrapService, tmpBootstrapStub(root)),
        stubPair(IAppendLogStore, recordingAppendLogStore(appended)),
        stubPair(ISessionIndex, {
          ...sessionIndexStub(),
          remove: (id: string) => {
            removedFromIndex.push(id);
            return Promise.resolve();
          },
        }),
      ]);
      svc.onDidCloseSession((e) => closed.push(e.sessionId));

      await svc.create({ sessionId: "s1", workDir: "/tmp/proj" });
      const sessionDir = join(root, "sessions", "wd_stub", "s1");
      await mkdir(join(sessionDir, "agents", "main"), { recursive: true });
      await writeFile(join(sessionDir, "agents", "main", "wire.jsonl"), "{}\n");

      await svc.delete("s1");

      expect(svc.get("s1")).toBeUndefined();
      expect(closed).toEqual(["s1"]);
      await expect(stat(sessionDir)).rejects.toThrow();
      expect(removedFromIndex).toEqual(["s1"]);
      expect(appended).toContainEqual({
        key: "session_index.jsonl",
        record: { sessionId: "s1", deleted: true },
      });
    });

    it("removes a persisted session that is not live", async () => {
      const root = await makeTmpRoot();
      const svc = await build([
        stubPair(IBootstrapService, tmpBootstrapStub(root)),
        stubPair(
          ISessionIndex,
          sessionIndexWithSummary("s1", "/tmp/proj", "wd_stub"),
        ),
      ]);
      const sessionDir = join(root, "sessions", "wd_stub", "s1");
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(sessionDir, "state.json"), "{}");

      await svc.delete("s1");

      expect(svc.get("s1")).toBeUndefined();
      await expect(stat(sessionDir)).rejects.toThrow();
    });

    it("throws session.not_found for an unknown id and appends no tombstone", async () => {
      const appended: { key: string; record: unknown }[] = [];
      const svc = await build([
        stubPair(IAppendLogStore, recordingAppendLogStore(appended)),
      ]);

      await expect(svc.delete("nope")).rejects.toMatchObject({
        code: ErrorCodes.SESSION_NOT_FOUND,
      });
      expect(appended).toEqual([]);
    });

    it("throws session.not_found when deleting the same id twice", async () => {
      const svc = await build();
      await svc.create({ sessionId: "s1", workDir: "/tmp/proj" });

      await svc.delete("s1");
      await expect(svc.delete("s1")).rejects.toMatchObject({
        code: ErrorCodes.SESSION_NOT_FOUND,
      });
    });

    it("throws session.not_found for a session persisted under another workspace", async () => {
      const svc = await build([
        stubPair(
          ISessionIndex,
          sessionIndexWithSummary("s1", "/tmp/proj", "wd_other"),
        ),
      ]);

      await expect(svc.delete("s1")).rejects.toMatchObject({
        code: ErrorCodes.SESSION_NOT_FOUND,
      });
    });
  });

  it("forks successfully even while the source has a busy agent (crash-equivalent copy)", async () => {
    const busyAgent = {
      id: MAIN_AGENT_ID,
      kind: LifecycleScope.Agent,
      accessor: {
        get: (token: unknown) => {
          if (token === IAgentActivityView) {
            return {
              state: () => ({
                lifecycle: "ready",
                turn: { turnId: 0 },
                background: [],
              }),
            };
          }
          throw new Error("unexpected service access");
        },
      },
      dispose: () => {},
    } as unknown as IAgentScopeHandle;
    const svc = await build([
      stubPair(IAgentLifecycleService, {
        ...agentLifecycleStub(),
        list: () => [busyAgent],
      }),
    ]);

    await svc.create({ sessionId: "src", workDir: "/tmp/proj" });

    // Fork never gates on activity: a mid-work copy is crash-equivalent, and
    // replay already normalizes that on restore.
    const target = await svc.fork({
      sourceSessionId: "src",
      newSessionId: "dst",
    });
    expect(target.id).toBe("dst");
  });

  it("fires onDidCreateSession with the new handle", async () => {
    const svc = await build();
    let captured: { readonly sessionId: string } | undefined;
    svc.onDidCreateSession((e) => {
      captured = e;
    });
    const h = await svc.create({ sessionId: "s1", workDir: "/tmp/proj" });
    expect(captured).toMatchObject({
      sessionId: "s1",
      handle: h,
      source: "startup",
    });
  });

  it("emits session_started with resumed: false and the bound session id on create", async () => {
    const svc = await build();
    await svc.create({ sessionId: "s1", workDir: "/tmp/proj" });
      event: "session_started",
      properties: { sessionId: "s1", resumed: false },
    });
  });

  it("emits session_started with resumed: true and the bound session id on resume", async () => {
    const workDir = "/tmp/proj";
    const svc = await build([
      stubPair(IWorkspaceService, persistentWorkspaceStub()),
      stubPair(ISessionIndex, sessionIndexWithSummary("s1", workDir)),
      stubPair(IAgentLifecycleService, agentLifecycleWithMainStub()),
    ]);

    await svc.resume("s1");

      event: "session_started",
      properties: { sessionId: "s1", resumed: true },
    });
  });

  it("emits session_load_failed with the bound session id and the error code when resume fails, then rethrows", async () => {
    const svc = await build([
      stubPair(ISessionIndex, {
        ...sessionIndexStub(),
        get: () =>
          Promise.reject(
            new Error2(ErrorCodes.SESSION_NOT_FOUND, "index read failed"),
          ),
      }),
    ]);

    await expect(svc.resume("s1")).rejects.toMatchObject({
      code: ErrorCodes.SESSION_NOT_FOUND,
    });
      event: "session_load_failed",
      properties: { sessionId: "s1", reason: ErrorCodes.SESSION_NOT_FOUND },
    });
  });

  it("emits session_load_failed with the bound session id and the error name for plain errors", async () => {
    const svc = await build([
      stubPair(ISessionIndex, {
        ...sessionIndexStub(),
        get: () => Promise.reject(new TypeError("bad index")),
      }),
    ]);

    await expect(svc.resume("s1")).rejects.toBeInstanceOf(TypeError);
      event: "session_load_failed",
      properties: { sessionId: "s1", reason: "TypeError" },
    });
  });

  it("runs constructor-registered session lifecycle hooks before returning create and close", async () => {
    registerScopedService(
      LifecycleScope.Session,
      ISessionExternalHooksService,
      RecordingSessionExternalHooksService,
      ScopeActivation.OnScopeCreated,
      "externalHooks",
    );
    const svc = await build();

    await svc.create({ sessionId: "s1", workDir: "/tmp/proj" });
    await svc.close("s1");

    expect(recordedSessionHookEvents).toEqual([
      "create:startup:s1",
      "close:exit:s1",
    ]);
  });

  it("returns from create without waiting for MCP initialization", async () => {
    let resolveMcpReady: (() => void) | undefined;
    const mcpReady = new Promise<void>((resolve) => {
      resolveMcpReady = resolve;
    });
    const svc = await build([
      stubPair(IWorkspaceMcpService, workspaceMcpServiceStub(mcpReady)),
    ]);

    // Create resolves while the workspace MCP initial connect is still
    // pending; the seeded handle carries the readiness promise so the agent's
    // LLM steps can wait on it instead.
    const handle = await svc.create({ sessionId: "s1", workDir: "/tmp/proj" });
    expect(handle.accessor.get(ISessionMcpHandle).ready).toBe(mcpReady);

    resolveMcpReady?.();
  });

  function overlayStub(ready: Promise<void> = Promise.resolve()) {
    const handle: ISessionMcpHandle = {
      _serviceBrand: undefined,
      ready,
      connectionManager: {} as unknown as McpConnectionManager,
    };
    const shutdown = vi.fn(() => Promise.resolve());
    const sessionOverlay = vi.fn(
      (
        ..._args: Parameters<IWorkspaceMcpService["sessionOverlay"]>
      ): ISessionMcpOverlay => ({
        handle,
        shutdown,
      }),
    );
    return { sessionOverlay, handle, shutdown };
  }

  it("create with mcpServers seeds the session overlay handle and shuts the overlay down on close", async () => {
    const { sessionOverlay, handle: overlayHandle, shutdown } = overlayStub();
    const svc = await build([
      stubPair(IWorkspaceMcpService, {
        ...workspaceMcpServiceStub(),
        sessionOverlay,
      }),
    ]);
    const mcpServers = {
      eph: { transport: "stdio" as const, command: "node" },
    };

    const handle = await svc.create({
      sessionId: "s1",
      workDir: "/tmp/proj",
      mcpServers,
    });

    expect(sessionOverlay).toHaveBeenCalledWith(mcpServers, {
      stdioCwd: "/tmp/proj",
    });
    expect(handle.accessor.get(ISessionMcpHandle)).toBe(overlayHandle);

    await svc.close("s1");
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("resume with mcpServers seeds the session overlay handle on the re-materialized session", async () => {
    const { sessionOverlay, handle: overlayHandle } = overlayStub();
    const svc = await build([
      stubPair(
        ISessionIndex,
        sessionIndexWithSummary("s1", "/tmp/proj", "wd_stub"),
      ),
      stubPair(IAgentLifecycleService, agentLifecycleWithMainStub()),
      stubPair(IWorkspaceMcpService, {
        ...workspaceMcpServiceStub(),
        sessionOverlay,
      }),
    ]);
    const mcpServers = {
      eph: { transport: "stdio" as const, command: "node" },
    };

    const handle = await svc.resume("s1", { mcpServers });

    expect(sessionOverlay).toHaveBeenCalledWith(mcpServers, {
      stdioCwd: "/tmp/proj",
    });
    expect(handle?.accessor.get(ISessionMcpHandle)).toBe(overlayHandle);
  });

  it("returns from create without waiting for the session MCP overlay readiness", async () => {
    let resolveOverlayReady: (() => void) | undefined;
    const overlayReady = new Promise<void>((resolve) => {
      resolveOverlayReady = resolve;
    });
    const { sessionOverlay } = overlayStub(overlayReady);
    const svc = await build([
      stubPair(IWorkspaceMcpService, {
        ...workspaceMcpServiceStub(),
        sessionOverlay,
      }),
    ]);

    // Create resolves while the overlay's initial connect is still pending;
    // the seeded handle carries the readiness promise so the agent's LLM
    // steps can wait on it instead.
    const handle = await svc.create({
      sessionId: "s1",
      workDir: "/tmp/proj",
      mcpServers: { eph: { transport: "stdio", command: "node" } },
    });
    expect(handle.accessor.get(ISessionMcpHandle).ready).toBe(overlayReady);

    resolveOverlayReady?.();
  });

  it("shuts the session MCP overlay down when create fails after materialization", async () => {
    const { sessionOverlay, shutdown } = overlayStub();
    const svc = await build([
      stubPair(IWorkspaceMcpService, {
        ...workspaceMcpServiceStub(),
        sessionOverlay,
      }),
      stubPair(IAgentLifecycleService, {
        ...agentLifecycleStub(),
        create: () => Promise.reject(new Error("Unknown agent profile")),
      }),
    ]);

    await expect(
      svc.create({
        sessionId: "s1",
        workDir: "/tmp/proj",
        mainAgentBinding: { profile: "missing", model: "mock" },
        mcpServers: { eph: { transport: "stdio", command: "node" } },
      }),
    ).rejects.toThrow("Unknown agent profile");

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(svc.get("s1")).toBeUndefined();
  });

  it("shuts the session MCP overlay down when the service is disposed with the session still live", async () => {
    const { sessionOverlay, shutdown } = overlayStub();
    const svc = await build([
      stubPair(IWorkspaceMcpService, {
        ...workspaceMcpServiceStub(),
        sessionOverlay,
      }),
    ]);
    await svc.create({
      sessionId: "s1",
      workDir: "/tmp/proj",
      mcpServers: { eph: { transport: "stdio" as const, command: "node" } },
    });

    // No close: app/workspace teardown disposes the service directly, and the
    // DI container disposes session scopes without going through the
    // overlay-aware handle wrapper.
    (svc as unknown as { dispose(): void }).dispose();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("does not double-shutdown the overlay when close and service disposal both run", async () => {
    const { sessionOverlay, shutdown } = overlayStub();
    const svc = await build([
      stubPair(IWorkspaceMcpService, {
        ...workspaceMcpServiceStub(),
        sessionOverlay,
      }),
    ]);
    await svc.create({
      sessionId: "s1",
      workDir: "/tmp/proj",
      mcpServers: { eph: { transport: "stdio" as const, command: "node" } },
    });

    await svc.close("s1");
    (svc as unknown as { dispose(): void }).dispose();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("create without mcpServers keeps the shared workspace handle and builds no overlay", async () => {
    const sessionOverlay = vi.fn(
      (
        ..._args: Parameters<IWorkspaceMcpService["sessionOverlay"]>
      ): ISessionMcpOverlay => {
        throw new Error("unexpected overlay");
      },
    );
    const svc = await build([
      stubPair(IWorkspaceMcpService, {
        ...workspaceMcpServiceStub(),
        sessionOverlay,
      }),
    ]);

    const handle = await svc.create({ sessionId: "s1", workDir: "/tmp/proj" });

    expect(sessionOverlay).not.toHaveBeenCalled();
    expect(handle.id).toBe("s1");
    await svc.close("s1");
  });

  it("hides a session from get/list until its resume finishes", async () => {
    let releaseMainAgent: ((handle: IAgentScopeHandle) => void) | undefined;
    const mainAgent = new Promise<IAgentScopeHandle>((resolve) => {
      releaseMainAgent = resolve;
    });
    const main = {
      id: MAIN_AGENT_ID,
      kind: LifecycleScope.Agent,
      accessor: {
        get: () => {
          throw new Error("unexpected main agent service access");
        },
      },
      dispose: () => {},
    } as IAgentScopeHandle;
    const svc = await build([
      stubPair(
        ISessionIndex,
        sessionIndexWithSummary("s1", "/tmp/proj", "wd_stub"),
      ),
      stubPair(IAgentLifecycleService, {
        ...agentLifecycleStub(),
        create: () => mainAgent,
      }),
    ]);

    const resumed = svc.resume("s1");
    await tick();

    expect(svc.get("s1")).toBeUndefined();
    expect(svc.list()).toEqual([]);

    releaseMainAgent?.(main);
    const handle = await resumed;

    expect(handle?.id).toBe("s1");
    expect(svc.get("s1")).toBe(handle);
    expect(svc.list()).toEqual([handle]);
  });

  it("fires onDidCloseSession when a session is closed", async () => {
    const svc = await build();
    const closed: string[] = [];
    svc.onDidCloseSession((e) => closed.push(e.sessionId));
    await svc.create({ sessionId: "s1", workDir: "/tmp/proj" });
    await svc.close("s1");
    expect(closed).toEqual(["s1"]);
  });

  it("fires onDidArchiveSession when a session is archived", async () => {
    const svc = await build([
      stubPair(IAgentLifecycleService, {
        ...agentLifecycleStub(),
        _serviceBrand: undefined,
        list: () => [],
        remove: () => Promise.resolve(),
      } as unknown as IAgentLifecycleService),
    ]);
    const archived: string[] = [];
    svc.onDidArchiveSession((e) => archived.push(e.sessionId));
    await svc.create({ sessionId: "s1", workDir: "/tmp/proj" });
    await svc.archive("s1");
    expect(archived).toEqual(["s1"]);
  });

  describe("additional dirs", () => {
    beforeEach(() => {
      registerScopedService(
        LifecycleScope.Session,
        ISessionStateService,
        SessionStateService,
        ScopeActivation.OnScopeCreated,
        "state",
      );
      registerScopedService(
        LifecycleScope.Session,
        ISessionWorkspaceContext,
        SessionWorkspaceContextService,
        ScopeActivation.OnDemand,
        "workspaceContext",
      );
    });

    function dirsOf(handle: {
      accessor: { get<T>(id: unknown): T };
    }): readonly string[] {
      return (
        handle.accessor.get(
          ISessionWorkspaceContext,
        ) as ISessionWorkspaceContext
      ).additionalDirs;
    }

    it("loads project-local additional dirs into the session workspace on create", async () => {
      const svc = await build([
        stubPair(
          IProjectLocalConfigService,
          projectLocalConfigStub(["/tmp/extra"]),
        ),
      ]);
      const h = await svc.create({ sessionId: "s1", workDir: "/tmp/proj" });
      expect(dirsOf(h)).toEqual(["/tmp/extra"]);
    });

    it("merges caller additionalDirs and resolves relative paths against workDir", async () => {
      const svc = await build();
      const h = await svc.create({
        sessionId: "s1",
        workDir: "/tmp/proj",
        additionalDirs: ["../sibling", "/abs/dir"],
      });
      expect(dirsOf(h)).toEqual(["/tmp/sibling", "/abs/dir"]);
    });

    it("deduplicates project-local and caller dirs after resolving", async () => {
      const svc = await build([
        stubPair(
          IProjectLocalConfigService,
          projectLocalConfigStub(["/tmp/shared"]),
        ),
      ]);
      const h = await svc.create({
        sessionId: "s1",
        workDir: "/tmp/proj",
        additionalDirs: ["../shared", "/tmp/other"],
      });
      expect(dirsOf(h)).toEqual(["/tmp/shared", "/tmp/other"]);
    });

    it("supports multiple project-local and caller additionalDirs", async () => {
      const svc = await build([
        stubPair(
          IProjectLocalConfigService,
          projectLocalConfigStub(["/tmp/a", "/tmp/b"]),
        ),
      ]);
      const h = await svc.create({
        sessionId: "s1",
        workDir: "/tmp/proj",
        additionalDirs: ["/tmp/c", "/tmp/d"],
      });
      expect(dirsOf(h)).toEqual(["/tmp/a", "/tmp/b", "/tmp/c", "/tmp/d"]);
    });

    it("loads project-local dirs when resuming a closed session", async () => {
      const mainHandle = {
        id: MAIN_AGENT_ID,
        kind: LifecycleScope.Agent,
        accessor: { get: () => ({}) },
        dispose: () => {},
      } as unknown as IAgentScopeHandle;
      const summary = { id: "s1", workspaceId: "wd_stub" } as SessionSummary;
      const svc = await build([
        stubPair(
          IProjectLocalConfigService,
          projectLocalConfigStub(["/tmp/extra"]),
        ),
        stubPair(ISessionIndex, {
          ...sessionIndexStub(),
          get: () => Promise.resolve(summary),
        }),
        stubPair(IAgentLifecycleService, {
          ...agentLifecycleStub(),
          get: () => mainHandle,
        }),
      ]);

      const h = await svc.resume("s1");

      expect(h).toBeDefined();
      expect(dirsOf(h!)).toEqual(["/tmp/extra"]);
    });

    it("fork inherits project-local dirs", async () => {
      const svc = await build([
        stubPair(
          IProjectLocalConfigService,
          projectLocalConfigStub(["/tmp/extra"]),
        ),
      ]);

      await svc.create({ sessionId: "src", workDir: "/tmp/proj" });
      const target = await svc.fork({
        sourceSessionId: "src",
        newSessionId: "dst",
      });

      expect(dirsOf(target)).toEqual(["/tmp/extra"]);
    });

    it("create mints a session_-prefixed lowercase id when none is supplied", async () => {
      const svc = await build();
      const h = await svc.create({ workDir: "/tmp/proj" });

      expect(h.id).toMatch(/^session_[0-9a-f-]{36}$/);
      expect(h.id).toBe(h.id.toLowerCase());
      expect(svc.get(h.id)).toBe(h);
    });

    it("fork mints a session_-prefixed lowercase id when newSessionId is omitted", async () => {
      const svc = await build();

      await svc.create({ sessionId: "src", workDir: "/tmp/proj" });
      const target = await svc.fork({ sourceSessionId: "src" });

      expect(target.id).toMatch(/^session_[0-9a-f-]{36}$/);
      expect(target.id).toBe(target.id.toLowerCase());
      expect(target.id).not.toBe("src");
    });
  });

  describe("fork session state", () => {
    it("copies blobs, plans, background tasks, and media originals into the fork", async () => {
      const root = await makeTmpRoot();
      const svc = await build([
        stubPair(IBootstrapService, tmpBootstrapStub(root)),
      ]);
      await svc.create({ sessionId: "src", workDir: "/tmp/proj" });

      const srcDir = join(root, "sessions", "wd_stub", "src");
      await mkdir(join(srcDir, "agents", "main", "blobs"), { recursive: true });
      await writeFile(
        join(srcDir, "agents", "main", "blobs", "ab12cd"),
        "blob-bytes",
      );
      await mkdir(join(srcDir, "agents", "main", "plans"), { recursive: true });
      await writeFile(
        join(srcDir, "agents", "main", "plans", "p1.md"),
        "# plan",
      );
      await mkdir(join(srcDir, "agents", "main", "tasks", "bash-1"), {
        recursive: true,
      });
      await writeFile(
        join(srcDir, "agents", "main", "tasks", "bash-1.json"),
        "{}",
      );
      await writeFile(
        join(srcDir, "agents", "main", "tasks", "bash-1", "output.log"),
        "out",
      );
      await mkdir(join(srcDir, "media-originals"), { recursive: true });
      await writeFile(join(srcDir, "media-originals", "x.png"), "png");
      await writeFile(join(srcDir, "state.json"), '{"source":true}');
      await writeFile(
        join(srcDir, "agents", "main", "wire.jsonl"),
        '{"type":"metadata"}\n',
      );
      await mkdir(join(srcDir, "logs"), { recursive: true });
      await writeFile(join(srcDir, "logs", "kimi-code.log"), "log");

      await svc.fork({ sourceSessionId: "src", newSessionId: "dst" });

      const dstDir = join(root, "sessions", "wd_stub", "dst");
      await expect(
        readFile(join(dstDir, "agents", "main", "blobs", "ab12cd"), "utf8"),
      ).resolves.toBe("blob-bytes");
      await expect(
        readFile(join(dstDir, "agents", "main", "plans", "p1.md"), "utf8"),
      ).resolves.toBe("# plan");
      await expect(
        readFile(
          join(dstDir, "agents", "main", "tasks", "bash-1.json"),
          "utf8",
        ),
      ).resolves.toBe("{}");
      await expect(
        readFile(
          join(dstDir, "agents", "main", "tasks", "bash-1", "output.log"),
          "utf8",
        ),
      ).resolves.toBe("out");
      await expect(
        readFile(join(dstDir, "media-originals", "x.png"), "utf8"),
      ).resolves.toBe("png");
      await expect(stat(join(dstDir, "state.json"))).rejects.toThrow();
      await expect(
        stat(join(dstDir, "agents", "main", "wire.jsonl")),
      ).rejects.toThrow();
      await expect(stat(join(dstDir, "logs"))).rejects.toThrow();
    });

    it("loads the copied session tool policy before returning the fork", async () => {
      const root = await makeTmpRoot();
      const bootstrap = tmpBootstrapStub(root);
      const srcDir = join(root, "sessions", "wd_stub", "src");
      const dstPolicy = join(
        root,
        "sessions",
        "wd_stub",
        "dst",
        "tool-policy",
        "state.json",
      );
      let readyCount = 0;
      let disabledTools: readonly string[] = [];
      const policy = {
        ...sessionToolPolicyStub(),
        get ready(): Promise<void> {
          readyCount += 1;
          if (readyCount === 1) return Promise.resolve();
          return readFile(dstPolicy, "utf8").then((raw) => {
            disabledTools = (
              JSON.parse(raw) as { disabledTools: readonly string[] }
            ).disabledTools;
          });
        },
        disabledTools: () => disabledTools,
      } satisfies ISessionToolPolicy;
      const svc = await build([
        stubPair(IBootstrapService, bootstrap),
        stubPair(ISessionToolPolicy, policy),
      ]);
      await svc.create({ sessionId: "src", workDir: "/tmp/proj" });
      await mkdir(join(srcDir, "tool-policy"), { recursive: true });
      await writeFile(
        join(srcDir, "tool-policy", "state.json"),
        '{"disabledTools":["Skill"]}',
      );

      const target = await svc.fork({
        sourceSessionId: "src",
        newSessionId: "dst",
      });

      expect(target.accessor.get(ISessionToolPolicy).disabledTools()).toEqual([
        "Skill",
      ]);
    });

    it("rolls back the target session when fork fails after materializing", async () => {
      const root = await makeTmpRoot();
      const srcDir = join(root, "sessions", "wd_stub", "src");
      const svc = await build([
        stubPair(IBootstrapService, tmpBootstrapStub(root)),
        stubPair(ISessionMetadata, {
          ...metadataStub(),
          read: () =>
            Promise.resolve({
              agents: { main: {} },
            } as never),
        }),
      ]);
      await svc.create({ sessionId: "src", workDir: "/tmp/proj" });
      await mkdir(join(srcDir, "agents", "main", "plans"), { recursive: true });
      await writeFile(
        join(srcDir, "agents", "main", "plans", "p1.md"),
        "# plan",
      );
      const dstDir = join(root, "sessions", "wd_stub", "dst");

      await expect(
        svc.fork({ sourceSessionId: "src", newSessionId: "dst" }),
      ).rejects.toThrow("not implemented");

      expect(svc.get("dst")).toBeUndefined();
      await expect(stat(dstDir)).rejects.toThrow();
      await expect(
        svc.fork({ sourceSessionId: "src", newSessionId: "dst" }),
      ).rejects.toThrow("not implemented");
    });

    it("duplicates the source session cron tasks for the fork", async () => {
      const root = await makeTmpRoot();
      const cron = cronStoreStub([
        {
          id: "task-src",
          cron: "0 9 * * *",
          prompt: "standup",
          createdAt: 1,
          tags: { [CRON_SESSION_TAG]: "src" },
        },
        {
          id: "task-other",
          cron: "0 9 * * *",
          prompt: "other",
          createdAt: 1,
          tags: { [CRON_SESSION_TAG]: "other" },
        },
        { id: "task-untagged", cron: "* * * * *", prompt: "x", createdAt: 1 },
      ]);
      const svc = await build([
        stubPair(IBootstrapService, tmpBootstrapStub(root)),
        stubPair(ICronTaskPersistence, cron),
      ]);
      await svc.create({ sessionId: "src", workDir: "/tmp/proj" });

      await svc.fork({ sourceSessionId: "src", newSessionId: "dst" });

      const all = [...cron.docs.values()];
      expect(all).toHaveLength(4);
      const clone = all.find((task) => task.tags?.[CRON_SESSION_TAG] === "dst");
      expect(clone).toMatchObject({
        cron: "0 9 * * *",
        prompt: "standup",
        createdAt: 1,
      });
      expect(clone!.id).not.toBe("task-src");
      expect(cron.docs.get("task-src")!.tags![CRON_SESSION_TAG]).toBe("src");
    });
  });

  describe("defaultPlanMode bootstrap", () => {
    it("enters plan mode on a fresh session when config.defaultPlanMode is true", async () => {
      const { lifecycle, enter, create } = agentLifecycleCapturingPlanSpy();
      const svc = await build([
        stubPair(IConfigService, configStub({ defaultPlanMode: true })),
        stubPair(IAgentLifecycleService, lifecycle),
      ]);

      await svc.create({ sessionId: "s1", workDir: "/tmp/proj" });

      expect(create).toHaveBeenCalledTimes(1);
      expect(enter).toHaveBeenCalledTimes(1);
    });

    it("leaves plan mode inactive when config.defaultPlanMode is absent", async () => {
      const { lifecycle, enter, create } = agentLifecycleCapturingPlanSpy();
      const svc = await build([
        stubPair(IConfigService, configStub({})),
        stubPair(IAgentLifecycleService, lifecycle),
      ]);

      await svc.create({ sessionId: "s1", workDir: "/tmp/proj" });

      expect(create).not.toHaveBeenCalled();
      expect(enter).not.toHaveBeenCalled();
    });

    it("does not apply config.defaultPlanMode when resuming a session", async () => {
      const workDir = "/tmp/proj";
      const summary = {
        id: "s1",
        workspaceId: "wd_stub",
        cwd: workDir,
      } as SessionSummary;
      const { lifecycle, enter, create } = agentLifecycleCapturingPlanSpy({
        mainPreexists: true,
      });
      const svc = await build([
        stubPair(IConfigService, configStub({ defaultPlanMode: true })),
        stubPair(IAgentLifecycleService, lifecycle),
        stubPair(ISessionIndex, {
          ...sessionIndexStub(),
          get: () => Promise.resolve(summary),
        }),
      ]);

      await svc.resume("s1");

      expect(create).not.toHaveBeenCalled();
      expect(enter).not.toHaveBeenCalled();
    });
  });
});

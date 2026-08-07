/**
 * Scenario: KimiHarness session creation and resume transport behavior.
 * Responsibilities: SDK options reach the in-process core and session identity remains stable.
 * Wiring: the real SDK/core are used; model/network boundaries are configured but never called.
 * Run: bun -C packages/node-sdk exec vitest run test/create-session-transport.test.ts
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Kaos } from "@moonshot-ai/kaos";
import { createKimiHarnessV2, KimiHarness } from "#/index";
import type { KimiError } from "#/index";
import type { ResumeSessionInput, ResumedSessionSummary } from "#/types";
import { SDKRpcClientBase } from "#/rpc";
import { afterEach, describe, expect, it } from "vitest";

import { waitForAgentWireEvent } from "./session-runtime-helpers";
    await writeFile(join(homeDir, "mcp.json"), "{not json}", "utf-8");
    const harness = createKimiHarnessV2({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      await expect(
        harness.createSession({ id: "ses_bad_mcp_config", workDir }),
      ).rejects.toMatchObject({
        name: "KimiError",
        code: "config.invalid",
      });
      expect(await harness.listSessions({ workDir })).toEqual([]);
      expect(existsSync(join(homeDir, "session_index.jsonl"))).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("does not persist a session record when the requested agent profile is missing", async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarnessV2({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      await expect(
        harness.createSession({
          id: "ses_missing_agent_profile",
          workDir,
          agentProfile: "missing-agent",
        }),
      ).rejects.toMatchObject({
        name: "KimiError",
        code: "agent.not_found",
      });
      expect(await harness.listSessions({ workDir })).toEqual([]);
      expect(existsSync(join(homeDir, "session_index.jsonl"))).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("allows the session ID to be reused after agent profile selection fails", async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarnessV2({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      await expect(
        harness.createSession({
          id: "ses_reusable_after_missing_profile",
          workDir,
          agentProfile: "missing-agent",
        }),
      ).rejects.toMatchObject({ code: "agent.not_found" });

      await expect(
        harness.createSession({
          id: "ses_reusable_after_missing_profile",
          workDir,
        }),
      ).resolves.toMatchObject({ id: "ses_reusable_after_missing_profile" });
    } finally {
      await harness.close();
    }
  });

  it("does not persist a session record when an explicit agent file cannot be loaded", async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarnessV2({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      await expect(
        harness.createSession({
          id: "ses_missing_explicit_agent_file",
          workDir,
          agentFiles: [join(workDir, "missing-agent.md")],
        }),
      ).rejects.toThrow(/missing-agent\.md/);
      expect(await harness.listSessions({ workDir })).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("closes active runtime handles through closeSession, session.close, and close", async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    await writeTestModelConfig(homeDir);
    const harness = createKimiHarnessV2({
      identity: TEST_IDENTITY,
      homeDir,
    });

    const first = await harness.createSession({
      id: "ses_close_one",
      workDir,
      model: "kimi-test-model",
    });
    const second = await harness.createSession({
      id: "ses_close_two",
      workDir,
      model: "kimi-test-model",
    });
    expect(coreSessionIds(harness)).toEqual([first.id, second.id]);

    await harness.closeSession(first.id);
    expect(harness.getSession(first.id)).toBeUndefined();
    expect(coreSessionIds(harness)).toEqual([second.id]);

    await second.close();
    expect(harness.getSession(second.id)).toBeUndefined();
    expect(coreSessionIds(harness)).toEqual([]);

    await harness.close();
    expect(harness.sessions.size).toBe(0);
    expect(coreSessionIds(harness)).toEqual([]);
  });

  it("permanently deletes an active session", async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarnessV2({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({
        id: "ses_delete_active",
        workDir,
      });
      const [summary] = await harness.listSessions({ sessionId: session.id });

      await harness.deleteSession(session.id);

      expect(harness.getSession(session.id)).toBeUndefined();
      await expect(
        harness.listSessions({ sessionId: session.id }),
      ).resolves.toEqual([]);
      expect(existsSync(summary!.sessionDir)).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("returns session.not_found when deleteSession targets a missing id", async () => {
    const homeDir = await makeTempDir();
    const harness = createKimiHarnessV2({ identity: TEST_IDENTITY, homeDir });

    try {
      await expect(
        harness.deleteSession("ses_delete_missing"),
      ).rejects.toMatchObject({
        name: "KimiError",
        code: "session.not_found",
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  });

  it("allows a deleted session id to be created again", async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarnessV2({ identity: TEST_IDENTITY, homeDir });
    const sessionId = "ses_delete_recreate";

    try {
      await harness.createSession({ id: sessionId, workDir });
      await harness.deleteSession(sessionId);

      const recreated = await harness.createSession({ id: sessionId, workDir });

      expect(recreated.id).toBe(sessionId);
      await expect(harness.listSessions({ sessionId })).resolves.toHaveLength(
        1,
      );
    } finally {
      await harness.close();
    }
  });

  it("preserves a legacy source directory referenced by session metadata", async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const legacySourceDir = await makeTempDir();
    const markerPath = join(legacySourceDir, "legacy-marker.txt");
    await writeFile(markerPath, "legacy source remains", "utf-8");
    const harness = createKimiHarnessV2({ identity: TEST_IDENTITY, homeDir });

    try {
      const session = await harness.createSession({
        id: "ses_delete_migrated",
        workDir,
        metadata: { kimi_cli_source_path: legacySourceDir },
      });

      await harness.deleteSession(session.id);

      await expect(readFile(markerPath, "utf-8")).resolves.toBe(
        "legacy source remains",
      );
    } finally {
      await harness.close();
    }
  });

  it("applies initial thinking and permission runtime options", async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarnessV2({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({
        id: "ses_initial_runtime_options",
        workDir,
        thinking: "low",
        permission: "auto",
      });

      await expect(
        waitForAgentWireEvent(
          homeDir,
          session.id,
          "config.update",
          (event) => event["thinkingEffort"] === "low",
        ),
      ).resolves.toMatchObject({
        type: "config.update",
        thinkingEffort: "low",
      });
      await expect(
        waitForAgentWireEvent(
          homeDir,
          session.id,
          "permission.set_mode",
          (event) => event["mode"] === "auto",
        ),
      ).resolves.toMatchObject({
        type: "permission.set_mode",
        mode: "auto",
      });
    } finally {
      await harness.close();
    }
  });

  it("applies configured default permission mode to new sessions", async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    await writeFile(
      join(homeDir, "config.toml"),
      'default_permission_mode = "auto"\n',
      "utf-8",
    );
    const harness = createKimiHarnessV2({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({
        id: "ses_default_permission_mode",
        workDir,
      });

      await expect(session.getStatus()).resolves.toMatchObject({
        permission: "auto",
      });
      await expect(
        waitForAgentWireEvent(
          homeDir,
          session.id,
          "permission.set_mode",
          (event) => event["mode"] === "auto",
        ),
      ).resolves.toMatchObject({
        type: "permission.set_mode",
        mode: "auto",
      });

      const explicit = await harness.createSession({
        id: "ses_default_permission_explicit_override",
        workDir,
        permission: "manual",
      });
      await expect(explicit.getStatus()).resolves.toMatchObject({
        permission: "manual",
      });
    } finally {
      await harness.close();
    }
  });

  it("rebinds an active session when resumeSession receives a new Kaos", async () => {
    const rpc = new StubRpc();
    const harness = new KimiHarness(rpc, {
      homeDir: "/tmp/home",
      configPath: "/tmp/config.toml",
      auth: { status: async () => ({ providers: [] }) } as never,
      engineAuth: {
        status: async () => ({ loggedIn: false }),
        summarize: async () => [],
        startLogin: async () => ({
          flow_id: "flow",
          provider: "opencode",
          status: "authenticated" as const,
        }),
        flow: async () => undefined,
        cancelLogin: async () => ({
          cancelled: false,
          status: "cancelled" as const,
        }),
        logout: async () => ({
          logged_out: true as const,
          provider: "opencode",
        }),
      },
      ensureConfigFile: async () => undefined,
      onClose: () => undefined,
    });

    const session = await harness.createSession({
      id: "ses_active",
      workDir: "/tmp/work",
    });
    const kaos = {} as Kaos;

    const resumed = await harness.resumeSession({ id: session.id, kaos });

    expect(resumed).toBe(session);
    expect(rpc.resumeCalls).toHaveLength(1);
    expect(rpc.resumeCalls[0]).toMatchObject({
      input: { id: "ses_active" },
      kaos,
      persistenceKaos: undefined,
    });
  });

  it("rejects an active session resume when the requested profile differs from its binding", async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    await writeTestModelConfig(homeDir);
    await writeReviewerAgent(workDir);
    const harness = createKimiHarnessV2({ identity: TEST_IDENTITY, homeDir });

    try {
      const session = await harness.createSession({
        id: "ses_active_profile_identity",
        workDir,
        agentProfile: "reviewer",
      });

      await expect(
        harness.resumeSession({ id: session.id, agentProfile: "agent" }),
      ).rejects.toThrow(
        'agent is already bound to profile "reviewer"; cannot switch to "agent" in this session',
      );
    } finally {
      await harness.close();
    }
  });

  it("returns the active session when the requested profile matches its binding", async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    await writeTestModelConfig(homeDir);
    await writeReviewerAgent(workDir);
    const harness = createKimiHarnessV2({ identity: TEST_IDENTITY, homeDir });

    try {
      const session = await harness.createSession({
        id: "ses_matching_profile_identity",
        workDir,
        agentProfile: "reviewer",
      });

      await expect(
        harness.resumeSession({ id: session.id, agentProfile: "reviewer" }),
      ).resolves.toBe(session);
    } finally {
      await harness.close();
    }
  });

  it("rejects a persisted session resume when the requested profile differs from its binding", async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    await writeTestModelConfig(homeDir);
    await writeReviewerAgent(workDir);
    const harness = createKimiHarnessV2({ identity: TEST_IDENTITY, homeDir });

    try {
      const session = await harness.createSession({
        id: "ses_persisted_profile_identity",
        workDir,
        agentProfile: "reviewer",
      });
      await session.close();

      await expect(
        harness.resumeSession({ id: session.id, agentProfile: "agent" }),
      ).rejects.toThrow(
        'agent is already bound to profile "reviewer"; cannot switch to "agent" in this session',
      );
    } finally {
      await harness.close();
    }
  });
});

function coreSessionIds(harness: KimiHarness): readonly string[] {
  const core = (
    harness as unknown as {
      readonly rpc: {
        readonly core: { readonly sessions: ReadonlyMap<string, unknown> };
      };
    }
  ).rpc.core;
  return Array.from(core.sessions.keys()).toSorted();
}

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WIRE_PROTOCOL_VERSION,
  CHECKPOINTED_MODELS,
  IAgentContextMemoryService,
  IAgentTokenCountingService,
  IAgentGoalService,
  IUserMemoryService,
  type ContextMessage,
  type WireRecord,
} from "#/index";
import {
  InMemoryWireRecordPersistence,
  createTestAgent,
  testAgent,
  type TestAgentContext,
} from "./harness";
import { SyncDescriptor } from "#/_base/di/descriptors";
import { DisposableStore } from "#/_base/di/lifecycle";
import {
  LifecycleScope,
  ScopeActivation,
  _clearScopedRegistryForTests,
  registerScopedService,
} from "#/_base/di/scope";
import {
  TestInstantiationService,
  createScopedTestHost,
  stubPair,
} from "#/_base/di/test";
import { createHooks } from "#/hooks";
import { AppendLogStore } from "#/persistence/backends/node-fs/appendLogStore";
import { FileStorageService } from "#/persistence/backends/node-fs/fileStorageService";
import { InMemoryStorageService } from "#/persistence/backends/memory/inMemoryStorageService";
import { IAppendLogStore } from "#/persistence/interface/appendLogStore";
import { IFileSystemStorageService } from "#/persistence/interface/storage";
import { IBootstrapService } from "#/app/bootstrap/bootstrap";
import { IUserMemoryService } from "#/app/userMemory/userMemory";
import { formatMemoryRecallBlock } from "#/app/userMemory/userMemoryRecall";
import { UserMemoryService } from "#/app/userMemory/userMemoryService";
import { todoSet, TodoModel } from "#/session/todo/todoOps";
import { OP_REGISTRY } from "#/wire/op";
import { MODEL_CROSS_REDUCERS } from "#/wire/model";
import { IWireService } from "#/wire/wire";
import { AGENT_WIRE_RECORD_KEY } from "#/wire/record";
import { registerTestAgentWire, restoreTestAgentWire } from "./wire/stubs";
import {
  buildSessionSummary,
  SessionUserMemoryService,
} from "#/session/userMemory/sessionUserMemoryService";
import { ISessionUserMemoryService } from "#/session/userMemory/sessionUserMemory";
import {
  ISessionLifecycleHooks,
  type SessionLifecycleHookSlots,
} from "#/session/sessionLifecycleHooks/sessionLifecycleHooks";
import { ISessionMetadata } from "#/session/sessionMetadata/sessionMetadata";
import {
  makeSessionContext,
  ISessionContext,
} from "#/session/sessionContext/sessionContext";
import { stubBootstrap } from "./app/bootstrap/stubs";

const V1_RECORD_TYPES: ReadonlySet<string> = new Set([
  "metadata",
  "forked",
  "turn.prompt",
  "turn.steer",
  "turn.cancel",
  "config.update",
  "permission.set_mode",
  "permission.record_approval_result",
  "full_compaction.begin",
  "full_compaction.cancel",
  "full_compaction.complete",
  "micro_compaction.apply",
  "plan_mode.enter",
  "plan_mode.cancel",
  "plan_mode.exit",
  "swarm_mode.enter",
  "swarm_mode.exit",
  "tools.register_user_tool",
  "tools.unregister_user_tool",
  "tools.set_active_tools",
  "tools.update_store",
  "usage.record",
  "context.append_message",
  "context.append_loop_event",
  "context.clear",
  "context.apply_compaction",
  "context.undo",
  "goal.create",
  "goal.update",
  "goal.clear",
  "llm.tools_snapshot",
  "llm.request",
  "mcp.tools_discovered",
]);
// `profile.bind` is deliberately classified v2-only: v1's replay switch has no
// case for it and silently skips the record, so a v1 resume of a v2-bound
// session loses the binding (model / prompt / tool policy), and v1's
// empty-prompt fallback then writes builtin defaults back into the shared
// wire, overwriting the binding for later v2 resumes too. Accepted tradeoff
// for the custom-agent rollout; revisit by teaching v1 to replay the record
// rather than by dual-writing v1-shaped companions from v2.
const V2_ONLY_RECORD_TYPES: ReadonlySet<string> = new Set([
  "tools.reset_active_tools",
  "profile.bind",
]);

// Persisted record types introduced after the v1 vocabulary: the task
// lifecycle journal (the restore seed for ghosts and the cold transcript
// fold), the interaction request/resolution journal, the plan revision
// reference journal, and the terminal turn record. Replay tolerates unknown
// record types (skip + warn), so older readers degrade gracefully.
const V2_RECORD_TYPES: ReadonlySet<string> = new Set([
  "task.started",
  "task.terminated",
  "interaction.request",
  "interaction.resolved",
  "plan.revision",
  "interruptionReminder.recorded",
  "turn.ended",
]);

describe("v1 wire vocabulary", () => {
  const SCOPE = "wire";

  let disposables: DisposableStore;
  let wire: IWireService;
  let log: IAppendLogStore;

  beforeEach(() => {
    disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    log = ix.get(IAppendLogStore);
    wire = registerTestAgentWire(ix, SCOPE, { log });
  });

  afterEach(() => disposables.dispose());

  async function readRecords(): Promise<WireRecord[]> {
    await wire.flush();
    const out: WireRecord[] = [];
    for await (const record of log.read<WireRecord>(
      SCOPE,
      AGENT_WIRE_RECORD_KEY,
    )) {
      out.push(record);
    }
    return out;
  }

  it("every persisted op type is a known (v1 or v2) record type", () => {
    for (const [type, descriptor] of OP_REGISTRY) {
      if (descriptor.persist === false) continue;
      expect(
        V1_RECORD_TYPES.has(type) ||
          V2_ONLY_RECORD_TYPES.has(type) ||
          V2_RECORD_TYPES.has(type),
        `op "${type}" persists an unregistered record type`,
      ).toBe(true);
    }
  });

  it("stamps persisted records with time, except the metadata envelope", async () => {
    await wire.restore();
    wire.dispatch(
      todoSet({ key: "todo", value: [{ title: "x", status: "pending" }] }),
    );

    const records = await readRecords();
    expect(records).toEqual([
      {
        type: "metadata",
        protocol_version: WIRE_PROTOCOL_VERSION,
        created_at: expect.any(Number),
      },
      {
        type: "tools.update_store",
        key: "todo",
        value: [{ title: "x", status: "pending" }],
        time: expect.any(Number),
      },
    ]);
  });

  it("round-trips the todo list through the persisted tools.update_store record", async () => {
    wire.dispatch(
      todoSet({
        key: "todo",
        value: [{ title: "restore me", status: "in_progress" }],
      }),
    );
    const records = await readRecords();

    const store = new DisposableStore();
    disposables.add(store);
    const ix2 = store.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    const log2 = ix2.get(IAppendLogStore);
    const fresh = registerTestAgentWire(ix2, SCOPE, { log: log2 });

    await restoreTestAgentWire(fresh, log2, SCOPE, records);

    expect(fresh.getModel(TodoModel).current).toEqual([
      { title: "restore me", status: "in_progress" },
    ]);
  });
});

describe("conversation-time checkpoint registration", () => {
  // Models that react to context.* records but deliberately stay on world time
  // (ephemeral notice state that must not travel through undo) are exempt.
  // Registering a new context-reacting model without `defineCheckpointedModel`
  // fails this test — add the name here only with a justification.
  const CHECKPOINT_EXEMPT_MODELS: ReadonlySet<string> = new Set([
    // goalForkNotice is one-shot reminder bookkeeping, not conversation state.
    "goalForkNotice",
  ]);
  const CONTEXT_OPS = [
    "context.append_message",
    "context.apply_compaction",
    "context.clear",
    "context.undo",
  ];

  it("registers every context-reacting model as checkpointed or explicitly exempt", () => {
    const violations: string[] = [];
    let entries = 0;
    for (const opType of CONTEXT_OPS) {
      for (const entry of MODEL_CROSS_REDUCERS.get(opType) ?? []) {
        entries += 1;
        if (CHECKPOINTED_MODELS.includes(entry.model)) continue;
        if (CHECKPOINT_EXEMPT_MODELS.has(entry.model.name)) continue;
        violations.push(`${entry.model.name} (on ${opType})`);
      }
    }
    // Guard against a vacuous pass when module loading changes.
    expect(entries).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });
});

describe("AgentRecords persistence metadata", () => {
  let context: IAgentContextMemoryService;
  let tokenCounting: IAgentTokenCountingService;
  let ctx: TestAgentContext;
  let expectResumeMatches: boolean;
  let persistence: RecordingInMemoryWireRecordPersistence;

  beforeEach(() => {
    expectResumeMatches = true;
    persistence = new RecordingInMemoryWireRecordPersistence();
    ctx = createTestAgent({ persistence, autoConfigure: false });
    context = ctx.get(IAgentContextMemoryService);
    tokenCounting = ctx.get(IAgentTokenCountingService);
  });

  afterEach(async () => {
    try {
      if (expectResumeMatches) {
        await ctx.expectResumeMatches();
      }
    } finally {
      await ctx.dispose();
    }
  });

  it("heals an envelope-less stream on restore instead of rejecting it", async () => {
    persistence.records.push({
      type: "context.append_message",
      message: {
        role: "user",
        content: [{ type: "text", text: "orphaned prompt" }],
        toolCalls: [],
        origin: { kind: "user" },
      },
    });

    expectResumeMatches = false;
    await ctx.restorePersisted();

    // The envelope was synthesized and rewritten ahead of the records.
    expect(persistence.records.map((record) => record.type)).toEqual([
      "metadata",
      "context.append_message",
    ]);
    expect(persistence.records[0]).toMatchObject({
      type: "metadata",
      protocol_version: WIRE_PROTOCOL_VERSION,
    });
    // And the orphaned message landed in the restored context.
    expect(ctx.context.get()).toHaveLength(1);
  });

  it("restores existing metadata records without rewriting them", async () => {
    persistence.records.push(
      {
        type: "metadata",
        protocol_version: WIRE_PROTOCOL_VERSION,
        created_at: 1,
      },
      {
        type: "context.append_message",
        message: {
          role: "user",
          content: [{ type: "text", text: "restored" }],
          toolCalls: [],
          origin: { kind: "user" },
        },
      },
    );

    await ctx.restorePersisted();

    expect(persistence.rewrites).toEqual([]);
    expect(
      persistence.records.filter((record) => record.type === "metadata"),
    ).toHaveLength(1);
  });

  it("rewrites migrated records to the current wire version after replay", async () => {
    persistence.records.push(
      {
        type: "metadata",
        protocol_version: "1.0",
        created_at: 1,
      },
      {
        type: "context.append_message",
        message: {
          role: "assistant",
          content: [],
          toolCalls: [
            {
              type: "function",
              id: "call_legacy_bash",
              function: {
                name: "Bash",
                arguments: '{"command":"pwd"}',
              },
            },
          ],
        },
      } as unknown as WireRecord,
    );

    await ctx.restorePersisted();

    expect(persistence.rewrites).toHaveLength(1);
    expect(persistence.records[0]).toMatchObject({
      type: "metadata",
      protocol_version: WIRE_PROTOCOL_VERSION,
    });
    const migrated = persistence.records[1] as unknown as {
      readonly message: {
        readonly toolCalls: readonly Record<string, unknown>[];
      };
    };
    expect(persistence.records[1]?.type).toBe("context.append_message");
    expect(migrated.message.toolCalls[0]).toMatchObject({
      name: "Bash",
      arguments: '{"command":"pwd"}',
    });
    expect(migrated.message.toolCalls[0]?.["function"]).toBeUndefined();
  });

  it("replays a newer wire version without rewriting its metadata", async () => {
    persistence.records.push({
      type: "metadata",
      protocol_version: "9.9",
      created_at: 1,
    });

    await expect(ctx.restorePersisted()).resolves.toBeUndefined();
    expect(persistence.records[0]).toMatchObject({
      type: "metadata",
      protocol_version: "9.9",
    });
  });

  it("rejects replaying records without a registered migration path", async () => {
    persistence.records.push({
      type: "metadata",
      protocol_version: "0.9",
      created_at: 1,
    });

    expectResumeMatches = false;
    await expect(ctx.restorePersisted()).rejects.toThrow(
      "Missing wire migration for version 0.9",
    );
  });

  it("restores goal.* records during replay", async () => {
    persistence.records.push(
      {
        type: "metadata",
        protocol_version: WIRE_PROTOCOL_VERSION,
        created_at: 1,
      },
      {
        type: "goal.create",
        goalId: "g1",
        objective: "do work",
        completionCriterion: "tests pass",
      },
      { type: "goal.update", budgetLimits: { turnBudget: 20 } },
      { type: "goal.update", tokensUsed: 5, wallClockMs: 0 },
      { type: "goal.update", turnsUsed: 1 },
      {
        type: "goal.update",
        status: "blocked",
        reason: "needs credentials",
        actor: "model",
      },
    );

    await expect(ctx.restorePersisted()).resolves.toBeUndefined();
    expect(context.get()).toHaveLength(0);
    expect(ctx.get(IAgentGoalService).getGoal().goal).toMatchObject({
      goalId: "g1",
      objective: "do work",
      completionCriterion: "tests pass",
      status: "blocked",
      turnsUsed: 1,
      tokensUsed: 5,
      terminalReason: "needs credentials",
    });
  });

  it("restores forked records as fork boundaries that clear copied goals", async () => {
    persistence.records.push(
      {
        type: "metadata",
        protocol_version: WIRE_PROTOCOL_VERSION,
        created_at: 1,
      },
      {
        type: "goal.create",
        goalId: "source-goal",
        objective: "source work",
      },
      { type: "forked", time: 2 },
    );

    await expect(ctx.restorePersisted()).resolves.toBeUndefined();
    expect(
      persistence.records.slice(0, 3).map((record) => record.type),
    ).toEqual(["metadata", "goal.create", "forked"]);
    expect(ctx.get(IAgentGoalService).getGoal().goal).toBeNull();
    const reminder = context.get().at(-1);
    expect(reminder?.origin).toEqual({
      kind: "system_trigger",
      name: "goal_fork_cleared",
    });
    expect(JSON.stringify(reminder?.content)).toContain(
      "This fork does not have a current goal.",
    );
  });

  it("keeps goals created after the forked boundary", async () => {
    persistence.records.push(
      {
        type: "metadata",
        protocol_version: WIRE_PROTOCOL_VERSION,
        created_at: 1,
      },
      {
        type: "goal.create",
        goalId: "source-goal",
        objective: "source work",
      },
      { type: "forked", time: 2 },
      {
        type: "goal.create",
        goalId: "fork-goal",
        objective: "fork work",
      },
    );

    await expect(ctx.restorePersisted()).resolves.toBeUndefined();
    expect(ctx.get(IAgentGoalService).getGoal().goal).toMatchObject({
      goalId: "fork-goal",
      objective: "fork work",
    });
    expect(context.get().at(-1)?.origin).toEqual({
      kind: "system_trigger",
      name: "goal_fork_cleared",
    });
  });

  it("does not add a fork-cleared reminder when a forked record has no copied goal", async () => {
    persistence.records.push(
      {
        type: "metadata",
        protocol_version: WIRE_PROTOCOL_VERSION,
        created_at: 1,
      },
      { type: "forked", time: 2 },
    );

    await expect(ctx.restorePersisted()).resolves.toBeUndefined();
    expect(context.get()).toHaveLength(0);
  });

  it("preconstructs context size restore handlers during runtime activation", async () => {
    await ctx.restore([
      {
        type: "metadata",
        protocol_version: WIRE_PROTOCOL_VERSION,
        created_at: 1,
      },
      {
        type: "context.append_message",
        message: {
          role: "user",
          content: [{ type: "text", text: "restored prompt" }],
          toolCalls: [],
        },
      },
      {
        type: "token_counting.measured",
        length: 1,
        tokens: 42,
      },
      {
        type: "usage.record",
        model: "restored-model",
        usageScope: "turn",
        usage: {
          inputOther: 40,
          output: 2,
          inputCacheRead: 0,
          inputCacheCreation: 0,
        },
      },
    ]);

    expect(context.get()).toHaveLength(1);
    expect(tokenCounting.get()).toEqual({
      size: 42,
      measured: 42,
      estimated: 0,
    });
  });
});

describe("user memory v1", () => {
  let homeDir: string;
  let disposeHost: (() => void) | undefined;

  beforeEach(async () => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      IUserMemoryService,
      UserMemoryService,
      ScopeActivation.OnDemand,
      "userMemory",
    );
    registerScopedService(
      LifecycleScope.Session,
      ISessionUserMemoryService,
      SessionUserMemoryService,
      ScopeActivation.OnScopeCreated,
      "userMemory",
    );
    homeDir = await mkdtemp(join(tmpdir(), "kimi-user-memory-"));
  });

  afterEach(async () => {
    disposeHost?.();
    disposeHost = undefined;
    await rm(homeDir, { recursive: true, force: true });
  });

  function buildMemoryHost(): IUserMemoryService {
    const fileStorage = new FileStorageService(homeDir);
    const host = createScopedTestHost([
      stubPair(IFileSystemStorageService, fileStorage),
      stubPair(IBootstrapService, stubBootstrap(homeDir)),
    ]);
    disposeHost = () => {
      host.dispose();
    };
    return host.app.accessor.get(IUserMemoryService);
  }

  it("appends to CURRENT.md and topic documents under memory/topics", async () => {
    const memory = buildMemoryHost();
    await memory.append({ text: "Prefers TypeScript", source: "test" });
    await memory.appendTopic("coding-style", "Uses 2-space indentation");

    const current = await readFile(
      join(homeDir, "memory", "CURRENT.md"),
      "utf8",
    );
    expect(current).toContain("Prefers TypeScript");
    expect(current).toContain("source=test");

    const topic = await readFile(
      join(homeDir, "memory", "topics", "coding-style.md"),
      "utf8",
    );
    expect(topic).toContain("Uses 2-space indentation");
  });

  it("stages a rule-based session summary on onWillCloseSession", async () => {
    const fileStorage = new FileStorageService(homeDir);
    const sessionId = "sess-memory";
    const sessionScope = `sessions/test-workspace/${sessionId}`;
    const metadata: {
      id: string;
      title?: string;
      lastPrompt?: string;
      createdAt: number;
      updatedAt: number;
      archived: boolean;
      read(): Promise<typeof metadata>;
    } = {
      id: sessionId,
      title: "Memory test session",
      lastPrompt: "remember my editor preference",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      archived: false,
      read: async () => metadata,
    };
    const hooks = createHooks<
      SessionLifecycleHookSlots,
      keyof SessionLifecycleHookSlots
    >(["onWillCloseSession"]);
    const host = createScopedTestHost([
      stubPair(IFileSystemStorageService, fileStorage),
      stubPair(IBootstrapService, stubBootstrap(homeDir)),
    ]);
    disposeHost = () => {
      host.dispose();
    };
    const session = host.app.createChild(LifecycleScope.Session, sessionId, {
      extra: [
        [
          ISessionContext as never,
          makeSessionContext({
            sessionId,
            workspaceId: "test-workspace",
            sessionDir: join(homeDir, sessionScope),
            sessionScope,
            cwd: "/tmp/project",
          }),
        ],
        [ISessionMetadata as never, metadata],
        [ISessionLifecycleHooks as never, hooks],
      ],
    });
    session.accessor.get(ISessionUserMemoryService);
    await hooks.onWillCloseSession.run({ reason: "exit" });

    const current = await readFile(
      join(homeDir, "memory", "CURRENT.md"),
      "utf8",
    );
    expect(current).toContain("Memory test session");
    expect(current).toContain("remember my editor preference");
    expect(current).toContain("source=session-close");
  });

  it("formats bounded recall for session-start injection", async () => {
    const memory = buildMemoryHost();
    await memory.append({
      text: "Long-term fact: deploy on Fridays",
      source: "test",
    });
    await memory.appendTopic("deploy", "Staging must pass before prod");

    const reminder = await memory.formatRecallForInjection(800);
    expect(reminder).toContain("<user_memory_recall>");
    expect(reminder).toContain("deploy on Fridays");
    expect(reminder).toContain("### deploy");
    expect(reminder).toContain("Staging must pass before prod");
  });

  it("formats recall blocks with a token budget", () => {
    const block = formatMemoryRecallBlock(
      {
        current: "alpha beta gamma",
        topics: [{ name: "prefs", text: "dark mode" }],
      },
      4,
    );
    expect(block).toContain("<user_memory_recall>");
    expect(block?.length ?? 0).toBeLessThan(200);
  });

  it("builds a compact session summary stub", () => {
    expect(
      buildSessionSummary({
        sessionId: "sess-1",
        reason: "archive",
        title: "Ship memory",
        lastPrompt: "x".repeat(250),
      }),
    ).toContain("sess-1 closed (archive)");
  });
});

describe.skip("agent replay range build", () => {});

class RecordingInMemoryWireRecordPersistence extends InMemoryWireRecordPersistence {
  readonly rewrites: WireRecord[][] = [];

  override rewrite(records: readonly WireRecord[]): void {
    this.rewrites.push([...records]);
    super.rewrite(records);
  }
}

function userMessage(text: string): ContextMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    toolCalls: [],
  };
}

function compactionSummaryMessage(text: string): ContextMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    toolCalls: [],
    origin: { kind: "compaction_summary" },
  };
}

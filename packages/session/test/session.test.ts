import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  append,
  applyCompact,
  buildCompactCheckpoint,
  buildCompactCheckpointFromConversation,
  createSession,
  forkSession,
  listSessions,
  load,
  openSession,
  transformContext,
} from "../src/index";

describe("session archive", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kimi-next-session-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("appends and loads conversation records", async () => {
    const handle = await createSession(dir, "sess-1");
    await append(handle, {
      kind: "system",
      id: "sys-1",
      text: "You are helpful.",
    });
    await append(handle, {
      kind: "user",
      id: "user-1",
      content: [{ type: "text", text: "Hello" }],
    });

    const loaded = await load(handle);
    expect(loaded).toHaveLength(2);
    expect(loaded[0]?.kind).toBe("system");
    expect(loaded[1]?.kind).toBe("user");
  });

  it("lists, opens, and forks sessions without changing the source", async () => {
    const source = await createSession(dir, "sess-source");
    await append(source, {
      kind: "user",
      id: "user-1",
      content: [{ type: "text", text: "Hello" }],
    });

    expect(await listSessions(dir)).toEqual([
      source,
    ]);
    const opened = await openSession(dir, "sess-source");
    expect(await load(opened)).toHaveLength(1);

    const fork = await forkSession(opened);
    expect(fork.id).not.toBe(source.id);
    expect(await load(fork)).toEqual(await load(source));
    expect(await listSessions(dir)).toHaveLength(2);
  });
});

describe("transformContext", () => {
  const system = {
    kind: "system" as const,
    id: "sys-1",
    text: "System prompt",
  };

  const user = (id: string, text: string) => ({
    kind: "user" as const,
    id,
    content: [{ type: "text" as const, text }],
  });

  it("keeps full archive length while derived context is shorter after compact", () => {
    const checkpoint = buildCompactCheckpoint({
      progress: "Implemented session storage",
      filesTouched: ["packages/session/src/archive.ts"],
      validation: "tests pass",
      nextSteps: "wire agent loop",
    });

    const archive = [
      system,
      user("u1", "first"),
      user("u2", "second"),
      checkpoint,
      user("u3", "third"),
      user("u4", "fourth"),
    ];

    expect(archive).toHaveLength(6);

    const derived = transformContext(archive);
    expect(derived.length).toBeLessThan(archive.length);
    expect(derived[0]).toEqual(system);
    expect(derived[1]?.kind).toBe("user");
    expect(derived[derived.length - 1]?.id).toBe("u4");
    expect(derived.some((record) => record.kind === "compact_checkpoint")).toBe(
      false,
    );
    expect(derived.some((record) => record.id === "u1")).toBe(false);
    expect(derived.some((record) => record.id === "u2")).toBe(false);
  });

  it("applyCompact appends without deleting history", () => {
    const archive = [system, user("u1", "hello")];
    const checkpoint = buildCompactCheckpoint({
      progress: "done",
      filesTouched: [],
      validation: "ok",
      nextSteps: "continue",
    });
    const extended = applyCompact(archive, checkpoint);
    expect(extended).toHaveLength(3);
    expect(extended[2]).toEqual(checkpoint);
  });

  it("does not mutate the source archive", () => {
    const archive = [system, user("u1", "hello")];
    const before = archive.length;
    transformContext(archive);
    expect(archive).toHaveLength(before);
  });
});

describe("buildCompactCheckpointFromConversation", () => {
  it("builds heuristic checkpoint from tool activity", async () => {
    const archive = [
      {
        kind: "user" as const,
        id: "u1",
        content: [{ type: "text" as const, text: "edit foo.ts" }],
      },
      {
        kind: "assistant" as const,
        id: "a1",
        text: ["Updated foo.ts"],
        reasoning: { mode: "none" as const },
        toolCalls: [
          {
            id: "tc1",
            name: "write",
            arguments: JSON.stringify({ path: "foo.ts", content: "x" }),
          },
        ],
        preserved: {},
      },
      {
        kind: "tool_result" as const,
        id: "tr1",
        callId: "tc1",
        content: "ok",
        isError: false,
      },
    ];

    const checkpoint = await buildCompactCheckpointFromConversation(archive);
    expect(checkpoint.kind).toBe("compact_checkpoint");
    expect(checkpoint.progress).toContain("Updated foo.ts");
    expect(checkpoint.filesTouched).toContain("foo.ts");
    expect(checkpoint.validation).toContain("succeeded");
  });

  it("applies summarize hook when provided", async () => {
    const archive = [
      {
        kind: "assistant" as const,
        id: "a1",
        text: ["done"],
        reasoning: { mode: "none" as const },
        toolCalls: [],
        preserved: {},
      },
    ];
    const checkpoint = await buildCompactCheckpointFromConversation(archive, {
      summarize: async (draft) => ({
        ...draft,
        progress: "refined progress",
        nextSteps: "refined next",
      }),
    });
    expect(checkpoint.progress).toBe("refined progress");
    expect(checkpoint.nextSteps).toBe("refined next");
  });
});

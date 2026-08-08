import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activateSkill,
  loadHooks,
  loadSkills,
  resolveInstructionFile,
} from "../src/index";

const temporaryDirs: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "kimi-next-discover-"));
  temporaryDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirs
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

describe("instruction discovery", () => {
  it("uses AGENTS.md before CLAUDE.md in the same directory", async () => {
    const cwd = await temporaryDirectory();
    await writeFile(join(cwd, "AGENTS.md"), "agents");
    await writeFile(join(cwd, "CLAUDE.md"), "claude");

    expect(await resolveInstructionFile(cwd)).toEqual({
      path: join(cwd, "AGENTS.md"),
      kind: "AGENTS.md",
    });
  });

  it("finds the nearest parent instruction file", async () => {
    const parent = await temporaryDirectory();
    const cwd = join(parent, "nested", "project");
    await mkdir(cwd, { recursive: true });
    await writeFile(join(parent, "AGENTS.md"), "parent");

    expect(await resolveInstructionFile(cwd)).toEqual({
      path: join(parent, "AGENTS.md"),
      kind: "AGENTS.md",
    });
  });
});

describe("skill discovery", () => {
  it("keeps the first skill with a duplicate name and omits body", async () => {
    const cwd = await temporaryDirectory();
    const first = join(cwd, ".claude", "skills", "shared");
    const second = join(cwd, "skills", "other");
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    const frontmatter = (body: string) =>
      `---\nname: shared\ndescription: Shared skill\n---\n${body}`;
    await writeFile(join(first, "SKILL.md"), frontmatter("claude"));
    await writeFile(join(second, "SKILL.md"), frontmatter("plain"));

    const skills = await loadSkills(cwd);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: "shared",
      sourceRoot: join(cwd, ".claude"),
    });
    expect(skills[0]?.body).toBeUndefined();

    const activated = await activateSkill(skills[0]!);
    expect(activated.body).toBe("claude");
  });

  it("indexes nested skills as parent.child", async () => {
    const cwd = await temporaryDirectory();
    const leaf = join(cwd, ".agents", "skills", "review", "security");
    await mkdir(leaf, { recursive: true });
    await writeFile(
      join(leaf, "SKILL.md"),
      "---\nname: review.security\ndescription: Security review\n---\nCheck auth.\n",
    );

    const skills = await loadSkills(cwd);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: "review.security",
      parent: "review",
      description: "Security review",
    });
    expect(skills[0]?.body).toBeUndefined();
  });

  it("truncates oversized skill bodies on activate", async () => {
    const cwd = await temporaryDirectory();
    const dir = join(cwd, "skills", "huge");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      `---\nname: huge\ndescription: Big\n---\n${"x".repeat(100)}\n`,
    );
    const [skill] = await loadSkills(cwd);
    const activated = await activateSkill(skill!, 40);
    expect(activated.body?.length).toBe(40);
    expect(activated.truncated).toBe(true);
  });
});

describe("hook discovery", () => {
  it("warns about unknown events and loads known events", async () => {
    const cwd = await temporaryDirectory();
    const root = join(cwd, ".agents");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "hooks.json"),
      JSON.stringify({
        hooks: {
          UnknownEvent: [{ command: "ignored" }],
          SessionStart: [{ command: "echo started" }],
        },
      }),
    );

    const registry = await loadHooks(cwd);
    expect(registry.hooks.get("SessionStart")).toEqual({
      event: "SessionStart",
      command: "echo started",
      sourceRoot: root,
    });
    expect(registry.hooks.size).toBe(1);
    expect(registry.warnings).toEqual([
      `Unknown hook event "UnknownEvent" in ${join(root, "hooks.json")}`,
    ]);
  });
});

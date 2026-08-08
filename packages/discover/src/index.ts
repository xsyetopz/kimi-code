import { readFile, readdir, stat } from "node:fs/promises";
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const INSTRUCTION_FILES = [
  "AGENTS.md",
  "agents.md",
  "CLAUDE.md",
  "GEMINI.md",
  "AGENT.md",
  ".agents.md",
] as const;

export const COMPAT_ROOT_NAMES = [
  ".agents",
  ".kimi-next",
  ".pi",
  ".claude",
  ".codex",
  ".goose",
] as const;

export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PreCompact",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Default max chars kept when activating a skill body. */
export const DEFAULT_SKILL_BODY_BUDGET = 32_000;

/**
 * Skill catalog entry. Index loads omit `body`; call `activateSkill` to load it.
 */
export interface SkillMeta {
  readonly name: string;
  readonly description: string;
  readonly dir: string;
  readonly skillPath: string;
  readonly sourceRoot: string;
  readonly parent?: string;
  readonly body?: string;
  readonly truncated?: boolean;
}

export interface HookEntry {
  readonly event: HookEvent;
  readonly command: string;
  readonly sourceRoot: string;
}

export interface HookRegistry {
  readonly hooks: Map<HookEvent, HookEntry>;
  readonly warnings: string[];
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function resolveInstructionFile(
  startDir: string,
): Promise<{ path: string; kind: string } | null> {
  let directory = resolve(startDir);
  while (true) {
    for (const filename of INSTRUCTION_FILES) {
      const path = join(directory, filename);
      if (await isFile(path)) return { path, kind: filename };
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

export async function resolveInstructionFileNear(
  filePath: string,
): Promise<{ path: string; kind: string } | null> {
  return resolveInstructionFile(dirname(resolve(filePath)));
}

export function enumerateCompatRoots(cwd: string): string[] {
  const directory = resolve(cwd);
  const roots: string[] = [];
  for (const name of COMPAT_ROOT_NAMES) {
    const path = join(directory, name);
    try {
      if (statSync(path).isDirectory()) roots.push(path);
    } catch {
      // Missing roots are normal.
    }
  }
  return roots;
}

interface SkillFrontmatter {
  readonly name: string;
  readonly description: string;
  readonly parent?: string;
  readonly body: string;
}

function parseSkillFrontmatter(raw: string): SkillFrontmatter | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) return null;
  let name = "";
  let description = "";
  let parent: string | undefined;
  for (const line of match[1]!.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key === "name") name = value;
    if (key === "description") description = value;
    if (key === "parent") parent = value;
  }
  if (!name || !description) return null;
  if (parent === undefined) {
    return { name, description, body: match[2]!.trim() };
  }
  return { name, description, parent, body: match[2]!.trim() };
}

function isSafeSegment(name: string): boolean {
  return name.length > 0 && !name.includes("..") && !name.includes("/");
}

async function walkSkillTree(
  root: string,
  sourceRoot: string,
  pathParts: readonly string[],
  out: SkillMeta[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }

  const skillPath = join(root, "SKILL.md");
  if (pathParts.length > 0 && (await isFile(skillPath))) {
    try {
      const parsed = parseSkillFrontmatter(await readFile(skillPath, "utf8"));
      if (parsed) {
        const pathName = pathParts.join(".");
        const name =
          pathParts.length > 1 && !parsed.name.includes(".")
            ? pathName
            : parsed.name;
        const parent =
          parsed.parent ??
          (pathParts.length > 1 ? pathParts.slice(0, -1).join(".") : undefined);
        const entry: SkillMeta = {
          name,
          description: parsed.description,
          dir: root,
          skillPath,
          sourceRoot,
        };
        if (parent !== undefined) {
          out.push({ ...entry, parent });
        } else {
          out.push(entry);
        }
      }
    } catch {
      // Invalid or unreadable skills are non-fatal.
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeSegment(entry.name)) continue;
    if (entry.name === "node_modules") continue;
    await walkSkillTree(
      join(root, entry.name),
      sourceRoot,
      [...pathParts, entry.name],
      out,
    );
  }
}

async function readSkillsRoot(
  root: string,
  sourceRoot: string,
): Promise<SkillMeta[]> {
  const skills: SkillMeta[] = [];
  await walkSkillTree(root, sourceRoot, [], skills);
  return skills;
}

/** Index skills without retaining bodies (activate with `activateSkill`). */
export async function loadSkills(cwd: string): Promise<SkillMeta[]> {
  const directory = resolve(cwd);
  const roots = enumerateCompatRoots(directory);
  const skillRoots = roots.map((root) => ({
    path: join(root, "skills"),
    sourceRoot: root,
  }));
  const plainSkills = join(directory, "skills");
  try {
    if ((await stat(plainSkills)).isDirectory()) {
      skillRoots.push({ path: plainSkills, sourceRoot: directory });
    }
  } catch {
    // Plain skills root is optional.
  }
  const byName = new Map<string, SkillMeta>();
  for (const root of skillRoots) {
    for (const skill of await readSkillsRoot(root.path, root.sourceRoot)) {
      if (!byName.has(skill.name)) byName.set(skill.name, skill);
    }
  }
  return [...byName.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

/** Load skill body from disk; truncates past budget and sets `truncated`. */
export async function activateSkill(
  skill: SkillMeta,
  budget: number = DEFAULT_SKILL_BODY_BUDGET,
): Promise<SkillMeta> {
  if (skill.body !== undefined) {
    if (skill.body.length <= budget) return skill;
    return {
      ...skill,
      body: skill.body.slice(0, budget),
      truncated: true,
    };
  }
  const raw = await readFile(skill.skillPath, "utf8");
  const parsed = parseSkillFrontmatter(raw);
  if (!parsed) throw new Error(`Invalid skill: ${skill.name}`);
  const truncated = parsed.body.length > budget;
  const body = truncated ? parsed.body.slice(0, budget) : parsed.body;
  const next: SkillMeta = {
    name: skill.name,
    description: skill.description,
    dir: skill.dir,
    skillPath: skill.skillPath,
    sourceRoot: skill.sourceRoot,
    body,
  };
  if (skill.parent !== undefined) {
    return truncated
      ? { ...next, parent: skill.parent, truncated: true }
      : { ...next, parent: skill.parent };
  }
  return truncated ? { ...next, truncated: true } : next;
}

interface RawHookConfig {
  readonly [key: string]: unknown;
}

function hookEventsFromConfig(config: RawHookConfig): RawHookConfig {
  const nested = config["hooks"];
  return nested !== null && typeof nested === "object"
    ? (nested as RawHookConfig)
    : config;
}

async function firstHooksFile(root: string): Promise<string | null> {
  for (const path of [
    join(root, "hooks.json"),
    join(root, "hooks", "hooks.json"),
  ]) {
    if (await isFile(path)) return path;
  }
  return null;
}

export async function loadHooks(cwd: string): Promise<HookRegistry> {
  const hooks = new Map<HookEvent, HookEntry>();
  const warnings: string[] = [];
  for (const sourceRoot of enumerateCompatRoots(cwd)) {
    const path = await firstHooksFile(sourceRoot);
    if (!path) continue;
    let config: RawHookConfig;
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        warnings.push(`Invalid hooks config: ${path}`);
        continue;
      }
      config = parsed as RawHookConfig;
    } catch {
      warnings.push(`Invalid hooks config: ${path}`);
      continue;
    }
    const eventConfig = hookEventsFromConfig(config);
    for (const [event, value] of Object.entries(eventConfig)) {
      if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
        warnings.push(`Unknown hook event "${event}" in ${path}`);
        continue;
      }
      if (hooks.has(event as HookEvent)) continue;
      if (!Array.isArray(value) || value.length === 0) continue;
      const first = value[0];
      if (first === null || typeof first !== "object") continue;
      const command = (first as { command?: unknown }).command;
      if (typeof command === "string" && command.length > 0) {
        hooks.set(event as HookEvent, {
          event: event as HookEvent,
          command,
          sourceRoot,
        });
      }
    }
  }
  return { hooks, warnings };
}

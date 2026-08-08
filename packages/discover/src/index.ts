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
  ".kimi-code",
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

export interface SkillMeta {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly dir: string;
  readonly sourceRoot: string;
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

function parseSkill(
  raw: string,
  dir: string,
  sourceRoot: string,
): SkillMeta | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) return null;
  let name = "";
  let description = "";
  for (const line of match[1]!.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key === "name") name = value;
    if (key === "description") description = value;
  }
  if (!name || !description) return null;
  return { name, description, body: match[2]!.trim(), dir, sourceRoot };
}

async function readSkillsRoot(
  root: string,
  sourceRoot: string,
): Promise<SkillMeta[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills: SkillMeta[] = [];
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      entry.name.includes("..") ||
      entry.name.includes("/")
    ) {
      continue;
    }
    const dir = join(root, entry.name);
    try {
      const skillPath = join(dir, "SKILL.md");
      if (!(await isFile(skillPath))) continue;
      const skill = parseSkill(
        await readFile(skillPath, "utf8"),
        dir,
        sourceRoot,
      );
      if (skill) skills.push(skill);
    } catch {
      // Invalid or unreadable skills are non-fatal.
    }
  }
  return skills;
}

export async function loadSkills(cwd: string): Promise<SkillMeta[]> {
  const directory = resolve(cwd);
  const roots = enumerateCompatRoots(directory);
  const skillRoots = roots.map((root) => ({
    path: join(root, "skills"),
    sourceRoot: root,
  }));
  const plainSkills = join(directory, "skills");
  if ((await isFile(plainSkills)) === false) {
    try {
      if ((await stat(plainSkills)).isDirectory()) {
        skillRoots.push({ path: plainSkills, sourceRoot: directory });
      }
    } catch {
      // Plain skills root is optional.
    }
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

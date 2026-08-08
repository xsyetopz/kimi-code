import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface SkillMeta {
  readonly name: string;
  readonly description: string;
  readonly dir: string;
  readonly body?: string;
}

/**
 * Load Agent Skills from `skills/<name>/SKILL.md` (agentskills.io).
 * Invalid skills are skipped (non-fatal).
 */
export async function loadSkills(rootDir: string): Promise<SkillMeta[]> {
  const skillsDir = join(rootDir, "skills");
  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch {
    return [];
  }

  const skills: SkillMeta[] = [];
  for (const name of entries) {
    if (name.includes("/") || name.includes("..")) continue;
    const skillPath = join(skillsDir, name, "SKILL.md");
    try {
      const raw = await readFile(skillPath, "utf8");
      const meta = parseSkillFrontmatter(raw, name, join(skillsDir, name));
      if (meta) skills.push(meta);
    } catch {
      // skip bad skill
    }
  }
  return skills;
}

export async function activateSkill(skill: SkillMeta): Promise<SkillMeta> {
  if (skill.body !== undefined) return skill;
  const raw = await readFile(join(skill.dir, "SKILL.md"), "utf8");
  const parsed = parseSkillFrontmatter(raw, skill.name, skill.dir);
  if (!parsed) throw new Error(`Invalid skill: ${skill.name}`);
  return parsed;
}

/** Convert an activated skill into text suitable for the agent system prompt. */
export function skillToSystemInstruction(skill: SkillMeta): string {
  const body = skill.body?.trim();
  if (!body) {
    return `Skill "${skill.name}": ${skill.description}`;
  }
  return `## Skill: ${skill.name}\n\n${body}`;
}

/** Load a skill if necessary, then return its system-prompt instruction. */
export async function activateSkillInstruction(
  skill: SkillMeta,
): Promise<string> {
  return skillToSystemInstruction(await activateSkill(skill));
}

function parseSkillFrontmatter(
  raw: string,
  expectedName: string,
  dir: string,
): SkillMeta | null {
  if (!raw.startsWith("---")) return null;
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return null;
  const fm = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).trim();
  const fields = new Map<string, string>();
  for (const line of fm.split("\n")) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    fields.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const name = fields.get("name");
  const description = fields.get("description");
  if (!name || !description) return null;
  if (name !== expectedName) return null;
  return { name, description, dir, body };
}

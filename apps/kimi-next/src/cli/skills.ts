import {
  activateSkill,
  loadSkills as discoverSkills,
  type SkillMeta,
} from "@kimi-next/discover";

export type { SkillMeta };

export async function loadSkillsFromCwd(cwd: string): Promise<SkillMeta[]> {
  return discoverSkills(cwd);
}

export function formatSkillsMetadata(skills: readonly SkillMeta[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map((skill) => {
    const label = skill.parent
      ? `${skill.name} (parent=${skill.parent})`
      : skill.name;
    return `- ${label}: ${skill.description || "(no description)"}`;
  });
  return [
    "Available skills (activate with /skill-name or /skill name; bodies load on demand):",
    ...lines,
  ].join("\n");
}

export function findSkill(
  skills: readonly SkillMeta[],
  name: string,
): SkillMeta | undefined {
  return skills.find((skill) => skill.name === name);
}

const REPL_COMMANDS = new Set([
  "auth",
  "compact",
  "cost",
  "diff",
  "effort",
  "export",
  "exit",
  "help",
  "login",
  "logout",
  "model",
  "new",
  "quit",
  "segment",
  "skills",
  "skill",
  "toggle-raw",
  "toggle-thinking",
  "yolo",
  "provider",
  "base-url",
  "usage",
  "plan",
  "implement",
  "privilege",
  "review",
]);

export function extractInlineSkillCalls(
  text: string,
  availableSkills: readonly SkillMeta[],
): { cleanText: string; skillNames: string[] } {
  const knownNames = new Set(availableSkills.map((skill) => skill.name));
  const wholeLine = text
    .trim()
    .match(/^\/([a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*)(?:\s|$)/i)?.[1];
  if (wholeLine && REPL_COMMANDS.has(wholeLine.toLowerCase())) {
    return { cleanText: text, skillNames: [] };
  }

  const skillNames: string[] = [];
  const seen = new Set<string>();
  const cleanText = text.replace(
    /(^|[\s([{'"`])\/([a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*)/gi,
    (match, prefix: string, name: string) => {
      if (!knownNames.has(name)) return match;
      if (!seen.has(name)) {
        seen.add(name);
        skillNames.push(name);
      }
      return prefix.trim().length > 0 ? prefix : "";
    },
  );
  return { cleanText, skillNames };
}

export async function activateInlineSkills(
  names: readonly string[],
  skills: readonly SkillMeta[],
): Promise<string> {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  const parts: string[] = [];
  for (const name of names) {
    const skill = byName.get(name);
    if (!skill) continue;
    const activated = await activateSkill(skill);
    const body = activated.body ?? "";
    const note = activated.truncated ? "\n[skill body truncated]" : "";
    parts.push(`[Inline skill: ${activated.name}]\n${body}${note}`);
  }
  return parts.join("\n\n");
}

export { activateSkill };

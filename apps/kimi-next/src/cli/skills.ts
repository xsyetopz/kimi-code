import { loadSkills as discoverSkills } from "@kimi-next/discover";

export interface SkillMeta {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly dir: string;
}

export async function loadSkillsFromCwd(cwd: string): Promise<SkillMeta[]> {
  return discoverSkills(cwd);
}

export function formatSkillsMetadata(skills: readonly SkillMeta[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map(
    (skill) => `- ${skill.name}: ${skill.description || "(no description)"}`,
  );
  return ["Available skills:", ...lines].join("\n");
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
]);

export function extractInlineSkillCalls(
  text: string,
  availableSkills: readonly SkillMeta[],
): { cleanText: string; skillNames: string[] } {
  const knownNames = new Set(availableSkills.map((skill) => skill.name));
  const wholeLine = text.trim().match(/^\/([a-z0-9-]+)(?:\s|$)/i)?.[1];
  if (wholeLine && REPL_COMMANDS.has(wholeLine.toLowerCase())) {
    return { cleanText: text, skillNames: [] };
  }

  const skillNames: string[] = [];
  const seen = new Set<string>();
  const cleanText = text.replace(
    /(^|[\s([{'"`])\/([a-z0-9-]+)/g,
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
  return names
    .map((name) => {
      const skill = byName.get(name);
      return skill ? `[Inline skill: ${skill.name}]\n${skill.body}` : "";
    })
    .filter((body) => body.length > 0)
    .join("\n\n");
}

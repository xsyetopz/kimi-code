import type { SkillSummary } from "@moonshot-ai/kimi-code-sdk";

import {
  buildSkillSlashCommands,
  isUserActivatableSkill,
} from "#/tui/commands/skills";

export const INLINE_SKILL_TOKEN_PREFIX = "/skill:";

const INLINE_SKILL_NAME_PATTERN = /[a-zA-Z0-9][a-zA-Z0-9._-]*/;
const INLINE_SKILL_TOKEN_RE = new RegExp(
  `/${INLINE_SKILL_TOKEN_PREFIX.slice(1)}(${INLINE_SKILL_NAME_PATTERN.source})`,
  "g",
);

const TOKEN_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);

export interface InlineSkillInvocation {
  readonly commandName: string;
  readonly skillName: string;
  readonly start: number;
  readonly end: number;
}

export interface SkillPickerEntry {
  readonly commandName: string;
  readonly skillName: string;
  readonly description: string;
  readonly label: string;
}

export function buildDedupedSkillPickerEntries(
  skills: readonly SkillSummary[],
): readonly SkillPickerEntry[] {
  const built = buildSkillSlashCommands(skills);
  const seen = new Set<string>();
  const entries: SkillPickerEntry[] = [];
  for (const command of built.commands) {
    const skillName = built.commandMap.get(command.name);
    if (skillName === undefined || seen.has(skillName)) continue;
    if (!command.name.startsWith("skill:")) continue;
    seen.add(skillName);
    entries.push({
      commandName: command.name,
      skillName,
      description: command.description,
      label: `/${command.name}`,
    });
  }
  return entries;
}

export function extractInlineSkillPrefix(text: string): string | null {
  let tokenStart = 0;
  for (let i = text.length - 1; i >= 0; i -= 1) {
    if (TOKEN_DELIMITERS.has(text[i] ?? "")) {
      tokenStart = i + 1;
      break;
    }
  }
  const token = text.slice(tokenStart);
  if (!token.startsWith(INLINE_SKILL_TOKEN_PREFIX)) return null;
  return token;
}

export function parseInlineSkillInvocations(
  text: string,
  skillCommandMap: ReadonlyMap<string, string>,
): { invocations: InlineSkillInvocation[]; strippedText: string } | null {
  const invocations: InlineSkillInvocation[] = [];
  for (const match of text.matchAll(INLINE_SKILL_TOKEN_RE)) {
    const rawName = match[1];
    if (rawName === undefined) continue;
    const commandName = `${INLINE_SKILL_TOKEN_PREFIX.slice(1)}${rawName}`;
    const skillName = skillCommandMap.get(commandName);
    if (skillName === undefined) continue;
    const start = match.index ?? 0;
    invocations.push({
      commandName,
      skillName,
      start,
      end: start + match[0].length,
    });
  }
  if (invocations.length === 0) return null;

  let strippedText = "";
  let cursor = 0;
  for (const invocation of invocations) {
    strippedText += text.slice(cursor, invocation.start);
    cursor = invocation.end;
  }
  strippedText += text.slice(cursor);
  strippedText = strippedText.replace(/\s{2,}/g, " ").trim();

  return { invocations, strippedText };
}

export function filterSkillPickerEntries(
  entries: readonly SkillPickerEntry[],
  prefix: string,
): readonly SkillPickerEntry[] {
  const query = prefix.slice(INLINE_SKILL_TOKEN_PREFIX.length).toLowerCase();
  if (query.length === 0) return entries;
  return entries.filter((entry) => {
    const name = entry.skillName.toLowerCase();
    return name.startsWith(query) || name.includes(query);
  });
}

export function isUserActivatableSkillSummary(skill: SkillSummary): boolean {
  return isUserActivatableSkill(skill);
}

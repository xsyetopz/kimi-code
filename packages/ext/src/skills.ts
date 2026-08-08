/**
 * Skills loading is owned by `@kimi-next/discover` (first-found + hierarchy).
 * This module re-exports the discover API so `@kimi-next/ext` stays a single
 * extension surface without a second loader.
 */
export {
  activateSkill,
  DEFAULT_SKILL_BODY_BUDGET,
  loadSkills,
  type SkillMeta,
} from "@kimi-next/discover";

import { activateSkill, type SkillMeta } from "@kimi-next/discover";

/** Convert an activated skill into text suitable for the agent system prompt. */
export function skillToSystemInstruction(skill: SkillMeta): string {
  const body = skill.body?.trim();
  if (!body) {
    return `Skill "${skill.name}": ${skill.description}`;
  }
  const note = skill.truncated ? "\n\n[skill body truncated]" : "";
  return `## Skill: ${skill.name}\n\n${body}${note}`;
}

/** Load a skill body if necessary, then return its system-prompt instruction. */
export async function activateSkillInstruction(
  skill: SkillMeta,
): Promise<string> {
  return skillToSystemInstruction(await activateSkill(skill));
}

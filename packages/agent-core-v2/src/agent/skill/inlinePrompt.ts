/**
 * `skill` domain — inline `/skill:<name>` token parsing for prompt text.
 */

const INLINE_SKILL_TOKEN_PREFIX = "/skill:";
const INLINE_SKILL_NAME_PATTERN = /[a-zA-Z0-9][a-zA-Z0-9._-]*/;
const INLINE_SKILL_TOKEN_RE = new RegExp(
  `/${INLINE_SKILL_TOKEN_PREFIX.slice(1)}(${INLINE_SKILL_NAME_PATTERN.source})`,
  "g",
);

export interface InlineSkillInvocation {
  readonly name: string;
  readonly args?: string;
}

export function parseInlineSkillInvocations(text: string): InlineSkillInvocation[] {
  const invocations: InlineSkillInvocation[] = [];
  for (const match of text.matchAll(INLINE_SKILL_TOKEN_RE)) {
    const name = match[1];
    if (name === undefined) continue;
    invocations.push({ name });
  }
  return invocations;
}

export function stripInlineSkillTokens(text: string): string {
  return text
    .replace(INLINE_SKILL_TOKEN_RE, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

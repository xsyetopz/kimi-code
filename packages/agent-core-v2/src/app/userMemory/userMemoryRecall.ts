import type { UserMemoryRecall } from "./userMemory";

export const CHARS_PER_TOKEN_ESTIMATE = 4;

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

export function truncateToTokenBudget(text: string, maxTokens: number): string {
  if (maxTokens <= 0 || text.length === 0) return "";
  const maxChars = maxTokens * CHARS_PER_TOKEN_ESTIMATE;
  if (text.length <= maxChars) return text;
  return `…${text.slice(-(maxChars - 1))}`;
}

export function formatMemoryRecallBlock(
  recall: UserMemoryRecall,
  maxTokens: number,
): string | undefined {
  const current = recall.current.trim();
  const topics = recall.topics
    .map((topic) => ({
      name: topic.name,
      text: topic.text.trim(),
    }))
    .filter((topic) => topic.text.length > 0);
  if (current.length === 0 && topics.length === 0) return undefined;

  const sections: string[] = ["<user_memory_recall>"];
  let budget = maxTokens;

  if (current.length > 0) {
    const body = truncateToTokenBudget(current, budget);
    sections.push("## Recent buffer (CURRENT)", body);
    budget = Math.max(0, budget - estimateTokens(body));
  }

  if (topics.length > 0 && budget > 0) {
    sections.push("## Topics");
    const perTopicBudget = Math.max(1, Math.floor(budget / topics.length));
    for (const topic of topics) {
      if (budget <= 0) break;
      const excerpt = truncateToTokenBudget(
        topic.text,
        Math.min(budget, perTopicBudget),
      );
      if (excerpt.length === 0) continue;
      sections.push(`### ${topic.name}`, excerpt);
      budget = Math.max(0, budget - estimateTokens(excerpt));
    }
  }

  sections.push("</user_memory_recall>");
  return sections.join("\n\n");
}

export function sanitizeTopicSlug(topic: string): string {
  const slug = topic
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "general";
}

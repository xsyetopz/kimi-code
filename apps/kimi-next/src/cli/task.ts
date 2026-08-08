export interface ActiveTask {
  readonly title: string;
  readonly instruction: string;
}

export function createTask(title: string): ActiveTask {
  const normalized = title.trim();
  if (!normalized) throw new Error("Task title cannot be empty");
  return {
    title: normalized,
    instruction: `Stay focused on the active task "${normalized}". Keep all actions and explanations aligned with completing it.`,
  };
}

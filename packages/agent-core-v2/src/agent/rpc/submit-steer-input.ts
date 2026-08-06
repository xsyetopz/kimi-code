import type { ContextMessage } from "#/agent/contextMemory/types";
import type { Turn } from "#/agent/loop/loop";
import type { IAgentPromptService } from "#/agent/prompt/prompt";

/**
 * Deliver steer input into the running turn when one exists, or inject a fresh
 * turn when the prompt queue is idle (goal continuations, between-turn gaps).
 *
 * The naive enqueue-then-steer path fails once `enqueue` launches immediately
 * because there is no active prompt — the prompt is already running and no
 * longer pending.
 */
export async function submitSteerInput(
  promptService: IAgentPromptService,
  message: ContextMessage,
): Promise<Turn | undefined> {
  if (promptService.list().active === undefined) {
    return promptService.inject(message);
  }

  const queued = await promptService.enqueue({ message });
  if (queued.state !== "pending") {
    return queued.launched;
  }

  const [steered] = await promptService.steer([queued.id]);
  return steered?.launched;
}

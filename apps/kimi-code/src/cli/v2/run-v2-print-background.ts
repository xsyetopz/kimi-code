import {
  type DomainEvent,
  type PrintBackgroundMode,
} from "@moonshot-ai/kimi-code-sdk";

/** Re-check `goalActive` at least this often while waiting for goal turns. */
const GOAL_WAIT_POLL_MS = 250;
/**
 * Slack on top of a scheduled cron fire time while waiting for the steered
 * turn: covers the 1s tick poll interval plus fire → inject → turn-launch
 * latency.
 */
const CRON_FIRE_GRACE_MS = 5_000;

export type PrintTurnEnding = Extract<DomainEvent, { type: "turn.ended" }>;

/**
 * Source of `turn.ended` events for the print steer loop. `next` resolves with
 * the next ending (skipping `skipTurnId`, the main turn's own buffered
 * ending), or `null` when `remainingMs` elapses first.
 */
export interface PrintTurnEndings {
  next(
    remainingMs: number,
    skipTurnId: number,
  ): Promise<PrintTurnEnding | null>;
}

/**
 * Buffered `turn.ended` collector fed from the agent event bus. Events that
 * arrive while no one is waiting are queued, so endings that fire between the
 * main turn settling and the policy loop starting are not missed.
 */
export function createPrintTurnEndings(): PrintTurnEndings & {
  push: (event: PrintTurnEnding) => void;
} {
  const buffer: PrintTurnEnding[] = [];
  let waiter: ((ending: PrintTurnEnding | null) => void) | undefined;
  return {
    push: (event) => {
      const resolve = waiter;
      if (resolve !== undefined) {
        waiter = undefined;
        resolve(event);
        return;
      }
      buffer.push(event);
    },
    next: async (remainingMs, skipTurnId) => {
      const deadlineAt = Date.now() + remainingMs;
      const waitOnce = (ms: number): Promise<PrintTurnEnding | null> =>
        new Promise((resolve) => {
          let settled = false;
          const settle = (value: PrintTurnEnding | null): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            waiter = undefined;
            // oxlint-disable-next-line promise/no-multiple-resolved -- `settled` guards the single resolve; the rule cannot see it
            resolve(value);
          };
          const timer = Number.isFinite(ms)
            ? setTimeout(() => {
                settle(null);
              }, ms)
            : undefined;
          waiter = settle;
        });
      for (;;) {
        while (buffer.length > 0) {
          const ending = buffer.shift()!;
          if (ending.turnId !== skipTurnId) return ending;
        }
        const ms = deadlineAt - Date.now();
        if (ms <= 0) return null;
        const ending = await waitOnce(ms);
        if (ending === null) return null;
        if (ending.turnId !== skipTurnId) return ending;
        // The skipped turn's own ending: keep waiting within the same budget.
      }
    },
  };
}

/** A background-task completion steered a new main turn that did not complete. */
export class PrintSteeredTurnFailedError extends Error {}

export interface PrintBackgroundPolicyInput {
  readonly mode: PrintBackgroundMode;
  readonly ceilingS: number;
  readonly maxTurns: number;
  readonly countPending: () => number;
  readonly drain: () => Promise<void>;
  readonly turnEndings: PrintTurnEndings;
  readonly skipTurnId: number;
  readonly warn: (message: string) => void;
  readonly now: () => number;
  /**
   * Reports whether an agent goal is still `active`. Goal continuation runs as
   * new turns, so a `-p` goal run must stay alive until the goal leaves
   * `active`, independent of the background policy.
   */
  readonly goalActive?: () => boolean;
  /**
   * Reports the next scheduled cron fire time (epoch ms), or `null` when no
   * cron task has a future fire. While it returns non-null the policy keeps
   * the process alive — the cron tick timer itself is unref'd — waiting for
   * the fire to steer a new turn, then re-evaluating (a fired one-shot task
   * disappears; a recurring one reports its advanced next fire). Cron
   * liveness is independent of the background mode: it applies under
   * `exit`/`drain` too. Omitted = no cron waiting.
   */
  readonly cronNextFireAt?: () => number | null;
}

/**
 * Apply the print-mode (`kimi -p`) background-resource policy after the main
 * turn completes. A single loop re-evaluates the Session's live resources in
 * order on every round and stays alive while any of them is pending:
 *  - goal    : while a goal is `active`, keep waiting for its continuation
 *              turns (bounded by `ceilingS` as a safety net), regardless of
 *              the background mode; the goal summary drives the exit code.
 *  - cron    : while `cronNextFireAt` reports a future fire, keep waiting —
 *              the cron tick timer is unref'd, so the process must hold the
 *              event loop itself (independent of the mode). The
 *              fire steers a new turn; a steered turn that does not complete
 *              fails the run. Each round re-reads the next fire time, so a
 *              fired one-shot task ends the wait while a recurring one keeps
 *              it. A fire time that stays unchanged and in the past across
 *              two consecutive rounds means the tick is wedged: warn once and
 *              stop cron waiting instead of spinning.
 *  - mode    : 'exit'  → return immediately;
 *              'drain' → suppress + drain background tasks, then return;
 *              'steer' → while background tasks are still pending, stay alive
 *              so task completions steer new main turns; return once
 *              quiescent, or when the wall-clock ceiling (`ceilingS`) or the
 *              turn cap (`maxTurns`) is reached. A steered turn that does not
 *              complete fails the run.
 * The steer ceiling deadline is set once on entry, so goal/cron waiting
 * consumes the same budget.
 */
export async function applyPrintBackgroundPolicy(
  input: PrintBackgroundPolicyInput,
): Promise<void> {
  const deadline = input.now() + input.ceilingS * 1000;
  let turns = 0;
  // Cron anti-spin guard: the last fire time seen already in the past. Two
  // consecutive rounds with the same past fire time mean the tick never ran.
  let lastPastFireAt: number | undefined;
  let cronWedged = false;
  for (;;) {
    // (a) goal: while a goal is `active`, keep waiting for its continuation
    // turns. Also wake on a short poll: a goal can leave `active` without any
    // further turn.ended (budget block at a turn boundary, or a pause after a
    // continuation-launch failure), which would otherwise hang the run until
    // the ceiling. A continuation turn that does not complete pauses/blocks
    // the goal, so the condition exits on the next check.
    while (input.goalActive?.() === true) {
      const ended = await input.turnEndings.next(
        Math.min(deadline - input.now(), GOAL_WAIT_POLL_MS),
        input.skipTurnId,
      );
      if (ended === null && input.now() >= deadline) {
        input.warn(
          `print goal wait ceiling reached (${input.ceilingS}s), finishing`,
        );
        return;
      }
    }

    // (b) cron: keep the process alive until the pending fire steered a turn
    // (one-shot tasks vanish after firing; recurring ones advance their next
    // fire), then re-evaluate from the top.
    if (!cronWedged && input.cronNextFireAt !== undefined) {
      const fireAt = input.cronNextFireAt();
      if (fireAt !== null) {
        if (fireAt <= input.now() && lastPastFireAt === fireAt) {
          cronWedged = true;
          input.warn(
            "print cron wait: next fire time stuck in the past; cron tick appears wedged, giving up on cron",
          );
        } else {
          if (fireAt <= input.now()) lastPastFireAt = fireAt;
          const ended = await input.turnEndings.next(
            Math.max(fireAt - input.now(), 0) + CRON_FIRE_GRACE_MS,
            input.skipTurnId,
          );
          if (ended !== null && ended.reason !== "completed") {
            throw new PrintSteeredTurnFailedError(
              formatTurnEndingFailure(ended),
            );
          }
          // Fire observed (or its grace elapsed without a turn): re-read the
          // next fire time from the top.
          continue;
        }
      }
    }

    // (c) background-task mode.
    if (input.mode === "exit") return;
    if (input.mode === "drain") {
      await input.drain();
      return;
    }

    // 'steer'
    turns += 1;
    if (input.now() >= deadline) {
      input.warn(`print steer ceiling reached (${input.ceilingS}s), finishing`);
      return;
    }
    if (turns > input.maxTurns) {
      input.warn(
        `print steer max turns reached (${input.maxTurns}), finishing`,
      );
      return;
    }
    if (input.countPending() === 0) return;
    const ended = await input.turnEndings.next(
      deadline - input.now(),
      input.skipTurnId,
    );
    if (ended === null) return;
    if (ended.reason !== "completed") {
      throw new PrintSteeredTurnFailedError(formatTurnEndingFailure(ended));
    }
  }
}

function formatTurnEndingFailure(ending: PrintTurnEnding): string {
  if (ending.error?.code === "provider.filtered") {
    return "Provider safety policy blocked the response.";
  }
  if (ending.error !== undefined)
    return `${ending.error.code}: ${ending.error.message}`;
  if (ending.reason === "blocked") {
    return "Prompt hook blocked the request.";
  }
  return `Prompt turn ended with reason: ${ending.reason}`;
}

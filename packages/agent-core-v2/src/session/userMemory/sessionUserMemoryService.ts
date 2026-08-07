/**
 * `sessionUserMemory` domain — `ISessionUserMemoryService` implementation.
 *
 * Registers with the per-session `sessionLifecycleHooks` `onWillCloseSession`
 * slot and appends a rule-based session summary to the App-scope
 * `IUserMemoryService` `CURRENT` buffer via `sessionMetadata` and
 * `sessionContext`. Bound at Session scope.
 */

import { Disposable } from "#/_base/di/lifecycle";
import {
  LifecycleScope,
  ScopeActivation,
  registerScopedService,
} from "#/_base/di/scope";
import { IUserMemoryService } from "#/app/userMemory/userMemory";
import type { Hooks } from "#/hooks";
import { ISessionContext } from "#/session/sessionContext/sessionContext";
import {
  ISessionLifecycleHooks,
  type SessionCloseReason,
  type SessionLifecycleHookSlots,
} from "#/session/sessionLifecycleHooks/sessionLifecycleHooks";
import { ISessionMetadata } from "#/session/sessionMetadata/sessionMetadata";

import { ISessionUserMemoryService } from "./sessionUserMemory";

export class SessionUserMemoryService
  extends Disposable
  implements ISessionUserMemoryService
{
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionContext private readonly context: ISessionContext,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @ISessionLifecycleHooks lifecycleHooks: Hooks<SessionLifecycleHookSlots>,
    @IUserMemoryService private readonly memory: IUserMemoryService,
  ) {
    super();
    this._register(
      lifecycleHooks.onWillCloseSession.register(
        "userMemory",
        async (event, next) => {
          await this.stageSessionSummary(event.reason);
          await next();
        },
      ),
    );
  }

  private async stageSessionSummary(reason: SessionCloseReason): Promise<void> {
    const meta = await this.metadata.read();
    const summary = buildSessionSummary({
      sessionId: this.context.sessionId,
      reason,
      title: meta.title,
      lastPrompt: meta.lastPrompt,
    });
    await this.memory.append({ text: summary, source: "session-close" });
  }
}

interface SessionSummaryInput {
  readonly sessionId: string;
  readonly reason: SessionCloseReason;
  readonly title: string | undefined;
  readonly lastPrompt: string | undefined;
}

export function buildSessionSummary(input: SessionSummaryInput): string {
  const title = input.title?.trim() || "Untitled session";
  const parts = [
    `Session ${input.sessionId} closed (${input.reason}): "${title}"`,
  ];
  const lastPrompt = input.lastPrompt?.trim();
  if (lastPrompt !== undefined && lastPrompt.length > 0) {
    const excerpt =
      lastPrompt.length > 200 ? `${lastPrompt.slice(0, 200)}…` : lastPrompt;
    parts.push(`Last prompt: ${excerpt}`);
  }
  return parts.join(". ");
}

registerScopedService(
  LifecycleScope.Session,
  ISessionUserMemoryService,
  SessionUserMemoryService,
  ScopeActivation.OnScopeCreated,
  "userMemory",
);

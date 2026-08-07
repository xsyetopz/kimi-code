// apps/kimi-web/src/composables/client/useWorkspaceState.ts
// Facade — wires workspace/session capability modules and re-exports public API.

import type { ExtendedState } from "./kimi-web-client/types";
import { createAuthConfigActions } from "./workspace-state/auth-config-actions";
import type { WorkspaceStateCtx } from "./workspace-state/context";
import { createCrudActions } from "./workspace-state/crud-actions";
import { createFsActions } from "./workspace-state/fs-actions";
import { createGitDiffActions } from "./workspace-state/git-diff-actions";
import { createInteractionActions } from "./workspace-state/interaction-actions";
import {
  afterLocalTurnStartsSettle,
  beginLocalTurn,
  forgetLocalTurnState,
  isLocalTurnSnapshotCurrent,
  localTurnStartState,
  settleLocalTurn,
} from "./workspace-state/local-turn-state";
import { createModeActions } from "./workspace-state/mode-actions";
import { createPromptQueueActions } from "./workspace-state/prompt-queue-actions";
import { createPromptSubmitActions } from "./workspace-state/prompt-submit-actions";
import { createSessionLoadActions } from "./workspace-state/session-load-actions";
import { createSessionRouteActions } from "./workspace-state/session-route-actions";
import {
  pendingApprovalActions,
  pendingQuestionActions,
  pendingTaskCancellations,
  SESSIONS_INITIAL_PAGE_SIZE,
  startingFirstPromptWorkspaces,
} from "./workspace-state/shared";
import type {
  PersistSessionProfilePatch,
  UseWorkspaceStateDeps,
} from "./workspace-state/types";
import { createWorkspaceActions } from "./workspace-state/workspace-actions";

export type { PersistSessionProfilePatch, UseWorkspaceStateDeps };
export type { LocalTurnStartState } from "./workspace-state/local-turn-state";
export {
  SESSIONS_INITIAL_PAGE_SIZE,
  beginLocalTurn,
  settleLocalTurn,
  forgetLocalTurnState,
  localTurnStartState,
  isLocalTurnSnapshotCurrent,
  afterLocalTurnStartsSettle,
};

export function useWorkspaceState(
  rawState: ExtendedState,
  deps: UseWorkspaceStateDeps,
) {
  const ctx = {} as WorkspaceStateCtx;

  const gitDiff = createGitDiffActions(rawState, deps, ctx);
  const authConfig = createAuthConfigActions(rawState, deps, ctx);
  const interactions = createInteractionActions(rawState, deps, ctx);
  const modes = createModeActions(rawState, deps, ctx);
  const fs = createFsActions(rawState, deps, ctx);
  const promptSubmit = createPromptSubmitActions(rawState, deps, ctx);
  const promptQueue = createPromptQueueActions(rawState, deps, ctx);
  const sessionRoute = createSessionRouteActions(rawState, deps, ctx);
  const workspace = createWorkspaceActions(rawState, deps, ctx);
  const sessionLoad = createSessionLoadActions(rawState, deps, ctx);
  const crud = createCrudActions(rawState, deps, ctx);

  Object.assign(
    ctx,
    gitDiff,
    authConfig,
    interactions,
    modes,
    fs,
    promptSubmit,
    promptQueue,
    sessionRoute,
    workspace,
    sessionLoad,
    crud,
  );

  return {
    ...gitDiff,
    ...authConfig,
    ...interactions,
    ...modes,
    ...fs,
    ...promptSubmit,
    ...promptQueue,
    ...sessionRoute,
    ...workspace,
    ...sessionLoad,
    ...crud,
    localTurnStartState,
    isLocalTurnSnapshotCurrent,
    afterLocalTurnStartsSettle,
    pendingQuestionActions,
    pendingApprovalActions,
    pendingTaskCancellations,
    isStartingFirstPrompt: () => startingFirstPromptWorkspaces.size > 0,
  };
}

export type UseWorkspaceState = ReturnType<typeof useWorkspaceState>;

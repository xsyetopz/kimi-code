import { reactive } from "vue";
import { isDaemonApiError } from "../../../api/errors";

export const MESSAGES_PAGE_SIZE = 50;
export const SESSIONS_INITIAL_PAGE_SIZE = 5;
export const PROMPT_NOT_FOUND_CODE = 40402;
export const WORKSPACE_NOT_FOUND_CODE = 40410;
export const ALREADY_RESOLVED_CODE = 40902;
export const FIRST_LOAD_AUTH_RETRY_MS = 2000;
export const TASK_ALREADY_FINISHED_CODE = 40904;
export const MAX_QUEUE_FLUSH_FAILURES = 3;

export type AuthCheckResult = "proceed" | "retry" | "server-auth-required";

export function isAlreadyResolvedError(err: unknown): boolean {
  return isDaemonApiError(err) && err.code === ALREADY_RESOLVED_CODE;
}

export function isTaskAlreadyFinishedError(err: unknown): boolean {
  return isDaemonApiError(err) && err.code === TASK_ALREADY_FINISHED_CODE;
}

export const pendingQuestionActions = reactive<Record<string, "answer" | "dismiss">>({});
export const pendingApprovalActions = reactive<Record<string, true>>({});
export const pendingTaskCancellations = reactive<Record<string, true>>({});
export const startingFirstPromptWorkspaces = reactive(new Set<string>());
export const queueFlushFailures = new Map<string, { key: string; count: number }>();

let queueEntryCounter = 0;
export function nextQueueEntryId(): string {
  queueEntryCounter += 1;
  return `${Date.now().toString(36)}-${queueEntryCounter}`;
}

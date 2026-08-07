/**
 * `task` domain — `AgentTaskService` registration entry.
 *
 * Implementation is split across `taskService.core.ts`,
 * `taskService.termination.ts`, and `taskService.notifications.ts`.
 */

import {
  LifecycleScope,
  ScopeActivation,
  registerScopedService,
} from "#/_base/di/scope";

import { IAgentTaskService } from "./task";
import { AgentTaskServiceNotifications } from "./taskService.notifications";

export {
  isAgentTaskTerminal,
  TaskNotificationStepRequest,
  taskActiveTaskReminderPendingKey,
  taskDeliveredNotificationKeysKey,
  taskGhostsKey,
  taskScheduledNotificationKeysKey,
} from "./taskService.support";

export class AgentTaskService extends AgentTaskServiceNotifications {}

registerScopedService(
  LifecycleScope.Agent,
  IAgentTaskService,
  AgentTaskService,
  ScopeActivation.OnScopeCreated,
  "task",
);

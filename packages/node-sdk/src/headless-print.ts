/**
 * Headless print (`kimi -p`) engine surface — re-exports the agent-core-v2
 * symbols the CLI print runner wires directly. Hosts must not import
 * `@moonshot-ai/agent-core-v2` for this path; use this module instead.
 */

export {
  applyPrintModeConfigDefaults,
  bootstrap,
  ensureMainAgent,
  IAgentGoalService,
  IAgentLifecycleService,
  IAgentPermissionModeService,
  IAgentProfileService,
  IAgentPromptService,
  IAgentTaskService,
  IAuthSummaryService,
  IBootstrapService,
  IConfigService,
  IEventBus,
  ISessionCronService,
  ISessionIndex,
  ISessionLifecycleService,
  IWorkspaceLifecycleService,
  logSeed,
  PRINT_MAX_TURNS_DEFAULT,
  PRINT_WAIT_CEILING_S_DEFAULT,
  resumeSessionById,
  resolveAgentTaskConfig,
  resolvePrintBackgroundMode,
} from "@moonshot-ai/agent-core-v2";

export type {
  BootstrapInput,
  DomainEvent,
  IAgentScopeHandle,
  ISessionScopeHandle,
  LoopRunResult,
  PrintBackgroundMode,
  Scope,
} from "@moonshot-ai/agent-core-v2";

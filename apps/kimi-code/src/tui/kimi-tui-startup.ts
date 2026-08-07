import type { PermissionMode } from "@moonshot-ai/kimi-code-sdk";

import type { CLIOptions } from "#/cli/options";

import type { TuiConfig } from "./config";
import type { AppState } from "./types";

export interface KimiTUIStartupInput {
  readonly cliOptions: CLIOptions;
  /** Profile name resolved from cliOptions --agent/--agent-file (see resolveAgentProfileSelection). */
  readonly agentProfile?: string;
  readonly additionalDirs?: readonly string[];
  readonly tuiConfig: TuiConfig;
  readonly version: string;
  readonly workDir: string;
  readonly startupNotice?: string;
  /** Enables the v2-only startup/session behavior for embedded callers. */
  readonly engineV2?: boolean;
}

export function createInitialAppState(input: KimiTUIStartupInput): AppState {
  const startupPermission: PermissionMode = input.cliOptions.auto
    ? "auto"
    : input.cliOptions.yolo
      ? "yolo"
      : "manual";
  return {
    model: "",
    workDir: input.workDir,
    additionalDirs: [...(input.additionalDirs ?? [])],
    sessionId: "",
    permissionMode: startupPermission,
    planMode: input.cliOptions.plan,
    inputMode: "prompt",
    swarmMode: false,
    thinkingEffort: "off",
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 0,
    isCompacting: false,
    isReplaying: false,
    streamingPhase: "idle",
    streamingStartTime: 0,
    theme: input.tuiConfig.theme,
    version: input.version,
    editorCommand: input.tuiConfig.editorCommand,
    disablePasteBurst: input.tuiConfig.disablePasteBurst,
    notifications: input.tuiConfig.notifications,
    upgrade: input.tuiConfig.upgrade,
    statusLine: input.tuiConfig.statusLine,
    availableModels: {},
    availableProviders: {},
    sessionTitle: null,
    goal: null,
    mcpServersSummary: null,
    banner: undefined,
  };
}

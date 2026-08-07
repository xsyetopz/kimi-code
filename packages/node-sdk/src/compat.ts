// Compat module — replaces @moonshot-ai/kimi-code-sdk imports.
// Re-exports from v2 where possible, local stubs otherwise.

import type {
  ProviderConfig as KosongProviderConfig,
  ProviderRequestAuth,
} from "@moonshot-ai/kosong";
import type { ILogger as V2Logger } from "@moonshot-ai/agent-core-v2/_base/log/log";
import { resolveLoggingConfig as resolveV2LoggingConfig } from "@moonshot-ai/agent-core-v2/_base/log/logConfig";
import { resolveKimiHome as resolveV2KimiHome } from "@moonshot-ai/agent-core-v2/app/bootstrap/bootstrap";
import type {
  AgentReplayRecord,
  ResumedAgentState as V2ResumedAgentState,
} from "@moonshot-ai/agent-core-v2/agent/replayBuilder/types";
import { effectiveModelConfig } from "@moonshot-ai/agent-core-v2/kosong/model/modelAuth";
import type { ModelRecord } from "@moonshot-ai/agent-core-v2/kosong/model/model";
import {
  buildCompactionElisionText,
  collectCompactableUserMessages,
  isRealUserInput,
  selectCompactionUserMessages,
  selectRecentUserMessages,
} from "@moonshot-ai/agent-core-v2/agent/contextMemory/compactionHandoff";
import { renderToolResultForModel } from "@moonshot-ai/agent-core-v2/agent/contextMemory/toolResultRender";
import {
  buildImageCompressionCaption,
  compressBase64ForModel,
  compressImageContentParts,
  compressImageForModel,
  cropImageForModel,
  formatByteSize,
  gateImageFormatParts,
  IMAGE_BYTE_BUDGET,
  MAX_IMAGE_EDGE_PX,
  resolveMaxImageEdgePx,
} from "@moonshot-ai/agent-core-v2/agent/media/image-compress";
import {
  buildUnsupportedImageNotice,
  decodeBase64Prefix,
  isModelAcceptedImageMime,
  normalizeImageMime,
  parseImageDataUrl,
  MODEL_ACCEPTED_IMAGE_MIMES,
} from "@moonshot-ai/agent-core-v2/agent/media/image-format-policy";
import {
  originalImageCacheDir,
  persistOriginalImage,
  sessionMediaOriginalsDir,
} from "@moonshot-ai/agent-core-v2/agent/media/image-originals";
import { access, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

export {
  buildCompactionElisionText,
  buildImageCompressionCaption,
  buildUnsupportedImageNotice,
  collectCompactableUserMessages,
  compressBase64ForModel,
  compressImageContentParts,
  compressImageForModel,
  cropImageForModel,
  decodeBase64Prefix,
  formatByteSize,
  gateImageFormatParts,
  isModelAcceptedImageMime,
  isRealUserInput,
  normalizeImageMime,
  originalImageCacheDir,
  parseImageDataUrl,
  persistOriginalImage,
  selectCompactionUserMessages,
  selectRecentUserMessages,
  sessionMediaOriginalsDir,
  renderToolResultForModel,
  IMAGE_BYTE_BUDGET,
  MAX_IMAGE_EDGE_PX,
  MODEL_ACCEPTED_IMAGE_MIMES,
};

// ── Errors (v2's Error2 is the SDK's coded-error primitive) ──
import {
  Error2,
  ErrorCodes as V2ErrorCodes,
  errorInfo,
  isError2,
} from "@moonshot-ai/agent-core-v2";
export const ErrorCodes = {
  ...V2ErrorCodes,
  SESSION_ID_REQUIRED: "session.id_required",
  SESSION_ID_EMPTY: "session.id_empty",
  SESSION_ALREADY_EXISTS: "session.already_exists",
  SESSION_NOT_FOUND: "session.not_found",
  SESSION_TITLE_EMPTY: "session.title_empty",
  SESSION_MODEL_EMPTY: "session.model_empty",
  SESSION_THINKING_EMPTY: "session.thinking_empty",
  SESSION_PERMISSION_MODE_INVALID: "session.permission_mode_invalid",
  SESSION_PLAN_MODE_INVALID: "session.plan_mode_invalid",
  SESSION_STATE_INVALID: "session.state_invalid",
  SESSION_CLOSED: "session.closed",
  SESSION_APPROVAL_HANDLER_ERROR: "session.approval_handler_error",
  SESSION_QUESTION_HANDLER_ERROR: "session.question_handler_error",
  REQUEST_WORK_DIR_REQUIRED: "request.work_dir_required",
  REQUEST_PROMPT_INPUT_EMPTY: "request.prompt_input_empty",
  PROVIDER_CONNECTION_ERROR: "provider.connection_error",
  GOAL_METADATA_RESERVED: "goal.metadata_reserved",
  GOAL_ALREADY_EXISTS: "goal.already_exists",
  GOAL_NOT_FOUND: "goal.not_found",
  GOAL_OBJECTIVE_EMPTY: "goal.objective_empty",
  GOAL_OBJECTIVE_TOO_LONG: "goal.objective_too_long",
  BACKGROUND_TASK_ID_EMPTY: "background.task_id_empty",
  SKILL_NAME_EMPTY: "skill.name_empty",
} as const;
export type {
  Error2Options as KimiErrorOptions,
  ErrorInfo as KimiErrorInfo,
  ErrorPayload as KimiErrorPayload,
} from "@moonshot-ai/agent-core-v2";
export type KimiErrorCode = string;

/** SDK-compatible name while preserving v2's coded-error payload. */
export class KimiError extends Error2 {
  constructor(
    code: string,
    message: string,
    options?: ConstructorParameters<typeof Error2>[2],
  ) {
    super(code as ConstructorParameters<typeof Error2>[0], message, {
      ...options,
      name: "KimiError",
    });
  }
}

// ── SDK metadata projection ──
// agent-core-v2 stores epoch-ms/cwd metadata. The v2 session mapper projects
// that document into this SDK-facing shape (ISO timestamps/workDir), so these
// are intentionally not aliases for the v2 document type.
export interface AgentMeta {
  readonly homedir?: string;
  readonly type?: "main" | "sub" | "independent";
  readonly parentAgentId?: string | null;
  readonly swarmItem?: string;
}

export interface SessionMeta {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly title: string;
  readonly isCustomTitle: boolean;
  readonly lastPrompt?: string;
  readonly forkedFrom?: string;
  readonly workDir?: string;
  readonly agents: Readonly<Record<string, AgentMeta>>;
  readonly custom: Record<string, unknown>;
}

// ── Event type ──
export type { DomainEvent as Event } from "@moonshot-ai/agent-core-v2";

// ── Approval/Question types ──
export type {
  ApprovalRequest,
  ApprovalResponse,
} from "@moonshot-ai/agent-core-v2/session/approval/approval";
export type {
  QuestionRequest,
  QuestionResult,
} from "@moonshot-ai/agent-core-v2/session/question/question";

// ── Types from v2 deep paths ──
export type { ToolInputDisplay } from "@moonshot-ai/agent-core-v2/tool/toolInputDisplay";
export type { AgentContextData, ContextMessage } from "@moonshot-ai/agent-core-v2/agent/contextMemory/types";
export type { LoopRecordedEvent } from "@moonshot-ai/agent-core-v2/agent/contextMemory/loopEventFold";
export type { CompactionBeginData, CompactionResult } from "@moonshot-ai/agent-core-v2/agent/fullCompaction/types";
export type { PermissionApprovalResultRecord } from "@moonshot-ai/agent-core-v2/agent/permissionRules/permissionRules";
export type { UsageRecordScope } from "@moonshot-ai/agent-core-v2/agent/usage/usageOps";
export type { PermissionMode } from "@moonshot-ai/agent-core-v2/agent/permissionPolicy/types";
export type {
  AgentConfigUpdateData,
  ToolStoreUpdate,
} from "@moonshot-ai/agent-core-v2/wire/recordTypes";
export type {
  AgentMeta as V2AgentMeta,
  SessionMeta as V2SessionMeta,
} from "@moonshot-ai/agent-core-v2/session/sessionMetadata/sessionMetadata";
export type {
  ExportSessionManifest,
  ShellEnvironment,
} from "@moonshot-ai/agent-core-v2/app/sessionExport/sessionExport";
export type {
  AgentReplayRecord,
  ResumedAgentState,
} from "@moonshot-ai/agent-core-v2/agent/replayBuilder/types";
/** SDK-facing resume envelope after the v2 metadata projection. */
export interface ResumeSessionResult {
  readonly sessionMetadata: SessionMeta;
  readonly agents: Readonly<Record<string, V2ResumedAgentState>>;
  readonly warning?: string;
}

// ── MCP types ──
export {
  McpServerConfigSchema,
} from "@moonshot-ai/agent-core-v2/mcpCore/config-schema";
export type {
  McpServerConfig,
  McpRemoteServerConfig,
} from "@moonshot-ai/agent-core-v2/mcpCore/config-schema";
/** v2 has no user-global `name`/OAuth-marker wrapper for its MCP config. */
export type GlobalMcpServerConfig = {
  readonly name: string;
  readonly auth?: "oauth";
} & import("@moonshot-ai/agent-core-v2/mcpCore/config-schema").McpServerConfig;
/** SDK RPC result that wraps v2's `BeginAuthorizationResult` in a flow id. */
export type BeginGlobalMcpServerAuthResult =
  | {
      readonly status: "authorization-required";
      readonly flowId: string;
      readonly authorizationUrl: string;
    }
  | { readonly status: "already-authorized" };

// ── Harness interceptors (in-process only) ──
export { IHarnessInterceptorRegistry } from "@moonshot-ai/agent-core-v2/app/harnessInterceptor/harnessInterceptorRegistry";
export type {
  HarnessInterceptorDefinition,
  HarnessInterceptorHooks,
} from "@moonshot-ai/agent-core-v2/app/harnessInterceptor/types";

// ── Config helpers ──
export {
  resolveConfigPath,
  resolveKimiHome,
} from "@moonshot-ai/agent-core-v2";
export {
  encodeWorkDirKey,
} from "@moonshot-ai/agent-core-v2/_base/utils/workdir-slug";

// ── Logging ──
export { resolveGlobalLogPath } from "@moonshot-ai/agent-core-v2/_base/log/logConfig";
export type Logger = V2Logger;
export type {
  LogLevel,
  LogContext,
  LogPayload,
} from "@moonshot-ai/agent-core-v2/_base/log/log";

// ── Provider types ──
// No v2 service owns this SDK provider adapter contract; it remains a local
// type-only boundary around v2's Kosong provider request/config types.
export interface ResolvedRuntimeProvider {
  readonly providerName: string;
  readonly provider: KosongProviderConfig;
  readonly modelCapabilities: unknown;
  readonly type: string;
  readonly protocol?: unknown;
}

export interface ModelProvider {
  readonly defaultModel: string;
  resolveProviderConfig(model: string): ResolvedRuntimeProvider;
  resolveAuth(
    model: string,
    options?: { readonly log?: Logger },
  ): <T>(request: (auth: ProviderRequestAuth) => Promise<T>) => Promise<T>;
}

// ── Record types ──
export type {
  AgentRecord,
  AgentRecordEvents,
  AgentRecordOf,
  BackgroundTaskInfo,
  BackgroundTaskStatus,
  AgentBackgroundTaskInfo,
  ProcessBackgroundTaskInfo,
  QuestionBackgroundTaskInfo,
} from "@moonshot-ai/agent-core-v2/wire/recordTypes";

// ── Config schema stubs (not in v2) ──
import { z } from "zod";
export const KimiConfigSchema = z.object({}).passthrough();
export const ModelAliasSchema = z.object({}).passthrough();
export const ProviderConfigSchema = z.object({}).passthrough();
export const HookDefSchema = z.object({}).passthrough();

// ── Config types ──
/** Model configuration consumed by the v2 catalog and terminal model picker. */
export type ModelAlias = ModelRecord;
export interface KimiConfig {
  readonly providers?: Record<string, KosongProviderConfig>;
  readonly models?: Record<string, ModelAlias>;
  readonly defaultModel?: string;
  readonly defaultPermissionMode?: string;
  readonly defaultPlanMode?: boolean;
  readonly thinking?: { readonly enabled?: boolean; readonly effort?: string };
  readonly secondaryModel?: {
    readonly model?: string;
    readonly defaultEffort?: string;
  };
  readonly [key: string]: unknown;
}
export type OAuthRef = { provider: string; token: string };

/** Minimal file-backed config helpers used by the public SDK facade. */
export async function ensureConfigFile(configPath: string): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  try {
    await access(configPath);
  } catch {
    try {
      await writeFile(configPath, "", { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

function readTomlConfig(configPath: string): KimiConfig {
  try {
    return parseToml(readFileSync(configPath, "utf8")) as KimiConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export function readConfigFile(configPath: string): KimiConfig {
  return readTomlConfig(configPath);
}

export function readConfigFileForUpdate(configPath: string): KimiConfig {
  return readTomlConfig(configPath);
}

export async function writeConfigFile(
  configPath: string,
  config: KimiConfig,
): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${stringifyToml(config)}\n`, "utf8");
}

export function loadRuntimeConfigSafe(configPath: string): {
  readonly config: KimiConfig;
} {
  try {
    return { config: readTomlConfig(configPath) };
  } catch {
    return { config: {} };
  }
}

export const KIMI_ERROR_INFO: Record<string, ReturnType<typeof errorInfo>> =
  new Proxy({}, { get: (_target, code: string) => errorInfo(code) });
export function fromKimiErrorPayload(p: { message: string; code?: string }): Error {
  return p.code === undefined
    ? new Error(p.message)
    : new KimiError(p.code, p.message);
}
export function isKimiError(e: unknown): e is KimiError { return isError2(e); }
export function toKimiErrorPayload(e: Error): { code: string; message: string } {
  return { code: e instanceof Error2 ? e.code : "UNKNOWN", message: e.message };
}
/** Apply model overrides and provider-derived defaults before presentation. */
export function effectiveModelAlias(
  model: ModelAlias,
  providerType?: string,
): ModelAlias {
  return effectiveModelConfig(model, providerType);
}

// ── Stub implementations ──
export function transformTomlData<T>(data: T): T { return data; }
export function parseConfigString(_s: string): Record<string, unknown> { return {}; }
export function createRPC(): Record<string, unknown> { return {}; }
/** Keep the tail beginning at the latest `maxTurns` real user prompts. */
export function limitAgentReplayByTurns(
  replay: readonly AgentReplayRecord[],
  maxTurns: number | undefined,
): readonly AgentReplayRecord[] {
  if (maxTurns === undefined || maxTurns < 1) return replay;
  const userStarts: number[] = [];
  replay.forEach((record, index) => {
    if (record.type !== "message" || record.message.role !== "user") return;
    const origin = record.message.origin?.kind;
    // Compaction summaries are synthetic context, not a turn. Other user
    // messages (including goal/system continuations) still delimit turns even
    // when they are intentionally hidden from the transcript UI.
    if (origin === "compaction_summary") return;
    userStarts.push(index);
  });
  if (userStarts.length <= maxTurns) return replay;
  return replay.slice(userStarts[userStarts.length - maxTurns]!);
}
export function makeErrorPayload(code: unknown, msg: string, extra?: Record<string, unknown>) { return { code, message: msg, ...extra }; }
export function installGlobalProxyDispatcher(): void {}
export {
  parseAgentFileText,
  resolveAgentPath,
} from "@moonshot-ai/agent-core-v2";
export const noopTelemetryClient = { track: () => {}, sendEvent: () => {}, flush: () => Promise.resolve(), close: () => Promise.resolve() } as const;

/** Host-facing diagnostic logger; engine scopes own their file sinks. */
export const log: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  child: () => log,
};
export function flushDiagnosticLogs(): Promise<void> { return Promise.resolve(); }
export function flushDiagnosticLogsSync(): void {}
export function redact<T>(value: T): T { return value; }

// ── Constants ──
export const COMPACTION_ELISION_VARIANT = "standard" as const;
export const COMPACT_USER_MESSAGE_MAX_TOKENS = 4000;
export const USER_PROMPT_ORIGIN = "user" as const;
export const MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE = "mcp_oauth_authorization_url_tool_update";
export function resolveLoggingConfig(input?: {
  readonly homeDir: string;
  readonly env: NodeJS.ProcessEnv;
}): ReturnType<typeof resolveV2LoggingConfig> {
  return resolveV2LoggingConfig(
    input ?? { homeDir: resolveV2KimiHome(), env: process.env },
  );
}
export const SECONDARY_DERIVED_MODEL_ALIAS = "__secondary__" as const;
export const AGENT_WIRE_PROTOCOL_VERSION = "1.5" as const;

// ── Type stubs (not in v2 or different shape) ──
export class ImageLimits {
  private readonly edge: number;
  private readonly budget: number;
  constructor(
    _env: NodeJS.ProcessEnv = process.env,
    options: { readonly maxEdgePx?: number; readonly byteBudget?: number } = {},
  ) {
    this.edge = options.maxEdgePx ?? resolveMaxImageEdgePx();
    this.budget = options.byteBudget ?? IMAGE_BYTE_BUDGET;
  }
  maxEdgePx(): number { return this.edge; }
  byteBudget(): number { return this.budget; }
}
export class Emitter<T> {
  private ls = new Set<(e: T) => void>();
  fire(e: T): void { for (const l of this.ls) l(e); }
  event(cb: (e: T) => void): { dispose(): void } { this.ls.add(cb); return { dispose: () => this.ls.delete(cb) }; }
}
export type ExperimentalFeatureState = { enabled: boolean };
export type SwarmModeTrigger = "manual" | "task" | "tool";
export type GetCronTasksResult = { tasks: readonly unknown[] };
export type CoreAPI = Record<string, unknown>;
export type SDKAPI = Record<string, unknown>;
export type RPCMethods = Record<string, unknown>;
export type ToolCallRequest = unknown;
export type ToolCallResponse = unknown;
export type TelemetryClient = typeof noopTelemetryClient;
export type TelemetryProperties = Record<string, unknown>;
export type TelemetryContextPatch = Record<string, unknown>;
export function withTelemetryContext(tc: unknown, _ctx?: unknown) { return (tc as TelemetryClient) ?? noopTelemetryClient; }

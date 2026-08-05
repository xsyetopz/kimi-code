// Compat module — replaces @moonshot-ai/kimi-code-sdk imports.
// Re-exports from v2 where possible, local stubs otherwise.

// ── Errors (v2 already exports these) ──
export { ErrorCodes, KimiError } from "@moonshot-ai/kimi-code-sdk-v2";
export type { KimiErrorCode } from "@moonshot-ai/kimi-code-sdk-v2";

// ── Metadata types ──
export type { AgentMeta, SessionMeta } from "@moonshot-ai/kimi-code-sdk-v2";

// ── Event type ──
export type { DomainEvent as Event } from "@moonshot-ai/kimi-code-sdk-v2";

// ── Approval/Question types ──
export type {
  ApprovalRequest,
  ApprovalResponse,
  QuestionRequest,
  QuestionResult,
} from "@moonshot-ai/kimi-code-sdk-v2";

// ── Types from v2 deep paths ──
export type { ToolInputDisplay } from "@moonshot-ai/kimi-code-sdk-v2/tool/toolInputDisplay";
export type { AgentContextData, ContextMessage } from "@moonshot-ai/kimi-code-sdk-v2/agent/contextMemory/types";
export type { AgentMeta, SessionMeta } from "@moonshot-ai/kimi-code-sdk-v2/session/sessionMetadata/sessionMetadata";
export type { ShellEnvironment } from "@moonshot-ai/kimi-code-sdk-v2/session/session/sessionTypes";
export type { ExportSessionManifest, ResumeSessionResult } from "@moonshot-ai/kimi-code-sdk-v2/session/sessionSummary/sessionSummary";

// ── MCP types ──
export {
  McpServerConfigSchema,
} from "@moonshot-ai/kimi-code-sdk-v2/mcpCore/config-schema";
export type {
  McpServerConfig,
  McpRemoteServerConfig,
  GlobalMcpServerConfig,
} from "@moonshot-ai/kimi-code-sdk-v2/mcpCore/config-schema";
export { BeginGlobalMcpServerAuthResult } from "@moonshot-ai/kimi-code-sdk-v2/mcpCore/oauth/service";

// ── Config helpers ──
export {
  loadRuntimeConfigSafe,
  resolveConfigPath,
  resolveKimiHome,
  ensureConfigFile,
  readConfigFile,
  readConfigFileForUpdate,
  writeConfigFile,
} from "@moonshot-ai/kimi-code-sdk-v2";
export {
  encodeWorkDirKey,
} from "@moonshot-ai/kimi-code-sdk-v2/_base/utils/workdir-slug";

// ── Logging ──
export { log, flushDiagnosticLogs, flushDiagnosticLogsSync, redact, resolveGlobalLogPath } from "@moonshot-ai/kimi-code-sdk-v2";
export type { Logger, LogLevel, LogContext, LogPayload } from "@moonshot-ai/kimi-code-sdk-v2";

// ── Provider types ──
export type {
  ModelProvider,
  ResolvedRuntimeProvider,
} from "@moonshot-ai/kimi-code-sdk-v2";

// ── Record types ──
export type {
  AgentRecord,
} from "@moonshot-ai/kimi-code-sdk-v2/wire/record";
export type { BackgroundTaskInfo } from "@moonshot-ai/kimi-code-sdk-v2/agent/task/types";

// ── Config schema stubs (not in v2) ──
import { z } from "zod";
export const KimiConfigSchema = z.object({}).passthrough();
export const ModelAliasSchema = z.string();
export const ProviderConfigSchema = z.object({}).passthrough();
export const HookDefSchema = z.object({}).passthrough();

// ── Config types ──
export type KimiConfig = Record<string, unknown>;
export type ModelAlias = string;
export type OAuthRef = { provider: string; token: string };

export const KIMI_ERROR_INFO = Symbol("KimiErrorInfo");
export function fromKimiErrorPayload(p: { message: string }): Error { return new Error(p.message); }
export function isKimiError(_e: unknown): boolean { return false; }
export function toKimiErrorPayload(e: Error): { code: string; message: string } { return { code: "UNKNOWN", message: e.message }; }
export function effectiveModelAlias(): string { return ""; }

// ── Stub implementations ──
export function transformTomlData<T>(data: T): T { return data; }
export function parseConfigString(_s: string): Record<string, unknown> { return {}; }
export function createRPC(): Record<string, unknown> { return {}; }
export function limitAgentReplayByTurns<T>(replay: readonly T[], _max: number): readonly T[] { return replay; }
export function makeErrorPayload(code: unknown, msg: string, extra?: Record<string, unknown>) { return { code, message: msg, ...extra }; }
export function installGlobalProxyDispatcher(): void {}
export function parseAgentFileText(text: string): string[] { return text.split("\n"); }
export function resolveAgentPath(_base: string, relative: string): string { return relative; }
export function renderToolResultForModel(r: unknown): string { return typeof r === "string" ? r : JSON.stringify(r); }
export function buildCompactionElisionText(): string { return ""; }
export function collectCompactableUserMessages<T>(): readonly T[] { return []; }
export function isRealUserInput(): boolean { return true; }
export function selectCompactionUserMessages<T>(msgs: readonly T[]): readonly T[] { return []; }
export function selectRecentUserMessages<T>(msgs: readonly T[], n: number): readonly T[] { return msgs.slice(-n); }
export function buildImageCompressionCaption(): string { return ""; }
export function compressImageForModel<T>(img: T): T { return img; }
export function compressBase64ForModel<T>(img: T): T { return img; }
export function compressImageContentParts<T>(parts: T): T { return parts; }
export function cropImageForModel<T>(img: T): T { return img; }
export function formatByteSize(): string { return "0 B"; }
export function gateImageFormatParts<T>(parts: T): T { return parts; }
export function decodeBase64Prefix(): string { return ""; }
export function isModelAcceptedImageMime(): boolean { return true; }
export function normalizeImageMime(m: string): string { return m; }
export function parseImageDataUrl(): { mime: string; data: string } { return { mime: "", data: "" }; }
export function persistOriginalImage(): Promise<string> { return Promise.resolve(""); }
export function sessionMediaOriginalsDir(): string { return ""; }
export function originalImageCacheDir(): string { return ""; }
export const noopTelemetryClient = { track: () => {}, sendEvent: () => {}, flush: () => Promise.resolve(), close: () => Promise.resolve() } as const;

// ── Constants ──
export const COMPACTION_ELISION_VARIANT = "standard" as const;
export const COMPACT_USER_MESSAGE_MAX_TOKENS = 4000;
export const IMAGE_BYTE_BUDGET = 5_000_000;
export const MAX_IMAGE_EDGE_PX = 4096;
export const MODEL_ACCEPTED_IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;
export const USER_PROMPT_ORIGIN = "user" as const;
export const MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE = "mcp_oauth_authorization_url_tool_update";
export function buildUnsupportedImageNotice(): string { return ""; }
export function resolveLoggingConfig(): Record<string, unknown> { return {}; }
export const SECONDARY_DERIVED_MODEL_ALIAS = "" as const;
export const AGENT_WIRE_PROTOCOL_VERSION = "1.5" as const;

// ── Type stubs (not in v2 or different shape) ──
export class ImageLimits { maxEdgePx = 4096; byteBudget = 5_000_000; }
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

// @moonshot-ai/agent-core — type compatibility shim.
// All engine code was deleted in the v1→v2 cutover. This package now provides
// only stub re-exports so the ~29 monorepo consumers that still import from it
// continue to compile while they migrate to @moonshot-ai/agent-core-v2.

export { ErrorCodes, KimiError } from "./errors";
export type { KimiErrorCode } from "./errors";

// ── Stubs ──

export const log = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as const;
export function flushDiagnosticLogs(): void {}
export function flushDiagnosticLogsSync(): void {}
export function redact(s: string): string { return s; }
export function resolveGlobalLogPath(): string { return ""; }
export function resolveKimiHome(): string {
  return `${process.env.HOME ?? "/tmp"}/.kimi`;
}
export function resolveConfigPath(): string { return ""; }
export function resolveLoggingConfig(): Record<string, unknown> { return {}; }
export function loadRuntimeConfigSafe(): Record<string, unknown> { return {}; }
export function ensureConfigFile(): Promise<void> { return Promise.resolve(); }
export function readConfigFile(): Promise<string> { return Promise.resolve(""); }
export function readConfigFileForUpdate(): Promise<string> { return Promise.resolve(""); }
export function writeConfigFile(_content: string): Promise<void> { return Promise.resolve(); }
export function effectiveModelAlias(): string { return ""; }
export function parseAgentFileText(text: string): string[] { return text.split("\n"); }
export function resolveAgentPath(_base: string, relative: string): string { return relative; }
export function renderToolResultForModel(r: unknown): string { return typeof r === "string" ? r : JSON.stringify(r); }
export function limitAgentReplayByTurns<T>(replay: readonly T[], _max: number): readonly T[] { return replay; }
export function encodeWorkDirKey(workDir: string): string { return workDir; }
export function installGlobalProxyDispatcher(): void {}
export function buildImageCompressionCaption(): string { return ""; }
export function buildImageConversionGuidance(): string { return ""; }
export function buildUnsupportedImageNotice(): string { return ""; }
export function compressImageForModel<T>(img: T): T { return img; }
export function compressBase64ForModel<T>(img: T): T { return img; }
export function compressImageContentParts<T>(parts: T): T { return parts; }
export function cropImageForModel<T>(img: T): T { return img; }
export function formatByteSize(): string { return "0 B"; }
export function gateImageFormatParts<T>(parts: T): T { return parts; }
export function resolveMaxImageEdgePx(): number { return 4096; }
export function resolveReadImageByteBudget(): number { return 5_000_000; }
export function decodeBase64Prefix(): string { return ""; }
export function isModelAcceptedImageMime(): boolean { return true; }
export function normalizeImageMime(m: string): string { return m; }
export function parseImageDataUrl(): { mime: string; data: string } { return { mime: "", data: "" }; }
export function resolveEffectiveImageMime(m: string): string { return m; }
export function unsupportedImageMimeFromUrl(): string { return ""; }
export function originalImageCacheDir(): string { return ""; }
export function persistOriginalImage(): Promise<string> { return Promise.resolve(""); }
export function sessionMediaOriginalsDir(): string { return ""; }
export function selectCompactionUserMessages<T>(msgs: readonly T[]): readonly T[] { return []; }
export function selectRecentUserMessages<T>(msgs: readonly T[], n: number): readonly T[] { return msgs.slice(-n); }
export function collectCompactableUserMessages<T>(): readonly T[] { return []; }
export function buildCompactionElisionText(): string { return ""; }
export function isRealUserInput(): boolean { return true; }
export function transformTomlData<T>(data: T): T { return data; }
export function parseConfigString(): Record<string, unknown> { return {}; }
export function makeErrorPayload(code: unknown, msg: string, extra?: Record<string, unknown>) { return { code, message: msg, ...extra }; }
export function createRPC(): Record<string, unknown> { return {}; }
export const noopTelemetryClient = { track: () => {}, sendEvent: () => {}, flush: () => Promise.resolve(), close: () => Promise.resolve() } as const;
export function withTelemetryContext(tc: unknown, _ctx?: unknown) { return (tc as typeof noopTelemetryClient) ?? noopTelemetryClient; }
export type TelemetryClient = typeof noopTelemetryClient;

// ── Constants ──
export const IMAGE_BYTE_BUDGET = 5_000_000;
export const MAX_IMAGE_EDGE_PX = 4096;
export const READ_IMAGE_BYTE_BUDGET = 5_000_000;
export const COMPACT_USER_MESSAGE_MAX_TOKENS = 4000;
export const COMPACTION_ELISION_VARIANT = "standard" as const;
export const MODEL_ACCEPTED_IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;
export const USER_PROMPT_ORIGIN = "user" as const;
export const SECONDARY_DERIVED_MODEL_ALIAS = "" as const;
export const AGENT_WIRE_PROTOCOL_VERSION = "1.5" as const;

// ── Schema stubs ──
import { z } from "zod";
export const KimiConfigSchema = z.object({}).passthrough();
export const ModelAliasSchema = z.string();
export const ProviderConfigSchema = z.object({}).passthrough();
export const HookDefSchema = z.object({}).passthrough();
export const McpServerConfigSchema = z.object({}).passthrough();

// ── Type stubs ──
export type LogLevel = "info" | "warn" | "error" | "debug";
export type LogContext = Record<string, unknown>;
export type LogPayload = Record<string, unknown>;
export type Logger = typeof log;
export type LoggingConfig = Record<string, unknown>;
export type RootLogger = Logger;
export type SessionAttachInput = unknown;
export type SessionLogHandle = unknown;
export type LogEntry = unknown;
export type ResolveLoggingInput = unknown;
export class ImageLimits {
  maxEdgePx = 4096;
  byteBudget = 5_000_000;
}
export const MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE = "mcp_oauth_authorization_url_tool_update";
export type ImageCompressionCaptionInput = unknown;
export type ImageCompressionTelemetry = unknown;
export type CompressImageOptions = Record<string, unknown>;
export type CompressImageResult = { compressed: boolean };
export type CompressBase64Result = { compressed: boolean };
export type CropImageOptions = Record<string, unknown>;
export type CropImageOutcome = unknown;
export type ImageCropRegion = unknown;
export type ImageVariantDescription = unknown;
export type CompressAnnotateOptions = unknown;
export type CompressedContentParts = unknown;
export type PersistOriginalImageOptions = unknown;
export type RenderableToolResult = unknown;
export type KimiConfig = Record<string, unknown>;
export type ModelAlias = string;
export type Event = { type: string };
export type AgentMeta = Record<string, unknown>;
export type SessionMeta = Record<string, unknown>;
export type AgentRecord = { type: string };
export type AgentRecordOf<T extends string> = { type: T };
export type AgentRecordEvents = unknown;
export type AgentRecordPersistence = unknown;
export type BackgroundTaskInfo = unknown;
export type AgentBackgroundTaskInfo = unknown;
export type BackgroundTaskStatus = "running" | "completed" | "failed" | "cancelled";
export type ProcessBackgroundTaskInfo = unknown;
export type QuestionBackgroundTaskInfo = unknown;
export type ContextMessage = { role: string; content?: string };
export type AgentContextData = unknown;
export type PromptOrigin = unknown;
export type UserPromptOrigin = unknown;
export type AgentConfigUpdateData = unknown;
export type CompactionBeginData = unknown;
export type CompactionResult = unknown;
export type KimiErrorInfo = unknown;
export type KimiErrorOptions = unknown;
export type KimiErrorPayload = { code: unknown; message: string };
export const KIMI_ERROR_INFO = Symbol("KimiErrorInfo");
export function fromKimiErrorPayload(p: KimiErrorPayload): Error { return new Error(p.message); }
export function toKimiErrorPayload(e: Error): KimiErrorPayload { return { code: "UNKNOWN", message: e.message }; }
export function isKimiError(_e: unknown): boolean { return false; }
export type PermissionApprovalResultRecord = unknown;
export type PermissionMode = "manual" | "yolo" | "auto";
export type UsageRecordScope = unknown;
export type ToolStoreUpdate = { key: string; value: unknown };
export type ToolServices = unknown;
export type CronTaskSnapshot = unknown;
export type ShellEnvironment = Record<string, unknown>;
export type ExportSessionManifest = unknown;
export type ResumeSessionResult = unknown;
export type ApprovalRequest = unknown;
export type ApprovalResponse = unknown;
export type QuestionRequest = unknown;
export type QuestionResult = unknown;
export type ToolInputDisplay = unknown;
export type ToolCallRequest = unknown;
export type ToolCallResponse = unknown;
export type McpServerConfig = unknown;
export type McpRemoteServerConfig = unknown;
export type GlobalMcpServerConfig = unknown;
export type BeginGlobalMcpServerAuthResult = { url: string };
export type GetCronTasksResult = { tasks: readonly unknown[] };
export type ModelProvider = unknown;
export type BearerTokenProvider = unknown;
export type OAuthTokenProviderResolver = unknown;
export type ResolvedRuntimeProvider = unknown;
export type SingleModelProvider = unknown;
export type TelemetryProperties = Record<string, unknown>;
export type TelemetryContextPatch = Record<string, unknown>;
export type OAuthRef = { provider: string; token: string };
export type ExperimentalFeatureState = { enabled: boolean };
export type ExperimentalFlagMap = Record<string, ExperimentalFeatureState>;
export type ExperimentalFlagSource = "env" | "default";
export type FlagDefinition = { id: string; default: boolean };
export type FlagDefinitionInput = unknown;
export type FlagId = string;
export type FlagSurface = unknown;
export type CoreAPI = Record<string, unknown>;
export type SDKAPI = Record<string, unknown>;
export type RPCMethods = Record<string, unknown>;
export type SwarmModeTrigger = "manual" | "task" | "tool";
export type ProviderConfigSchema = unknown;
export class Emitter<T> {
  private listeners = new Set<(e: T) => void>();
  fire(e: T): void { for (const l of this.listeners) l(e); }
  event(cb: (e: T) => void): { dispose(): void } {
    this.listeners.add(cb);
    return { dispose: () => this.listeners.delete(cb) };
  }
  dispose(): void { this.listeners.clear(); }
  get isDisposed(): boolean { return false; }
}
export type ISessionIndexMirror = unknown;
export function drainSessionIndexMirror(): Promise<void> { return Promise.resolve(); }
export function drainQueryStoreDisposals(): Promise<void> { return Promise.resolve(); }
export function drainGlobalSearchDisposals(): Promise<void> { return Promise.resolve(); }

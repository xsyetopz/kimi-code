/**
 * Host-facing diagnostic logger for the SDK surface (`log`, `flushDiagnosticLogs`).
 *
 * Routes entries to the global rotating log under `<home>/logs/kimi-code.log`,
 * or to `<sessionDir>/logs/kimi-code.log` when the payload carries `sessionId`
 * and the id resolves through `session_index.jsonl`. Uses the same file sinks
 * and redaction rules as agent-core scope log services.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveKimiHome } from "@moonshot-ai/agent-core-v2/app/bootstrap/bootstrap";
import {
  createFileLogWriter,
  type FileLogWriter,
} from "@moonshot-ai/agent-core-v2/_base/log/fileLog";
import { redactCtx } from "@moonshot-ai/agent-core-v2/_base/log/formatter";
import type {
  ILogger,
  ILogWriter,
  LogContext,
  LogEntry,
} from "@moonshot-ai/agent-core-v2/_base/log/log";
import {
  resolveGlobalLogPath,
  resolveLoggingConfig,
  resolveSessionLogPath,
} from "@moonshot-ai/agent-core-v2/_base/log/logConfig";
import {
  BoundLogger,
  type LogLevelState,
} from "@moonshot-ai/agent-core-v2/_base/log/logService";

const SESSION_INDEX_FILE = "session_index.jsonl";

class RoutingLogWriter implements ILogWriter {
  constructor(private readonly state: DiagnosticLogState) {}

  write(entry: LogEntry): void {
    const sessionId =
      typeof entry.ctx?.sessionId === "string" ? entry.ctx.sessionId : undefined;
    if (sessionId === undefined) {
      this.state.globalWriter().write(entry);
      return;
    }
    const sessionDir = this.state.resolveSessionDir(sessionId);
    if (sessionDir === undefined) {
      this.state.globalWriter().write(entry);
      return;
    }
    this.state.sessionWriter(sessionDir).write(entry);
  }

  flush(): Promise<void> {
    return this.state.flush();
  }

  flushSync(): void {
    this.state.flushSync();
  }
}

class DiagnosticLogState {
  private homeDir: string | undefined;
  private globalSink: FileLogWriter | undefined;
  private readonly sessionSinks = new Map<string, FileLogWriter>();
  private readonly sessionDirById = new Map<string, string>();
  private levelState: LogLevelState | undefined;
  private rootLogger: BoundLogger | undefined;
  private readonly routingWriter = new RoutingLogWriter(this);

  logger(): ILogger {
    if (this.rootLogger === undefined) {
      this.levelState = { level: this.loggingConfig().level };
      this.rootLogger = new BoundLogger(this.routingWriter, this.levelState);
    }
    return this.rootLogger;
  }

  globalWriter(): FileLogWriter {
    if (this.globalSink === undefined) {
      const homeDir = this.resolveHomeDir();
      const config = this.loggingConfig();
      this.globalSink = createFileLogWriter({
        path: resolveGlobalLogPath(homeDir),
        maxBytes: config.globalMaxBytes,
        files: config.globalFiles,
      });
    }
    return this.globalSink;
  }

  sessionWriter(sessionDir: string): FileLogWriter {
    const existing = this.sessionSinks.get(sessionDir);
    if (existing !== undefined) return existing;
    const config = this.loggingConfig();
    const sink = createFileLogWriter({
      path: resolveSessionLogPath(sessionDir),
      maxBytes: config.sessionMaxBytes,
      files: config.sessionFiles,
      format: { omitContextKeys: ["sessionId"] },
    });
    this.sessionSinks.set(sessionDir, sink);
    return sink;
  }

  resolveSessionDir(sessionId: string): string | undefined {
    const cached = this.sessionDirById.get(sessionId);
    if (cached !== undefined) return cached;
    const homeDir = this.resolveHomeDir();
    let raw: string;
    try {
      raw = readFileSync(join(homeDir, SESSION_INDEX_FILE), "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let sessionDir: string | undefined;
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        (parsed as { sessionId?: unknown }).sessionId !== sessionId
      ) {
        continue;
      }
      const dir = (parsed as { sessionDir?: unknown }).sessionDir;
      if (typeof dir !== "string" || dir.length === 0) continue;
      sessionDir = dir;
    }
    if (sessionDir !== undefined) this.sessionDirById.set(sessionId, sessionDir);
    return sessionDir;
  }

  async flush(): Promise<void> {
    await this.globalWriter().flush();
    await Promise.all(
      [...this.sessionSinks.values()].map((sink) => sink.flush()),
    );
  }

  flushSync(): void {
    this.globalWriter().flushSync?.();
    for (const sink of this.sessionSinks.values()) sink.flushSync?.();
  }

  resetForTests(): void {
    this.homeDir = undefined;
    this.globalSink = undefined;
    this.sessionSinks.clear();
    this.sessionDirById.clear();
    this.levelState = undefined;
    this.rootLogger = undefined;
  }

  private resolveHomeDir(): string {
    this.homeDir ??= resolveKimiHome();
    return this.homeDir;
  }

  private loggingConfig() {
    return resolveLoggingConfig({
      homeDir: this.resolveHomeDir(),
      env: process.env,
    });
  }
}

const diagnosticLogState = new DiagnosticLogState();

function logger(): ILogger {
  return diagnosticLogState.logger();
}

export const log: ILogger = {
  error(message, payload) {
    logger().error(message, payload);
  },
  warn(message, payload) {
    logger().warn(message, payload);
  },
  info(message, payload) {
    logger().info(message, payload);
  },
  debug(message, payload) {
    logger().debug(message, payload);
  },
  child(ctx) {
    return logger().child(ctx);
  },
};

/** Test-only: drop cached writers so `KIMI_CODE_HOME` overrides take effect. */
export function resetDiagnosticLogForTests(): void {
  diagnosticLogState.resetForTests();
}

export function flushDiagnosticLogs(): Promise<void> {
  return diagnosticLogState.flush();
}

export function flushDiagnosticLogsSync(): void {
  diagnosticLogState.flushSync();
}

export function redact<T>(value: T): T {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  return redactCtx(value as LogContext) as T;
}

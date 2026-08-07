/**
 * Foreground kap-server entry for dev/e2e harnesses (replaces the removed `kimi web` CLI).
 */
import { parseArgs } from "node:util";

import {
  createServerLogger,
  startServer,
  type ServerLogLevel,
} from "../src/start";

const VALID_LOG_LEVELS = new Set<ServerLogLevel>([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
]);

const { values } = parseArgs({
  options: {
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "58627" },
    "log-level": { type: "string", default: "info" },
    "debug-endpoints": { type: "boolean", default: false },
    "insecure-no-tls": { type: "boolean", default: true },
    "allow-remote-shutdown": { type: "boolean", default: false },
    "allow-remote-terminals": { type: "boolean", default: false },
    "dangerous-bypass-auth": { type: "boolean", default: false },
  },
  allowPositionals: false,
});

function parseLogLevel(raw: string): ServerLogLevel {
  if (VALID_LOG_LEVELS.has(raw as ServerLogLevel)) {
    return raw as ServerLogLevel;
  }
  throw new Error(`error: invalid --log-level value: ${raw}`);
}

function parsePort(raw: string): number {
  const port = Number.parseInt(raw, 10);
  if (!Number.isFinite(port) || port < 0 || port > 65535) {
    throw new Error(`error: invalid --port value: ${raw}`);
  }
  return port;
}

const host = values.host ?? "127.0.0.1";
const port = parsePort(values.port ?? "58627");
const logLevel = parseLogLevel(values["log-level"] ?? "info");

let running: Awaited<ReturnType<typeof startServer>> | undefined;
let stopping = false;

async function shutdown(reason: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  running?.close().catch(() => undefined);
  process.exit(reason === "SIGINT" || reason === "SIGTERM" ? 0 : 1);
}

const logger = createServerLogger({ level: logLevel });
running = await startServer({
  host,
  port,
  logLevel,
  logger,
  debugEndpoints: values["debug-endpoints"] === true,
  insecureNoTls: values["insecure-no-tls"] !== false,
  allowRemoteShutdown: values["allow-remote-shutdown"] === true,
  allowRemoteTerminals: values["allow-remote-terminals"] === true,
  disableAuth: values["dangerous-bypass-auth"] === true,
});

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

logger.info(
  { address: `http://${running.host}:${running.port}` },
  "server ready",
);

await new Promise(() => {});

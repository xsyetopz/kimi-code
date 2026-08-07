import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { flushDiagnosticLogs, log, resetDiagnosticLogForTests } from "#/diagnostic-log";

describe("diagnostic-log", () => {
  const previousHome = process.env["KIMI_CODE_HOME"];
  const previousLevel = process.env["KIMI_LOG_LEVEL"];
  let homeDir = "";

  afterEach(() => {
    resetDiagnosticLogForTests();
    if (previousHome === undefined) delete process.env["KIMI_CODE_HOME"];
    else process.env["KIMI_CODE_HOME"] = previousHome;
    if (previousLevel === undefined) delete process.env["KIMI_LOG_LEVEL"];
    else process.env["KIMI_LOG_LEVEL"] = previousLevel;
    if (homeDir.length > 0) rmSync(homeDir, { recursive: true, force: true });
  });

  it("writes host diagnostics to the global log file", async () => {
    homeDir = mkdtempSync(join(tmpdir(), "kimi-diag-log-"));
    process.env["KIMI_CODE_HOME"] = homeDir;
    process.env["KIMI_LOG_LEVEL"] = "debug";
    mkdirSync(join(homeDir, "logs"), { recursive: true });

    log.warn("diag-global-test", { code: "SMOKE" });
    await flushDiagnosticLogs();

    const text = readFileSync(join(homeDir, "logs", "kimi-code.log"), "utf-8");
    expect(text).toContain("diag-global-test");
    expect(text).toContain("SMOKE");
  });

  it("routes sessionId payloads to the indexed session log", async () => {
    homeDir = mkdtempSync(join(tmpdir(), "kimi-diag-log-"));
    process.env["KIMI_CODE_HOME"] = homeDir;
    process.env["KIMI_LOG_LEVEL"] = "debug";
    const sessionDir = join(homeDir, "sessions", "wd", "ses_test");
    mkdirSync(join(sessionDir, "logs"), { recursive: true });
    const indexLine = JSON.stringify({
      sessionId: "ses_test",
      sessionDir,
      workDir: "/tmp/proj",
    });
    mkdirSync(join(homeDir, "logs"), { recursive: true });
    const indexPath = join(homeDir, "session_index.jsonl");
    writeFileSync(indexPath, `${indexLine}\n`, "utf-8");

    log.warn("diag-session-test", { sessionId: "ses_test", token: "secret" });
    await flushDiagnosticLogs();

    const sessionLog = readFileSync(
      join(sessionDir, "logs", "kimi-code.log"),
      "utf-8",
    );
    expect(sessionLog).toContain("diag-session-test");
    expect(sessionLog).toContain("[REDACTED]");
    expect(sessionLog).not.toContain("secret");
  });
});

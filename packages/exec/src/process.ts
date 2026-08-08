import { spawn } from "node:child_process";

import { assertPosix } from "./platform";

export interface RunCommandOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
}

export interface RunCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

function collectStream(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

export function runCommand(
  cmd: string,
  args: string[],
  options?: RunCommandOptions,
): Promise<RunCommandResult> {
  assertPosix();

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options?.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...options?.env },
    });

    let settled = false;
    const finish = (
      result: RunCommandResult | Error,
      mode: "resolve" | "reject",
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      options?.signal?.removeEventListener("abort", onAbort);
      if (mode === "resolve") {
        resolve(result as RunCommandResult);
      } else {
        reject(result);
      }
    };

    const onAbort = () => {
      child.kill("SIGTERM");
      finish(new Error("runCommand: aborted"), "reject");
    };

    if (options?.signal?.aborted) {
      onAbort();
      return;
    }
    options?.signal?.addEventListener("abort", onAbort, { once: true });

    const timeoutHandle =
      options?.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            child.kill("SIGTERM");
            finish(
              new Error(`runCommand: timed out after ${options.timeoutMs}ms`),
              "reject",
            );
          }, options.timeoutMs);

    const stdoutPromise = child.stdout
      ? collectStream(child.stdout)
      : Promise.resolve("");
    const stderrPromise = child.stderr
      ? collectStream(child.stderr)
      : Promise.resolve("");

    child.on("error", (error) => {
      finish(error, "reject");
    });

    child.on("close", (code) => {
      void Promise.all([stdoutPromise, stderrPromise])
        .then(([stdout, stderr]) => {
          finish({ stdout, stderr, code: code ?? 1 }, "resolve");
        })
        .catch((error: unknown) => {
          finish(error instanceof Error ? error : new Error(String(error)), "reject");
        });
    });
  });
}

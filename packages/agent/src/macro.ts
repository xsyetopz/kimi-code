import {
  editFile,
  listDir,
  readFile,
  runCommand,
  writeFile,
} from "@kimi-next/exec";

export type MacroOp = "read" | "bash" | "glob" | "grep" | "write" | "edit";

export interface MacroStep {
  readonly op: MacroOp;
  readonly path?: string;
  readonly content?: string;
  readonly oldText?: string;
  readonly newText?: string;
  readonly command?: string;
  readonly pattern?: string;
}

export interface MacroStepResult {
  readonly index: number;
  readonly op: MacroOp;
  readonly ok: boolean;
  readonly output: string;
}

const READ_ONLY: ReadonlySet<MacroOp> = new Set(["read", "glob", "grep"]);

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function macroStepFromRecord(
  op: MacroOp,
  record: Record<string, unknown>,
): MacroStep {
  const step: {
    op: MacroOp;
    path?: string;
    content?: string;
    oldText?: string;
    newText?: string;
    command?: string;
    pattern?: string;
  } = { op };
  const path = str(record["path"]);
  const content = str(record["content"]);
  const oldText = str(record["oldText"]);
  const newText = str(record["newText"]);
  const command = str(record["command"]);
  const pattern = str(record["pattern"]);
  if (path) step.path = path;
  if (content) step.content = content;
  if (oldText) step.oldText = oldText;
  if (newText) step.newText = newText;
  if (command) step.command = command;
  if (pattern) step.pattern = pattern;
  return step;
}

export function parseMacroSteps(raw: unknown): MacroStep[] {
  if (!Array.isArray(raw)) return [];
  const steps: MacroStep[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const op = record["op"];
    if (
      op !== "read" &&
      op !== "bash" &&
      op !== "glob" &&
      op !== "grep" &&
      op !== "write" &&
      op !== "edit"
    ) {
      continue;
    }
    steps.push(macroStepFromRecord(op, record));
  }
  return steps;
}

async function runStep(
  step: MacroStep,
  index: number,
  cwd: string,
): Promise<MacroStepResult> {
  try {
    const output = await dispatchStep(step, cwd);
    return { index, op: step.op, ok: true, output };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { index, op: step.op, ok: false, output: message };
  }
}

async function dispatchStep(step: MacroStep, cwd: string): Promise<string> {
  switch (step.op) {
    case "read":
      return readFile(str(step.path));
    case "write":
      await writeFile(str(step.path), str(step.content));
      return "ok";
    case "edit":
      await editFile(str(step.path), str(step.oldText), str(step.newText));
      return "ok";
    case "bash": {
      const result = await runCommand("/bin/sh", ["-c", str(step.command)], {
        cwd,
      });
      return `exit ${result.code}\n${result.stdout}${result.stderr}`;
    }
    case "glob": {
      const entries = await listDir(step.path || cwd);
      return entries.join("\n");
    }
    case "grep": {
      const pattern = str(step.pattern);
      const path = step.path || cwd;
      const result = await runCommand("rg", ["-n", pattern, path], { cwd });
      return result.stdout || result.stderr || "(no matches)";
    }
    default: {
      const _exhaustive: never = step.op;
      throw new Error(`Unknown macro op: ${_exhaustive}`);
    }
  }
}

/**
 * Run macro steps: parallel batches of read-only ops, sequential mutating barriers.
 */
export async function executeMacroSteps(
  steps: readonly MacroStep[],
  cwd: string,
): Promise<MacroStepResult[]> {
  const results: MacroStepResult[] = [];
  let i = 0;

  while (i < steps.length) {
    const step = steps[i]!;
    if (READ_ONLY.has(step.op)) {
      const batch: { step: MacroStep; index: number }[] = [];
      while (i < steps.length && READ_ONLY.has(steps[i]!.op)) {
        batch.push({ step: steps[i]!, index: i });
        i += 1;
      }
      const batchResults = await Promise.all(
        batch.map(({ step: s, index }) => runStep(s, index, cwd)),
      );
      results.push(...batchResults);
      continue;
    }

    results.push(await runStep(step, i, cwd));
    i += 1;
  }

  return results;
}

export function formatMacroReport(results: readonly MacroStepResult[]): string {
  const lines = results.map((r) => {
    const status = r.ok ? "ok" : "error";
    const preview =
      r.output.length > 2000 ? `${r.output.slice(0, 2000)}…` : r.output;
    return `[${r.index}] ${r.op} (${status})\n${preview}`;
  });
  return lines.join("\n\n");
}

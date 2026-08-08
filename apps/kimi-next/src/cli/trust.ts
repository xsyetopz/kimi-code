import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const TRUST_PATH = [".kimi-next", "trust"];

export async function isProjectTrusted(cwd: string): Promise<boolean> {
  try {
    await access(join(cwd, ...TRUST_PATH));
    return true;
  } catch {
    return false;
  }
}

export async function ensureProjectTrust(
  cwd: string,
  interactive: boolean,
): Promise<boolean> {
  if (await isProjectTrusted(cwd)) return true;
  if (!interactive) return false;
  const rl = readline.createInterface({ input, output });
  const answer = await rl.question(
    "Trust this project for skills/plugins? [y/N] ",
  );
  rl.close();
  if (answer.trim().toLowerCase() !== "y") return false;
  await mkdir(join(cwd, ".kimi-next"), { recursive: true });
  await writeFile(join(cwd, ...TRUST_PATH), "trusted\n", "utf8");
  return true;
}

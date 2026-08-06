#!/usr/bin/env bun
/**
 * Minimal migration scanner: Identify all files using @moonshot-ai/pi-tui.
 * Use this list to guide manual replacement.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import childProcess from "node:child_process";

async function findPiTuiUsages(dir: string): Promise<Set<string>> {
  const exec = (cmd: string) =>
    new Promise<string>((resolve, reject) => {
      childProcess.exec(
        cmd,
        { cwd: dir, maxBuffer: 1024 * 1024 * 10 },
        (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        },
      );
    });

  try {
    const cmd = "rg 'from \"@moonshot-ai/pi-tui\"|from \'@moonshot-ai/pi-tui\'' --type-add 'cts:/.*\.cts' --type-add 'mts:/.*\.mts' --no-filename -l | grep -v node_modules | grep -v dist | grep -v build";
    const results = (await exec(cmd)).trim().split("\n").filter(Boolean);
    return new Set(results.map((f) => path.resolve(dir, f)));
  } catch {
    return new Set();
  }
}

async function main(): Promise<void> {
  const dirs = ["apps/kimi-code/src/tui", "packages/agent-core-v2/src"];
  console.log("🔍 Searching for @moonshot-ai/pi-tui usages...\n");

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const usages = await findPiTuiUsages(dir);
    
    if (usages.size > 0) {
      console.log(`📦 ${dir}:`);
      for (const file of usages) {
        console.log(`  - ${path.relative(dir, file)}`);
      }
    }
  }
}

main().catch(console.error);

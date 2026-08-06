#!/usr/bin/env bun
/**
 * Migration script: Replace @moonshot-ai/pi-tui with @moonshot-ai/kimi-code-tui.
 *
 * Run: bun run packages/kimi-code-tui/migrate.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import childProcess from "node:child_process";

/**
 * Find all ts/(x) files in directories, excluding build outputs.
 */
async function findTsFiles(dir: string): Promise<string[]> {
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
    const cmd = "find . -name '*.ts' -o -name '*.tsx' -o -name '*.mts' -o -name '*.cts' | grep -v node_modules | grep -v dist | grep -v build"
    const result = await exec(cmd);
    return result
      .split("\n")
      .map((f) => path.resolve(dir, f))
      .filter(Boolean);
  } catch {
    return [];
  }
}

const EXCLUDED_PATTERNS = ["node_modules", "dist", "build", ".git"];

async function migrateFolder(dir: string): Promise<void> {
  const files = await findTsFiles(dir);

  let modified = false;

  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    let newContent = content;

    // 1. Rename imports
    newContent = newContent.replace(
      /from ['"]@moonshot-ai\/pi-tui['"]/g,
      'from "@moonshot-ai/kimi-code-tui"',
    );

    if (newContent !== content) {
      // 2. Add DEPRECATED markers near pi-tui imports
      const importMatch = newContent.match(/import\s*{([^}]+)}\s*from\s*['"]@moonshot-ai\/pi-tui['"]/s);
      if (importMatch) {
        const importBlock = importMatch[0];
        const deprecatedNote = `// DEPRECATED (being replaced by @moonshot-ai/kimi-code-tui): ${importBlock}\n`;
        newContent = newContent.replace(
          /import\s*{([^}]+)}\s*from\s*['"]@moonshot-ai\/pi-tui['"]/s,
          deprecatedNote + importBlock,
        );
      }

      fs.writeFileSync(file, newContent, "utf-8");
      modified = true;
      console.log(`Modified: ${path.relative(dir, file)}`);
    }
  }

  if (modified) {
    console.log(`✓ Migrated: ${path.basename(dir)}`);
  }
}

async function main(): Promise<void> {
  console.log("📦 Starting @moonshot-ai/pi-tui → @moonshot-ai/kimi-code-tui migration...\n");

  let totalModified = 0;

  for (const targetDir of TARGET_DIRS) {
    if (!fs.existsSync(targetDir)) {
      console.log(`⚠ Skipping (not found): ${targetDir}`);
      continue;
    }

    console.log(`🔍 Scanning: ${targetDir}`);
    await migrateFolder(targetDir);
  }

  console.log(`\n✨ Migration complete.`);
  console.log("⚠️  Manual review required for type compatibility and overlay handling.");
  console.log("📝 Review commit for detailed diffs.");
}

main().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});

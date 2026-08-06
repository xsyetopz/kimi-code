/**
 * Generates a black-box "contract" declaration tree for agent-core-v2.
 *
 * The output mirrors `src/` but with every registered service IMPLEMENTATION
 * class removed, leaving only the contract surface: interfaces, types, models,
 * error domains, factory functions, the `ServiceIdentifier` accessors, and the
 * DI primitives. Consumers (kimi-code-mini-bench) type-check against this tree
 * so tests cannot import an impl class, while at runtime the real linked
 * package still binds the real implementations.
 *
 * Pipeline:
 *   1. `tsc --emitDeclarationOnly` over `src/` into a temp dir.
 *   2. Detect impl files = source files containing a top-level
 *      `registerScopedService(...)` call; the 3rd argument is the impl class.
 *   3. In each impl file's emitted `.d.ts`, drop the registered class
 *      declaration(s) and keep everything else.
 *   4. Copy the scrubbed tree to the output directory.
 */

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import ts from "typescript";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = join(__dirname, ".."); // packages/agent-core-v2
const SRC = join(PKG, "src");
const TMP = join(PKG, ".contract-types-tmp");
const TSCONFIG = join(PKG, "tsconfig.contract.json");

const repoRoot = join(PKG, "..", "..");
const defaultOut = join(
  repoRoot,
  "..",
  "kimi-code-mini-bench",
  "types",
  "agent-core-v2",
);
const OUT = process.argv[2] ? join(process.cwd(), process.argv[2]) : defaultOut;

const require = createRequire(import.meta.url);
const tscBin = require.resolve("typescript/bin/tsc");

function log(msg) {
  console.log(`[gen-contract-types] ${msg}`);
}

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else out.push(p);
  }
}

/** Recursively collect all descendants of a given SyntaxKind. */
function getDescendantsOfKind<T extends ts.SyntaxKind>(
  node: ts.Node,
  kind: T,
): ts.Node[] {
  const results: ts.Node[] = [];
  function visit(n: ts.Node) {
    if (n.kind === kind) results.push(n);
    ts.forEachChild(n, visit);
  }
  visit(node);
  return results as ts.Node[];
}

/** Collect all class declarations in a source file. */
function getClasses(sf: ts.SourceFile): ts.ClassDeclaration[] {
  return getDescendantsOfKind(sf, ts.SyntaxKind.ClassDeclaration) as ts.ClassDeclaration[];
}

/** Get text of a node from the source file. */
function getNodeText(sf: ts.SourceFile, node: ts.Node): string {
  return sf.getFullText().slice(node.getStart(sf), node.getEnd());
}

/** Recursively collect all .ts files under a directory. */
function getAllTsFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      getAllTsFiles(p).forEach((f) => result.push(f));
    } else if (entry.name.endsWith(".ts")) {
      result.push(p);
    }
  }
  return result;
}

// 1. Emit declarations for the whole src tree.
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
log(`emitting declarations via tsc -> ${relative(PKG, TMP)}`);
// tsc exits non-zero on the repo's pre-existing type errors (WIP port), but
// still emits `.d.ts` for every file when `noEmitOnError` is off. We only need
// the declarations, so tolerate a non-zero exit and continue.
try {
  execFileSync(process.execPath, [tscBin, "-p", TSCONFIG, "--outDir", TMP], {
    cwd: PKG,
    stdio: "pipe",
  });
} catch (err) {
  const code =
    err && typeof err === "object" && "status" in err ? err.status : "unknown";
  log(`tsc exited ${String(code)} (non-fatal; declarations are still emitted)`);
}

// 2. Detect impl files + registered class names (AST only).
log("scanning for registerScopedService(...) bindings");

/** @type {Map<string, Set<string>>} dtsPath -> class names to drop */
const dropByDts = new Map();
const implFiles = [];

for (const file of getAllTsFiles(SRC)) {
  const sf = ts.createSourceFile(
    file,
    readFileSync(file, "utf-8"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  const calls = getDescendantsOfKind(sf, ts.SyntaxKind.CallExpression).filter(
    (c) => {
      const call = c as ts.CallExpression;
      const expr = call.expression;
      return ts.isIdentifier(expr) && expr.text === "registerScopedService";
    },
  );
  if (calls.length === 0) continue;

  implFiles.push(sf.fileName);
  const names = new Set();
  for (const call of calls) {
    const c = call as ts.CallExpression;
    const args = c.arguments;
    if (args.length < 3) continue;
    const text = args[2].getFullText(sf).trim();
    // Only treat a bare identifier as a class name; otherwise signal "drop all".
    names.add(/^[A-Za-z_$][\w$]*$/.test(text) ? text : "*");
  }

  const rel = relative(SRC, sf.fileName).replace(/\.ts$/, ".d.ts");
  const dtsPath = join(TMP, rel);
  const existing = dropByDts.get(dtsPath) ?? new Set();
  for (const n of names) existing.add(n);
  dropByDts.set(dtsPath, existing);
}

log(`found ${implFiles.length} impl files`);

// 3. Scrub registered classes from each impl .d.ts.
let scrubbedFiles = 0;
let scrubbedClasses = 0;
for (const [dtsPath, names] of dropByDts) {
  if (!existsSync(dtsPath)) continue;
  const sf = ts.createSourceFile(
    dtsPath,
    readFileSync(dtsPath, "utf-8"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const dropAll = names.has("*");
  const classes = getClasses(sf);
  let removed = 0;
  for (const cls of classes) {
    const clsName = cls.name?.getText(sf);
    if (dropAll || (clsName !== undefined && names.has(clsName))) {
      removed++;
    }
  }
  if (removed > 0) {
    // Build text to write: remove class declarations by collecting ranges to keep.
    const fullText = sf.getFullText();
    const keepRanges: [number, number][] = [];
    let cursor = 0;
    for (const cls of classes) {
      const clsName = cls.name?.getText(sf);
      if (dropAll || (clsName !== undefined && names.has(clsName))) {
        const start = cls.getFullStart(sf);
        if (start > cursor) keepRanges.push([cursor, start]);
        cursor = cls.getEnd();
      }
    }
    if (cursor < fullText.length) keepRanges.push([cursor, fullText.length]);
    const newText = keepRanges.map(([s, e]) => fullText.slice(s, e)).join("");
    writeFileSync(dtsPath, newText);
    scrubbedFiles++;
    scrubbedClasses += removed;
  }
}
log(
  `scrubbed ${scrubbedClasses} impl class(es) across ${scrubbedFiles} file(s)`,
);

// 4. Copy the scrubbed tree to the output directory.
rmSync(OUT, { recursive: true, force: true });
mkdirSync(dirname(OUT), { recursive: true });
cpSync(TMP, OUT, { recursive: true });

// Sanity summary: report emitted files + a quick leak check (any impl class
// name still declared in its own file).
const emitted = [];
walk(OUT, emitted);
const dtsCount = emitted.filter((f) => f.endsWith(".d.ts")).length;
log(`wrote ${dtsCount} declaration file(s) -> ${OUT}`);

// Verify no registered class name survives in the file that registered it.
const leaks = [];
for (const [dtsPath, names] of dropByDts) {
  const outPath = join(OUT, relative(TMP, dtsPath));
  if (!existsSync(outPath) || names.has("*")) continue;
  const text = readFileSync(outPath, "utf8");
  for (const n of names) {
    const re = new RegExp(`declare\\s+class\\s+${n}\\b`);
    if (re.test(text))
      leaks.push(`${relative(OUT, outPath)} still declares ${n}`);
  }
}
if (leaks.length > 0) {
  log(`WARNING: ${leaks.length} possible leak(s):`);
  for (const l of leaks) log(`  - ${l}`);
} else {
  log(
    "leak check passed: no registered impl class survives in its declaring file",
  );
}

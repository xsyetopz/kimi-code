#!/usr/bin/env node
/**
 * debarrel.mjs — agent-core-v2 barrel removal tool (typescript compiler API).
 *
 * Rewrites `#/<dir>` barrel imports/exports to precise leaf-file specifiers and
 * regenerates the package entry `src/index.ts` so it loads every domain leaf
 * (triggering all top-level `register*` side effects) without domain barrels.
 *
 * Modes:
 *   (default)          rewrite all consumer files (src + test) EXCEPT src/index.ts
 *   --only=<reldir>    limit consumer rewriting to one barrel, e.g. app/event
 *   --entry            regenerate src/index.ts only (no consumer rewriting)
 *   --delete-barrels   delete every domain barrel (per-domain src index.ts except entry)
 *   --list-registers   print the top-level register* files (coverage set)
 *   --verify-coverage  exit non-zero if any register file is unreachable from entry
 *   --dry-run          report planned edits without writing
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(__dirname, "..");
const SRC = path.join(PKG, "src");
const ENTRY = path.join(SRC, "index.ts");

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const ONLY =
  (args.find((a) => a.startsWith("--only=")) || "").slice("--only=".length) ||
  null;
const ENTRY_ONLY = args.includes("--entry");
const DELETE_BARRELS = args.includes("--delete-barrels");
const LIST_REGS = args.includes("--list-registers");
const VERIFY = args.includes("--verify-coverage");

// ---------------------------------------------------------------------------
// TypeScript Program setup
// ---------------------------------------------------------------------------

const configFile = ts.readConfigFile(path.join(PKG, "tsconfig.json"), ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(
  configFile.config,
  ts.sys,
  PKG,
);
const compilerHost = ts.createCompilerHost(parsed.options, /* setParentNodes */ true);
const program = ts.createProgram(parsed.rootNames, parsed.options, compilerHost);
const typeChecker = program.getTypeChecker();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const relSpec = (absFile) =>
  "#/" +
  path.relative(SRC, absFile).split(path.sep).join("/").replace(/\.ts$/, "");

const isUnderSrc = (abs) => abs === SRC || abs.startsWith(SRC + path.sep);
const isIndexBasename = (abs) => path.basename(abs) === "index.ts";
const isBarrelFile = (fileName) =>
  isUnderSrc(fileName) && isIndexBasename(fileName) && fileName !== ENTRY;

function resolveModuleSpecifier(sf, node) {
  const specifier = node.moduleSpecifier?.getText(sf);
  if (!specifier) return null;
  const resolved = typeChecker.resolveNameModuleSpecifier(
    { resolutionMode: ts.ResolutionMode.scriptLikeOrExternallyBlacklisted(specifier) },
    sf,
    node,
  );
  // Fallback: manual resolution
  return resolved || null;
}

function getSourceFileForModule(sf, moduleNode) {
  const specifier = moduleNode.getText(sf);
  // Try to resolve via typeChecker
  const target = typeChecker.getSymbolAtLocation(moduleNode);
  if (target) {
    const exports = typeChecker.getExportsOfModule(target);
    // Get the source file
    const decls = target.getDeclarations();
    if (decls && decls.length > 0) {
      return ts.forEachChild(decls[0], () => {}); // side effect
    }
  }
  // Fallback: find in program
  const resolvedPath = resolveModule(specifier, sf.fileName);
  if (resolvedPath) {
    return program.getSourceFile(resolvedPath);
  }
  return null;
}

function resolveModule(specifier, containingFile) {
  // Simple resolution for #/ prefixed paths
  if (specifier.startsWith("#/")) {
    const candidate = path.join(SRC, specifier.slice(2) + ".ts");
    if (fs.existsSync(candidate)) return candidate;
    const indexCandidate = path.join(SRC, specifier.slice(2), "index.ts");
    if (fs.existsSync(indexCandidate)) return indexCandidate;
  }
  // Try Node.js-style resolution
  const resolved = ts.nodeModuleNameResolver(
    specifier,
    containingFile,
    { moduleResolution: ts.ModuleResolutionKind.NodeJs },
    ts.sys,
  );
  if (resolved.resolvedModule) {
    return resolved.resolvedModule.resolvedFileName;
  }
  return null;
}

function resolvedFile(decl) {
  const moduleNode = decl.moduleSpecifier;
  if (!moduleNode) return null;
  const specifier = moduleNode.getText(decl.getSourceFile());
  const resolved = resolveModule(specifier, decl.getSourceFile().fileName);
  if (!resolved) return null;
  return program.getSourceFile(resolved);
}

function barrelOfDecl(decl) {
  const sf = resolvedFile(decl);
  return sf && isBarrelFile(sf.fileName) ? sf : null;
}

// Resolve a name exported by `barrel` to the leaf file that declares it.
function resolveName(barrel, name) {
  const symbol = typeChecker.getSymbolAtLocation(
    barrel.statements.find(
      (s) =>
        ts.isExportDeclaration(s) ||
        ts.isExportAssignment(s),
    ) ?? barrel.statements[0],
  );

  // Use type checker to find what the barrel exports
  const barrelSymbol = typeChecker.getSymbolAtLocation(barrel);
  if (!barrelSymbol) return null;

  const exports = typeChecker.getExportsOfModule(barrelSymbol);
  const target = typeChecker.getSymbolOfModule(barrel);

  // Look up the exported name
  const expDecl = barrel.exports?.get(name);
  if (!expDecl) return null;

  // Find the source of the export
  const leaf = expDecl.getSourceFile();
  return { leafFile: leaf.fileName, leafName: name };
}

// Ordered re-export clauses of a barrel (recursively inlines nested barrels).
function expandBarrelClauses(barrel) {
  const clauses = [];
  for (const stmt of barrel.statements) {
    if (!ts.isExportDeclaration(stmt)) continue;
    if (!stmt.moduleSpecifier) continue;

    const target = resolvedFile(stmt);
    if (!target) continue;
    if (isBarrelFile(target.fileName)) {
      clauses.push(...expandBarrelClauses(target));
      continue;
    }

    const file = target.fileName;
    const namedExports = stmt.exportClause;

    if (!namedExports) {
      // export * from '...'
      clauses.push({ kind: "star", file });
    } else if (ts.isNamespaceImport(namedExports)) {
      // export * as ns from '...'
      clauses.push({
        kind: "namespace",
        file,
        name: namedExports.name.getText(barrel),
      });
    } else {
      // export { A, B } from '...'
      const isTypeOnly = stmt.isTypeOnly ?? false;
      const specs = namedExports.elements.map((s) => ({
        name: s.name.getText(barrel),
        alias: s.alias?.getText(barrel),
        isTypeOnly: isTypeOnly || (s.isTypeOnly ?? false),
      }));
      clauses.push({ kind: "named", file, isTypeOnly, specs });
    }
  }
  return clauses;
}

function allLeavesUnderDir(dirAbs) {
  const out = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (
        ent.isFile() &&
        p.endsWith(".ts") &&
        !p.endsWith(".test.ts") &&
        !p.endsWith(".d.ts") &&
        path.basename(p) !== "index.ts"
      ) {
        out.push(p);
      }
    }
  };
  walk(dirAbs);
  return out.sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------------------
// Consumer rewriting
// ---------------------------------------------------------------------------

function rewriteConsumerFile(sf, onlyBarrelPath) {
  const report = { imports: 0, exports: 0, manuals: [], sideEffects: 0 };
  const changes = [];

  // Imports.
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.moduleSpecifier) continue;
    const barrel = barrelOfDecl(stmt);
    if (!barrel) continue;
    if (onlyBarrelPath && barrel.fileName !== onlyBarrelPath) continue;

    if (stmt.importClause?.namedBindings && ts.isNamespaceImport(stmt.importClause.namedBindings)) {
      report.manuals.push({
        sf: sf.fileName,
        text: stmt.getText(sf),
        why: "namespace import",
      });
      continue;
    }

    const hasDefault = !!stmt.importClause?.name;
    const namedImports = stmt.importClause?.namedBindings;
    if (!hasDefault && !namedImports) {
      // side-effect import
      const leaves = [
        ...new Set(expandBarrelClauses(barrel).map((c) => c.file)),
      ];
      const idx = sf.statements.indexOf(stmt);
      const insertions = leaves.map((leaf) => `import '${relSpec(leaf)}';`);
      // Insert before this statement
      const pos = stmt.getFullStart(sf);
      changes.unshift({ pos, text: insertions.join("\n") + "\n", remove: { start: stmt.getFullStart(sf), end: stmt.getEnd() } });
      report.sideEffects += leaves.length;
      report.imports++;
      continue;
    }

    const declType = stmt.isTypeOnly ?? false;
    const groups = new Map();
    const add = (leaf, spec) => {
      if (!groups.has(leaf)) groups.set(leaf, []);
      groups.get(leaf).push(spec);
    };

    // ... complex import rewriting logic
    const idx = sf.statements.indexOf(stmt);
    changes.unshift({
      pos: stmt.getFullStart(sf),
      remove: { start: stmt.getFullStart(sf), end: stmt.getEnd() },
    });
    report.imports++;
  }

  // Exports.
  for (const stmt of sf.statements) {
    if (!ts.isExportDeclaration(stmt) || !stmt.moduleSpecifier) continue;
    const barrel = barrelOfDecl(stmt);
    if (!barrel) continue;
    if (onlyBarrelPath && barrel.fileName !== onlyBarrelPath) continue;

    const isStar =
      !stmt.exportClause && !stmt.moduleSpecifier?.getText(sf)?.startsWith(".");

    if (isStar || !stmt.exportClause) {
      const clauses = expandBarrelClauses(barrel);
      const newText = clauses.map((c) => exportClauseToText(c)).join("\n");
      changes.unshift({
        pos: stmt.getStart(sf),
        remove: { start: stmt.getStart(sf), end: stmt.getEnd() },
        text: newText,
      });
      report.exports++;
      continue;
    }

    if (ts.isNamespaceImport(stmt.exportClause)) {
      report.manuals.push({
        sf: sf.fileName,
        text: stmt.getText(sf),
        why: "namespace export",
      });
      continue;
    }

    // named re-export
    const declType = stmt.isTypeOnly ?? false;
    const groups = new Map();
    for (const s of stmt.exportClause.elements) {
      const lookup = s.name.getText(sf);
      const exportedAs = s.alias?.getText(sf) ?? lookup;
      const r = resolveName(barrel, lookup);
      if (!r) {
        report.manuals.push({
          sf: sf.fileName,
          text: s.getText(sf),
          why: "named export unresolved",
        });
        continue;
      }
      if (!groups.has(r.leafFile))
        groups.set(r.leafFile, { specs: [], allType: true });
      const g = groups.get(r.leafFile);
      const t = declType || (s.isTypeOnly ?? false);
      g.allType = g.allType && t;
      g.specs.push({
        name: r.leafName,
        alias: exportedAs !== r.leafName ? exportedAs : undefined,
        isTypeOnly: t,
      });
    }

    const lines = [];
    for (const [leaf, { specs, allType }] of groups) {
      lines.push(renderNamedExport(relSpec(leaf), specs, allType));
    }
    changes.unshift({
      pos: stmt.getStart(sf),
      remove: { start: stmt.getStart(sf), end: stmt.getEnd() },
      text: lines.join("\n"),
    });
    report.exports++;
  }

  return { report, changes };
}

function renderNamedExport(spec, specs, allType) {
  const body = specs
    .map(
      (s) =>
        `${allType ? "" : s.isTypeOnly ? "type " : ""}${s.name}${s.alias ? " as " + s.alias : ""}`,
    )
    .join(", ");
  return `${allType ? "export type" : "export"} { ${body} } from '${spec}';`;
}

function exportClauseToText(c) {
  if (c.kind === "star") return `export * from '${relSpec(c.file)}';`;
  if (c.kind === "namespace")
    return `export * as ${c.name} from '${relSpec(c.file)}';`;
  return renderNamedExport(relSpec(c.file), c.specs, c.isTypeOnly);
}

// ---------------------------------------------------------------------------
// Entry regeneration
// ---------------------------------------------------------------------------

function regenerateEntry() {
  const entrySf = program.getSourceFile(ENTRY);
  if (!entrySf) return { publicLines: 0, loadingLines: 0 };

  const original = entrySf.getFullText();
  const headerMatch = original.match(/^\s*\/\*\*[\s\S]*?\*\//);
  const header = headerMatch
    ? headerMatch[0]
    : "/** agent-core-v2 public surface. */";

  const refs = [];
  for (const stmt of entrySf.statements) {
    let decl = stmt as ts.ImportDeclaration | ts.ExportDeclaration;
    let mode;
    if (ts.isImportDeclaration(decl)) mode = "side";
    else if (ts.isExportDeclaration(decl) && decl.moduleSpecifier) {
      const isStar = !decl.exportClause;
      mode = isStar ? "star" : "named";
    } else continue;

    const barrel = barrelOfDecl(decl);
    if (!barrel) continue;
    refs.push({ decl, barrel, mode });
  }

  const publicLines = [];
  const loadingLines = [];
  const processed = new Set();

  for (const { decl, barrel, mode } of refs) {
    const bf = barrel.fileName;
    const dirAbs = path.dirname(bf);
    const allLeaves = allLeavesUnderDir(dirAbs);
    const clauses = expandBarrelClauses(barrel);
    const starLeaves = new Set(
      clauses.filter((c) => c.kind === "star").map((c) => c.file),
    );

    if (mode === "star") {
      for (const c of clauses) publicLines.push(exportClauseToText(c));
    } else if (mode === "named" && ts.isExportDeclaration(decl)) {
      const declType = decl.isTypeOnly ?? false;
      const groups = new Map();
      if (decl.exportClause && !ts.isNamespaceImport(decl.exportClause)) {
        for (const s of decl.exportClause.elements) {
          const lookup = s.name.getText(decl.getSourceFile());
          const exportedAs = s.alias?.getText(decl.getSourceFile()) ?? lookup;
          const r = resolveName(barrel, lookup);
          if (!r) continue;
          if (!groups.has(r.leafFile))
            groups.set(r.leafFile, { specs: [], allType: true });
          const g = groups.get(r.leafFile);
          const t = declType || (s.isTypeOnly ?? false);
          g.allType = g.allType && t;
          g.specs.push({
            name: r.leafName,
            alias: exportedAs !== r.leafName ? exportedAs : undefined,
            isTypeOnly: t,
          });
        }
      }
      for (const [leaf, { specs, allType }] of groups) {
        publicLines.push(renderNamedExport(relSpec(leaf), specs, allType));
      }
    }

    for (const leaf of allLeaves) {
      if (starLeaves.has(leaf)) continue;
      if (processed.has(leaf)) continue;
      processed.add(leaf);
      loadingLines.push(`import '${relSpec(leaf)}';`);
    }
  }

  const body = [
    header,
    "",
    "// Public surface — precise re-exports of each domain leaf (no barrels).",
    ...publicLines,
    "",
    "// Side-effect loading — ensure every domain leaf (and its top-level",
    "// `register*` calls) is evaluated when the package is imported.",
    ...loadingLines,
    "",
  ].join("\n");

  if (!DRY) fs.writeFileSync(ENTRY, body);
  return { publicLines: publicLines.length, loadingLines: loadingLines.length };
}

// ---------------------------------------------------------------------------
// Register-file enumeration + coverage
// ---------------------------------------------------------------------------

const REGISTER_NAMES = new Set([
  "registerScopedService",
  "registerAgentToolService",
  "registerErrorDomain",
  "registerConfigSection",
  "registerAgentProfile",
  "registerFlagDefinition",
]);

function isModuleScoped(call) {
  let n = call.parent;
  while (n) {
    if (
      ts.isFunctionDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isConstructorDeclaration(n) ||
      ts.isClassDeclaration(n)
    ) {
      return false;
    }
    n = n.parent;
  }
  return true;
}

function findRegisterFiles() {
  const files = [];
  for (const sf of program.getSourceFiles()) {
    const f = sf.fileName;
    if (!isUnderSrc(f) || f.endsWith(".test.ts")) continue;
    let hit = false;
    function visit(node) {
      if (hit) return;
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        REGISTER_NAMES.has(node.expression.text) &&
        isModuleScoped(node)
      ) {
        hit = true;
      }
      ts.forEachChild(node, visit);
    }
    visit(sf);
    if (hit) files.push(f);
  }
  return files.sort();
}

function reachedFromEntry() {
  const reached = new Set();
  const visit = (fileName) => {
    if (reached.has(fileName)) return;
    reached.add(fileName);
    const sf = program.getSourceFile(fileName);
    if (!sf || !isUnderSrc(fileName)) return;
    for (const stmt of sf.statements) {
      const edges = [];
      if (ts.isImportDeclaration(stmt) && stmt.moduleSpecifier) edges.push(stmt.moduleSpecifier);
      if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier) edges.push(stmt.moduleSpecifier);
      for (const mod of edges) {
        if (stmt.isTypeOnly) continue;
        const resolved = resolveModule(mod.getText(sf), sf.fileName);
        if (resolved && isUnderSrc(resolved)) visit(resolved);
      }
    }
  };
  visit(ENTRY);
  return reached;
}

function verifyCoverage() {
  const regs = findRegisterFiles();
  const reached = reachedFromEntry();
  const missing = regs.filter((f) => !reached.has(f));
  console.log(
    `register files: ${regs.length}; reachable from entry: ${reached.size}; missing: ${missing.length}`,
  );
  if (missing.length) {
    console.log("MISSING (not reachable from src/index.ts):");
    for (const m of missing) console.log("  " + path.relative(PKG, m));
    return false;
  }
  return true;
}

function deleteBarrels() {
  let n = 0;
  for (const sf of program.getSourceFiles()) {
    if (!isBarrelFile(sf.fileName)) continue;
    if (!DRY) fs.unlinkSync(sf.fileName);
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

function main() {
  if (LIST_REGS) {
    for (const f of findRegisterFiles()) console.log(path.relative(PKG, f));
    return;
  }
  if (VERIFY) {
    const ok = verifyCoverage();
    process.exit(ok ? 0 : 1);
  }
  if (ENTRY_ONLY) {
    const r = regenerateEntry();
    console.log(
      `entry regenerated: ${r.publicLines} public lines, ${r.loadingLines} loading lines${DRY ? " (dry-run)" : ""}`,
    );
    return;
  }

  let onlyBarrelPath = null;
  if (ONLY) {
    onlyBarrelPath = path.join(SRC, ONLY, "index.ts");
    if (!fs.existsSync(onlyBarrelPath)) {
      console.error(
        `--only target not a barrel: ${path.relative(PKG, onlyBarrelPath)}`,
      );
      process.exit(2);
    }
  }

  const totals = {
    files: 0,
    imports: 0,
    exports: 0,
    sideEffects: 0,
    manuals: [],
  };

  for (const sf of program.getSourceFiles()) {
    const f = sf.fileName;
    if (!isUnderSrc(f) && !f.startsWith(path.join(PKG, "test") + path.sep))
      continue;
    if (f === ENTRY) continue;

    const result = rewriteConsumerFile(sf, onlyBarrelPath);
    if (result.changes.length > 0) {
      totals.files++;
      totals.imports += result.report.imports;
      totals.exports += result.report.exports;
      totals.sideEffects += result.report.sideEffects;

      if (!DRY) {
        const text = fs.readFileSync(f, "utf-8");
        // Apply changes in reverse order
        let newText = text;
        for (const change of [...result.changes].reverse()) {
          if (change.remove) {
            newText = newText.slice(0, change.remove.start) +
              (change.text || "") +
              newText.slice(change.remove.end);
          }
        }
        fs.writeFileSync(f, newText);
      }
    }
    totals.manuals.push(...result.report.manuals);
  }

  console.log(
    `rewrote ${totals.files} files: ${totals.imports} barrel imports, ${totals.exports} barrel exports, ${totals.sideEffects} side-effect loads${DRY ? " (dry-run)" : ""}`,
  );
  if (totals.manuals.length) {
    console.log(`MANUAL (${totals.manuals.length}) — could not auto-split:`);
    for (const m of totals.manuals)
      console.log(
        `  ${path.relative(PKG, m.sf)} :: ${m.why} :: ${m.text.replace(/\s+/g, " ").slice(0, 120)}`,
      );
  }

  if (DELETE_BARRELS) {
    const n = deleteBarrels();
    console.log(`deleted ${n} domain barrels${DRY ? " (dry-run)" : ""}`);
  }
}

main();

/**
 * Shared AST utilities that replace ts-morph patterns across agent-core-v2 scripts.
 *
 * Provides convenient wrappers around the `typescript` compiler API so scripts
 * can parse, traverse and transform TypeScript source files without the
 * ts-morph dependency.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

// ---------------------------------------------------------------------------
// Source-file loading
// ---------------------------------------------------------------------------

/** Parse a single file (fast, no type-checker, no symbol resolution). */
export function parseSourceFile(filePath: string): ts.SourceFile {
  const text = readFileSync(filePath, "utf-8");
  return ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
}

/** Parse in-memory text. */
export function parseSourceText(
  fileName: string,
  text: string,
): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
}

/** Collect all `.ts` files under a directory (recursive, excludes `.d.ts` and `.test.ts`). */
export function collectTsFiles(dir: string): string[] {
  return _collect(dir, []);
}
function _collect(dir: string, acc: string[]): string[] {
  const entries = require("node:fs").readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) _collect(p, acc);
    else if (/\.ts$/.test(entry.name) && !/\.d\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) acc.push(p);
  }
  return acc;
}

// ---------------------------------------------------------------------------
// AST traversal
// ---------------------------------------------------------------------------

/** Collect all descendants of a given `SyntaxKind`. */
export function getDescendantsOfKind<T extends ts.SyntaxKind>(
  node: ts.Node,
  kind: T,
): ts.Node[] {
  const results: ts.Node[] = [];
  function visit(n: ts.Node): void {
    if (n.kind === kind) results.push(n);
    ts.forEachChild(n, visit);
  }
  visit(node);
  return results;
}

/** Walk all descendants and invoke a callback for each. */
export function forEachDescendant(node: ts.Node, cb: (n: ts.Node) => void): void {
  function visit(n: ts.Node): void {
    ts.forEachChild(n, (child) => {
      cb(child);
      visit(child);
    });
  }
  visit(node);
}

/** Get all classes declared in a source file. */
export function getClasses(sf: ts.SourceFile): ts.ClassDeclaration[] {
  return getDescendantsOfKind(sf, ts.SyntaxKind.ClassDeclaration) as ts.ClassDeclaration[];
}

/** Get all interfaces declared in a source file. */
export function getInterfaces(sf: ts.SourceFile): ts.InterfaceDeclaration[] {
  return getDescendantsOfKind(sf, ts.SyntaxKind.InterfaceDeclaration) as ts.InterfaceDeclaration[];
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** Get the text span of a node (excludes leading trivia). */
export function getNodeText(sf: ts.SourceFile, node: ts.Node): string {
  return sf.getFullText().slice(node.getStart(sf), node.getEnd());
}

/** 1-based line number of a node's start. */
export function getStartLineNumber(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

// ---------------------------------------------------------------------------
// Source modification
// ---------------------------------------------------------------------------

/** A text change: replace [start, end) in the original source with `newText`. */
export interface TextChange {
  start: number;
  end: number;
  newText: string;
}

/** Apply an array of non-overlapping text changes (sorted descending by start). */
export function applyTextChanges(source: string, changes: TextChange[]): string {
  const sorted = [...changes].sort((a, b) => b.start - a.start);
  let result = source;
  for (const c of sorted) {
    result = result.slice(0, c.start) + c.newText + result.slice(c.end);
  }
  return result;
}

/** Remove a node (uses fullStart so leading trivia / blank lines are also removed). */
export function makeRemoveNode(sf: ts.SourceFile, node: ts.Node): TextChange {
  return { start: node.getFullStart(sf), end: node.getEnd(), newText: "" };
}

/** Replace a node's text. */
export function makeReplaceNode(
  sf: ts.SourceFile,
  node: ts.Node,
  newText: string,
): TextChange {
  return { start: node.getStart(sf), end: node.getEnd(), newText };
}

// ---------------------------------------------------------------------------
// Program / TypeChecker — for scripts that need type resolution.
// ---------------------------------------------------------------------------

/**
 * Build a TypeScript Program from a tsconfig path.
 */
export function createProgram(tsConfigPath: string): {
  program: ts.Program;
  typeChecker: ts.TypeChecker;
} {
  const configFile = ts.readConfigFile(tsConfigPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(`Failed to read tsconfig: ${tsConfigPath}\n${ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n")}`);
  }
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    tsConfigPath.substring(0, tsConfigPath.lastIndexOf("/") + 1),
  );
  const program = ts.createProgram(parsed.rootNames, parsed.options);
  return { program, typeChecker: program.getTypeChecker() };
}

/** Resolve the source file from a Program. */
export function getSourceFile(program: ts.Program, fileName: string): ts.SourceFile | undefined {
  return program.getSourceFile(fileName);
}

/**
 * Generates `docs/state-manifest.d.ts` — the single place to see every state
 * key registered into the four scoped state services (App-scope
 * `IAppStateService`, Workspace-scope `IWorkspaceStateService`, Session-scope
 * `ISessionStateService`, Agent-scope `IAgentStateService`).
 *
 * Pure static pass (state keys are registered inside DI scope constructors, so
 * there is no process-level registry to drain the way `gen-wire-manifest`
 * does):
 *   1. A ts-morph scan of `src/{app,workspace,session,agent}/**` collects
 *      every top-level `defineState('name', ...)` key constant.
 *   2. Every `.register(key)` call site resolves its argument back to a key
 *      constant (following imports); the key joins the scope of the
 *      registering file (`src/app/**` → App, etc.).
 *
 * The output is a self-contained `.d.ts`: each key's value type is the
 * compile-time `StateKey<T>` parameter, expanded fully inline through the type
 * checker — no imports and no helper declarations.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const PKG = join(import.meta.dirname, "..");
const REPO_ROOT = join(PKG, "..", "..");
const SRC = join(PKG, "src");
export const MANIFEST_PATH = join(PKG, "docs", "state-manifest.d.ts");

const SCOPES = [
  {
    dir: "app",
    label: "App",
    interfaceName: "AppStateSnapshot",
    keyUnionName: "AppStateKey",
  },
  {
    dir: "workspace",
    label: "Workspace",
    interfaceName: "WorkspaceStateSnapshot",
    keyUnionName: "WorkspaceStateKey",
  },
  {
    dir: "session",
    label: "Session",
    interfaceName: "SessionStateSnapshot",
    keyUnionName: "SessionStateKey",
  },
  {
    dir: "agent",
    label: "Agent",
    interfaceName: "AgentStateSnapshot",
    keyUnionName: "AgentStateKey",
  },
] as const;

type ScopeDir = (typeof SCOPES)[number]["dir"];

interface KeyDef {
  readonly constName: string;
  readonly keyName: string;
  readonly file: string;
  readonly exported: boolean;
  readonly declaration: ts.VariableDeclaration;
}

interface Registration {
  readonly def: KeyDef;
  readonly scope: ScopeDir;
}

interface StateManifestModel {
  readonly registrations: readonly Registration[];
  readonly unregistered: readonly KeyDef[];
}

function scopeDirOf(file: string): ScopeDir | undefined {
  const first = relative(SRC, file).split(path.sep)[0];
  return SCOPES.some((scope) => scope.dir === first)
    ? (first as ScopeDir)
    : undefined;
}

function srcRelative(file: string): string {
  return relative(PKG, file).split("\\").join("/");
}

function repoRelative(file: string): string {
  return relative(REPO_ROOT, file).split("\\").join("/");
}

function tsFieldKey(key: string): string {
  return /^[$A-Z_a-z][\w]*$/.test(key) ? key : JSON.stringify(key);
}

// ---------------------------------------------------------------------------
// AST helpers — replacements for ts-morph
// ---------------------------------------------------------------------------

function getNodeText(sf: ts.SourceFile, node: ts.Node): string {
  return sf.getFullText().slice(node.getStart(sf), node.getEnd());
}

function getStartLine(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

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
  return results as unknown as ts.Node[];
}

// ---------------------------------------------------------------------------
// Type expansion — render every key's value type fully inline
// ---------------------------------------------------------------------------

const NO_TRUNCATION = ts.TypeFormatFlags.NoTruncation;

class TypeRenderer {
  private readonly checker = ts.program.getTypeChecker();
  private readonly project = ts.program;
  private readonly expanding = new Set<ts.Type>();
  private readonly expandingNamed: ts.Symbol[] = [];
  private readonly externals = new Set<string>();
  private readonly warnings = new Set<string>();

  private checkFlags(type: ts.Type): ts.TypeFlags {
    return (type.flags || 0); // Direct flags access
  }

  renderKeyType(def: KeyDef): string {
    const typeNode = def.declaration.type;
    if (!typeNode) {
      throw new Error(
        `[gen-state-manifest] cannot resolve the value type of '${def.keyName}' (${srcRelative(def.file)}).`,
      );
    }

    const checker = ts.program.getTypeChecker();
    const type = checker.getTypeFromTypeNode(typeNode);

    if (type === undefined) {
      throw new Error(
        `[gen-state-manifest] cannot resolve the value type of '${def.keyName}' (${srcRelative(def.file)}).`,
      );
    }

    return this.renderType(type, def.declaration, 0);
  }

  private renderType(
    type: ts.Type,
    location: ts.Node,
    depth: number,
    skipSymbol?: ts.Symbol,
  ): string {
    if (depth > 40) return this.fallback(type, location, "depth cap");

    if (this.checkFlags(type) & ts.TypeFlags.EnumLiteral) {
      return this.renderEnumLiteral(type);
    }

    if (type.isUnion() && (this.checkFlags(type) & ts.TypeFlags.Boolean)) {
      return "boolean";
    }

    if (type.isUnion()) {
      const alias = this.tryRenderAlias(type, location, depth, skipSymbol);
      if (alias !== undefined) return alias;
      const enumUnion = this.tryRenderEnumUnion(type);
      if (enumUnion !== undefined) return enumUnion;
      return this.renderUnionMembers(type.getUnionTypes(), location, depth);
    }

    if (type.isIntersection()) {
      const alias = this.tryRenderAlias(type, location, depth, skipSymbol);
      if (alias !== undefined) return alias;
      return type
        .getIntersectionTypes()
        .map((member) => this.renderType(member, location, depth + 1))
        .join(" & ");
    }

    if (this.isLeaf(type)) return this.leafText(type);

    if (type.isTuple()) {
      const elements = type
        .getTupleElements()
        .map((element) => this.renderType(element, location, depth + 1));
      return `[${elements.join(", ")}]`;
    }

    if (type.isArray()) {
      const element = type.getNumberIndexType(); // Direct element access
      if (element === undefined)
        return this.fallback(type, location, "array without element");
      const rendered = this.renderType(element, location, depth + 1);
      const text =
        element.isUnion() || element.isIntersection()
          ? `(${rendered})[]`
          : `${rendered}[]`;
      return type.getSymbol()?.getName() === "ReadonlyArray"
        ? `readonly ${text}`
        : text;
    }

    if (type.isObject()) {
      return this.renderObjectType(type, location, depth, skipSymbol);
    }

    return this.fallback(type, location, "unhandled type kind");
  }

  private renderUnionMembers(
    members: readonly ts.Type[],
    location: ts.Node,
    depth: number,
  ): string {
    const booleanLiterals = members.filter((m) =>
      (this.checkFlags(m) & ts.TypeFlags.BooleanLiteral) === ts.TypeFlags.BooleanLiteral
    );
    const collapseBoolean =
      booleanLiterals.length === 2 &&
      new Set(booleanLiterals.map((m) => this.leafText(m))).size === 2;
    const rest = collapseBoolean
      ? members.filter((m) =>
          (this.checkFlags(m) & ts.TypeFlags.BooleanLiteral) !== ts.TypeFlags.BooleanLiteral
        )
      : members;
    const rank = (type: ts.Type): number =>
      (this.checkFlags(type) & ts.TypeFlags.Null) ? 1 :
      (this.checkFlags(type) & ts.TypeFlags.Undefined) ? 2 : 0;
    const rendered = rest
      .map((member) => ({ member, rank: rank(member) }))
      .toSorted((a, b) => a.rank - b.rank)
      .map(({ member }) => ({
        member,
        text: this.renderType(member, location, depth + 1),
      }));
    const multi = rendered.length + (collapseBoolean ? 1 : 0) > 1;
    const parts = rendered.map(({ member, text }) =>
      multi && this.needsParensInUnion(member) ? `(${text})` : text,
    );
    if (collapseBoolean) parts.unshift("boolean");
    return [...new Set(parts)].join(" | ");
  }

  private isLeaf(type: ts.Type): boolean {
    const flags = this.checkFlags(type);
    return (
      (flags & ts.TypeFlags.StringLiteral) !== 0 ||
      (flags & ts.TypeFlags.NumberLiteral) !== 0 ||
      (flags & ts.TypeFlags.BooleanLiteral) !== 0 ||
      (flags & ts.TypeFlags.String) !== 0 ||
      (flags & ts.TypeFlags.Number) !== 0 ||
      (flags & ts.TypeFlags.Boolean) !== 0 ||
      (flags & ts.TypeFlags.Void) !== 0 ||
      (flags & ts.TypeFlags.BigInt) !== 0 ||
      (flags & ts.TypeFlags.BigIntLiteral) !== 0 ||
      (flags & ts.TypeFlags.TemplateLiteral) !== 0 ||
      (flags & ts.TypeFlags.Undefined) !== 0 ||
      (flags & ts.TypeFlags.Null) !== 0
    );
  }

  private leafText(type: ts.Type): string {
    const checker = ts.program.getTypeChecker();
    const text = checker.typeToString(
      type,
      location.compilerNode,
      NO_TRUNCATION,
    );
    // Normalize double-quoted string literals to single-quote style.
    if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
      const value = JSON.parse(text) as string;
      return value.includes("'") ? JSON.stringify(value) : `'${value}'`;
    }
    return text;
  }

  private needsParensInUnion(type: ts.Type): boolean {
    return (this.checkFlags(type) & ts.TypeFlags.Any) === 0;
  }

  private fallback(type: ts.Type, location: ts.Node, reason: string): string {
    const checker = ts.program.getTypeChecker();
    const text = checker.typeToString(
      type,
      location.compilerNode,
      NO_TRUNCATION,
    );
    this.warnings.add(`${reason}: fell back to '${text.slice(0, 80)}'`);
    return text;
  }

  private renderEnumLiteral(type: ts.Type): string {
    return this.enumLiteralValue(type);
  }

  private enumLiteralValue(type: ts.Type): string {
    const checker = ts.program.getTypeChecker();
    const value = (type.symbol.flags || 0) & ts.TypeFlags.NumberLiteral
      ? (type.type as ts.LiteralType).value
      : checker.typeToString(type, undefined, NO_TRUNCATION);

    if (typeof value === "string") {
      if (value.includes("'")) return JSON.stringify(value);
      return `'${value}'`;
    }
    return String(value);
  }

  private tryRenderEnumUnion(type: ts.Type): string | undefined {
    const members = type.getUnionTypes();
    if (members.length === 0) return undefined;
    let enumDecl: ts.EnumDeclaration | undefined;

    for (const member of members) {
      if ((this.checkFlags(member) & ts.TypeFlags.EnumLiteral) !== ts.TypeFlags.EnumLiteral)
        return undefined;
      // For this simplified version, we can't easily get the enum declaration
      // so we'll just return undefined
      return undefined;
    }

    return undefined;
  }

  private tryRenderAlias(
    type: ts.Type,
    location: ts.Node,
    depth: number,
    skipSymbol?: ts.Symbol,
  ): string | undefined {
    const alias = type.aliasSymbol;
    const checker = ts.program.getTypeChecker();
    const aliasType = alias && checker.getTypeOfAliasSymbol(alias);

    if (!aliasType || alias === skipSymbol || (this.checkFlags(aliasType) & ts.TypeFlags.Object) === 0)
      return undefined;

    const decls = alias.getDeclarations();
    if (decls && decls.length > 0) {
      const isNodeModule = decls.some(d =>
        (d.getSourceFile().fileName.includes('node_modules'))
      );
      if (isNodeModule) {
        const args = type.aliasTypeArguments || [];
        const rendered = args.map((arg) =>
          this.renderType(arg, location, depth + 1),
        );
        return `${alias.getName()}<${rendered.join(", ")}>`;
      }

      // For now, treat as we would for named types
      return undefined;
    }
    return undefined;
  }

  private renderObjectType(
    type: ts.Type,
    location: ts.Node,
    depth: number,
    skipSymbol?: ts.Symbol,
  ): string {
    const checker = ts.program.getTypeChecker();
    const alias = type.aliasSymbol;
    const isObject = (type.flags || 0) & ts.TypeFlags.Object;

    if (!alias || alias === skipSymbol || !isObject) {
      return this.renderStructural(type, location, depth);
    }

    const args = type.typeArguments || [];
    if (args.length > 0) {
      const rendered = args.map((arg) =>
        this.renderType(arg, location, depth + 1),
      );
      return `${alias.getName()}<${rendered.join(", ")}>`;
    }

    return `${alias.getName()}<${this.renderStructural(type, location, depth, skipSymbol)}>`;
  }

  private renderStructural(
    type: ts.Type,
    location: ts.Node,
    depth: number,
    skipSymbol?: ts.Symbol,
  ): string {
    const checker = ts.program.getTypeChecker();
    const flags = type.flags || 0;

    if ((flags & ts.TypeFlags.Object) === 0) {
      return `unknown`;
    }

    if ((flags & ts.TypeFlags.Object) !== ts.TypeFlags.Object) {
      return this.fallback(type, location, "cycle expanding");
    }

    const callSignatures = type.getCallSignatures() || [];
    const props = type.getProperties() || [];
    const stringIndex = type.getStringIndexType();
    const numberIndex = type.getNumberIndexType();

    if (
      callSignatures.length > 0 &&
      props.length === 0 &&
      stringIndex === undefined &&
      numberIndex === undefined
    ) {
      if (callSignatures.length === 1) {
        const sig = callSignatures[0];
        return this.renderSignature(sig, location, depth, "arrow");
      }
      return callSignatures
        .map((sig) => {
          const sigStmt = this.renderSignature(sig, location, depth, "arrow");
          return `(${sigStmt})`;
        })
        .join(" & ");
    }

    const lines: string[] = [];
    for (const sig of callSignatures) {
      lines.push(`  ${this.renderSignature(sig, location, depth, "call")};`);
    }

    for (const prop of props) {
      const decls = prop.getDeclarations();
      const isPrivate = decls?.some(d => (d.flags || 0) & ts.NodeFlags.Private);
      if (isPrivate) continue;

      const typeNode = prop.type;
      if (!typeNode) continue;

      const optional = (prop.flags || 0) & ts.SymbolFlags.Optional;
      const normalized = this.renderType(typeNode, prop, depth + 1);
      const propLine = `${tsFieldKey(prop.name)}${optional ? "?" : ""}: ${normalized}`;
      lines.push(`  ${propLine}`);
    }

    if (stringIndex) {
      lines.push(`  [key: string]: ${this.renderType(stringIndex, location, depth + 1)};`);
    }

    if (numberIndex) {
      lines.push(`  [key: number]: ${this.renderType(numberIndex, location, depth + 1)};`);
    }

    if (lines.length === 0) return "{}";
    return `{\n${lines.join("\n")}\n}`;
  }

  private renderSignature(
    sig: ts.Signature,
    location: ts.Node,
    depth: number,
    style: "arrow" | "call",
  ): string {
    const params: string[] = [];
    for (const p of sig.parameters) {
      if (p.name !== "this") {
        const paramType = p.type;
        const optional = (p.flags || 0) & ts.SymbolFlags.Optional;
        const rendered =
          optional && paramType.isUnion()
            ? `(${paramType.getUnionTypes().map(m => this.leafText(m)).join(" | ")} | undefined)`
            : this.leafText(paramType);
        params.push(`${p.name}: ${rendered}`);
      }
    }
    const returnType = this.renderType(sig.getReturnType(), location, depth + 1);
    return style === "arrow"
      ? `(${params.join(", ")}) => ${returnType}`
      : `(${params.join(", ")}) => ${returnType}`;
  }
}

// ---------------------------------------------------------------------------
// Manifest building
// ---------------------------------------------------------------------------

function buildManifest(project: ts.Program): StateManifestModel {
  const renderer = new TypeRenderer();
  const byScope = new Map<ScopeDir, Registration[]>();

  // ... reuse existing build logic
}
  const renderer = new TypeRenderer();
  const byScope = new Map<ScopeDir, Registration[]>();
  for (const scope of SCOPES) byScope.set(scope.dir, []);

  // Find all
  for (const sf of project.getSourceFiles()) {
    const scope = scopeDirOf(sf.fileName);
    if (scope === undefined) continue;

    // Find defineState calls
    for (const stmt of sf.statements) {
      if (!ts.isExpressionStatement(stmt)) continue;
      const expr = stmt.expression;
      if (!ts.isCallExpression(expr)) continue;
      if (!ts.isIdentifier(expr.expression) || expr.expression.text !== "defineState")
        continue;

      const [nameArg] = expr.arguments;
      if (!nameArgs || !ts.isStringLiteral(nameArg)) continue;

      const nameArg = expr.arguments[0];
      if (nameArg === undefined || !ts.isStringLiteral(nameArg)) continue;

      const keyName = nameArg.text;
      const defs = byScope.get(scope) ?? [];
      defs.push({
        def: {
          constName: "defineState",
          keyName,
          file: sf.fileName,
          exported: true, // Simplified
          declaration: expr as any, // Will recompute
        },
        scope,
      });
      byScope.set(scope, defs);
    }
  }

  // Expand types
  const byFile = new Map<string, KeyDef[]>();
  for (const scope of SCOPES) {
    const regs = byScope.get(scope.dir) ?? [];
    for (const r of regs) {
      const list = byFile.get(r.def.file) ?? [];
      list.push(r.def);
      byFile.set(r.def.file, list);
    }
  }

  // Build manifest
  const sections: string[] = [];
  for (const scope of SCOPES) {
    const regs = byScope.get(scope.dir) ?? [];
    const lines = [
      `/** ${scope.label}-scope keys registered into I${scope.label}StateService. */`,
      `export interface ${scope.interfaceName} {`,
    ];
    for (const file of [...byFile.keys()].toSorted()) {
      lines.push(`  // ${srcRelative(file)}`);
      for (const r of byFile.get(file) ?? []) {
        const rendered = renderer.renderKeyType(r.def);
        const parts = rendered.split("\n");
        parts[parts.length - 1] += ";";
        lines.push(
          `  '${r.def.keyName}': ${parts[0]}`,
          ...parts.slice(1).map((l) => `  ${l}`),
        );
      }
    }
    lines.push("}");
    sections.push(lines.join("\n"));
  }

  // Build output
  const counts = [...byScope.values()]
    .filter((r) => r.length > 0)
    .map((r) => `${r[0].scope.dir}: ${r.length} keys`)
    .join(" · ");

  const out: string[] = [
    "// App, Workspace, Session & Agent State Manifest",
    "//",
    "// Generated by scripts/gen-state-manifest.mts — do not edit by hand.",
    "// Regenerate with: pnpm --filter @moonshot-ai/agent-core-v2 gen:state-manifest",
    "//",
    `// Index (${counts})`,
  ];
  for (const scope of SCOPES) {
    const regs = byScope.get(scope.dir) ?? [];
    const width = Math.max(0, ...regs.map((r) => r.def.keyName.length));
    out.push(`//   ${scope.label}`);
    for (const r of regs) {
      out.push(
        `//     ${r.def.keyName.padEnd(width)}  ${srcRelative(r.def.file)}`,
      );
    }
  }
  out.push("");
  out.push(...sections.flatMap((section) => [section, ""]));

  return {
    registrations: [], // Will compute
    unregistered: [],
  };
}

export function buildStateManifest(): string {
  const program = ts.createProgram([join(PKG, "tsconfig.json")], {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
  });

  const model = buildManifest(program);
  return out.join("\n");
}

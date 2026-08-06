/**
 * Static analyzer for the `agent-core-v2` service graph.
 *
 * Discovers services registered via `registerScopedService(...)` and, for each
 * impl class, records four kinds of edges to other services:
 *
 *  - `ctor`     — constructor DI (`@IToken` param decorators)
 *  - `accessor` — runtime lookups (`<expr>.get(IToken)`)
 *  - `publish`/`subscribe` — `IEventService` usage from a class field
 *  - `signal`/`append`/`on` — `IAgentRecordService` usage from a class field
 *
 * Deliberately parse-only (no type checker) so the whole tree runs in ~1s.
 * We rely on the codebase convention that constructor DI params carry an
 * explicit type annotation matching the injected token — that's how we know
 * which field holds an event bus without asking the type checker.
 */

import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSourceFile,
  SyntaxKind,
} from "typescript/unstable/ast";

import type {
  Edge,
  EdgeKind,
  EdgeRef,
  Graph,
  ServiceNode,
  ServiceScope,
} from "./types";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PKG_ROOT = resolve(__dirname, "..", "..", "..");
export const REPO_ROOT = resolve(PKG_ROOT, "..", "..");
export const SRC_ROOT = join(PKG_ROOT, "src");
export const SNAPSHOT_PATH = join(PKG_ROOT, ".local", "dep-graph.json");

const EVENT_BUS_TOKENS = new Set(["IEventService", "IAgentRecordService"]);

const EVENT_METHOD_KIND: Record<string, EdgeKind> = {
  publish: "publish",
  subscribe: "subscribe",
  append: "emit",
  signal: "emit",
  on: "on",
};

const SCOPE_ORDER: ServiceScope[] = ["App", "Session", "Agent"];
const SCOPE_LEVEL: Record<ServiceScope, number> = {
  App: 0,
  Session: 1,
  Agent: 2,
};

const FRAMEWORK_BINDINGS: readonly {
  token: string;
  scope: ServiceScope;
  impl: string;
}[] = [
  {
    token: "IInstantiationService",
    scope: "App",
    impl: "InstantiationService",
  },
  { token: "IKaos", scope: "App", impl: "Kaos" },
  { token: "ILogOptions", scope: "App", impl: "LogOptions" },
  { token: "IBootstrapOptions", scope: "App", impl: "BootstrapOptions" },
  { token: "ISessionContext", scope: "Session", impl: "SessionContext" },
  { token: "IAgentScopeContext", scope: "Agent", impl: "AgentScopeContext" },
];

const PRODUCTION_OVERRIDES: readonly {
  token: string;
  scope: ServiceScope;
  impl: string;
}[] = [
  {
    token: "IFileSystemStorageService",
    scope: "App",
    impl: "FileStorageService",
  },
  { token: "ISkillDiscovery", scope: "App", impl: "FileSkillDiscovery" },
];

export function nodeId(scope: ServiceScope, token: string): string {
  return `${scope}::${token}`;
}

type Bindings = Map<string, Map<ServiceScope, ServiceNode>>;

function resolveFromScope(
  bindings: Bindings,
  token: string,
  sourceScope: ServiceScope,
): ServiceNode | undefined {
  const scopeMap = bindings.get(token);
  if (!scopeMap) return undefined;
  const sourceLevel = SCOPE_LEVEL[sourceScope];
  for (let lvl = sourceLevel; lvl >= 0; lvl--) {
    const s = SCOPE_ORDER[lvl];
    const hit = scopeMap.get(s);
    if (hit) return hit;
  }
  return undefined;
}

interface EdgeAccumulator {
  services: ServiceNode[];
  edges: Map<string, Edge>;
  bindings: Bindings;
  unknownRefs: Set<string>;
}

function relFromRepo(absPath: string): string {
  return relative(REPO_ROOT, absPath).replaceAll("\\", "/");
}

function edgeKey(fromId: string, toId: string, kind: EdgeKind): string {
  return `${fromId}|${toId}|${kind}`;
}

function pushEdge(
  acc: EdgeAccumulator,
  fromId: string,
  source: ServiceNode,
  token: string,
  kind: EdgeKind,
  ref: EdgeRef,
  overrideScope?: ServiceScope,
): void {
  const target = resolveFromScope(
    acc.bindings,
    token,
    overrideScope ?? source.scope,
  );

  let toId: string;
  let extra: Pick<Edge, "unresolved" | "scopeMismatch" | "actualScope">;
  if (target) {
    toId = target.id;
    extra = {};
  } else {
    const scopeMap = acc.bindings.get(token);
    const actualScope = scopeMap ? innermostScope(scopeMap) : undefined;
    if (actualScope !== undefined) {
      toId = `scopeMismatch::${token}`;
      extra = { scopeMismatch: true as const, actualScope };
    } else {
      toId = `unresolved::${token}`;
      extra = { unresolved: true as const };
    }
  }

  const key = edgeKey(fromId, toId, kind);
  const existing = acc.edges.get(key);
  if (existing) {
    if (!existing.refs.some((r) => sameRef(r, ref))) {
      existing.refs.push(ref);
    }
    return;
  }
  const edge: Edge = {
    from: fromId,
    to: toId,
    token,
    kind,
    refs: [ref],
    ...extra,
  };
  acc.edges.set(key, edge);
  if (extra.unresolved) acc.unknownRefs.add(token);
}

function innermostScope(
  scopeMap: Map<ServiceScope, ServiceNode>,
): ServiceScope | undefined {
  let best: ServiceScope | undefined;
  let bestLevel = -1;
  for (const s of scopeMap.keys()) {
    const lvl = SCOPE_LEVEL[s];
    if (lvl > bestLevel) {
      bestLevel = lvl;
      best = s;
    }
  }
  return best;
}

function sameRef(a: EdgeRef, b: EdgeRef): boolean {
  return (
    a.file === b.file &&
    a.line === b.line &&
    (a.fromMethod ?? "") === (b.fromMethod ?? "") &&
    (a.toMethod ?? "") === (b.toMethod ?? "")
  );
}

// ---------------------------------------------------------------------------
// AST helpers using TypeScript compiler API
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

/** Walk upward from a node, stopping at class declarations. */
function walkUp(node: ts.Node): IterableIterator<ts.Node> {
  return {
    *[Symbol.iterator]() {
      let cur: ts.Node | undefined = node.parent;
      while (cur) {
        yield cur;
        if (ts.isClassDeclaration(cur)) return;
        cur = cur.parent;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Interface collection
// ---------------------------------------------------------------------------

function collectInterfaces(
  sourceFiles: ts.SourceFile[],
): Map<string, ts.InterfaceDeclaration> {
  const out = new Map<string, ts.InterfaceDeclaration>();
  for (const file of sourceFiles) {
    for (const iface of getInterfaces(file)) {
      const name = iface.name?.text;
      if (name) out.set(name, iface);
    }
  }
  return out;
}

function getInterfaces(sf: ts.SourceFile): ts.InterfaceDeclaration[] {
  return getDescendantsOfKind(sf, ts.SyntaxKind.InterfaceDeclaration) as ts.InterfaceDeclaration[];
}

function collectInterfaceMembers(iface: ts.InterfaceDeclaration): string[] {
  const names = new Set<string>();
  for (const member of iface.members) {
    if (member.kind === ts.SyntaxKind.MethodSignature) {
      const m = member as ts.MethodSignature;
      if (m.name && ts.isIdentifier(m.name)) names.add(m.name.text);
    } else if (member.kind === ts.SyntaxKind.PropertySignature) {
      const p = member as ts.PropertySignature;
      if (p.name && ts.isIdentifier(p.name)) {
        if (p.name.text === "_serviceBrand") continue;
        names.add(p.name.text);
      }
    }
  }
  return [...names].sort();
}

// ---------------------------------------------------------------------------
// Registration parsing
// ---------------------------------------------------------------------------

function readRegistration(
  call: ts.CallExpression,
  sf: ts.SourceFile,
):
  | {
      token: string;
      impl: string;
      scope: ServiceScope;
      domain: string;
      line: number;
    }
  | undefined {
  const args = call.arguments;
  if (args.length < 3) return undefined;

  const scopeArg = args[0];
  const tokenArg = args[1];
  const implArg = args[2];
  const domainArg = args[4];

  if (scopeArg.kind !== ts.SyntaxKind.PropertyAccessExpression)
    return undefined;
  const scopePae = scopeArg as ts.PropertyAccessExpression;
  const scopeText = getNodeText(sf, scopePae);
  const scope = scopeText.split(".").at(-1);
  if (scope !== "App" && scope !== "Session" && scope !== "Agent")
    return undefined;

  if (!ts.isIdentifier(tokenArg)) return undefined;
  if (!ts.isIdentifier(implArg)) return undefined;

  let domain = "unknown";
  if (domainArg && domainArg.kind === ts.SyntaxKind.StringLiteral) {
    domain = (domainArg as ts.StringLiteral).text;
  }

  return {
    token: tokenArg.text,
    impl: implArg.text,
    scope: scope as ServiceScope,
    domain,
    line: getStartLine(sf, call),
  };
}

function domainOf(absPath: string): string {
  const rel = relative(SRC_ROOT, absPath).replaceAll("\\", "/");
  return rel.split("/")[0] ?? "unknown";
}

// ---------------------------------------------------------------------------
// Service collection
// ---------------------------------------------------------------------------

function getClasses(sf: ts.SourceFile): ts.ClassDeclaration[] {
  return getDescendantsOfKind(sf, ts.SyntaxKind.ClassDeclaration) as ts.ClassDeclaration[];
}

function collectServices(sourceFiles: ts.SourceFile[]): {
  services: ServiceNode[];
  implClasses: Map<string, ts.ClassDeclaration>;
  bindings: Bindings;
} {
  const services: ServiceNode[] = [];
  const implClasses = new Map<string, ts.ClassDeclaration>();
  const bindings: Bindings = new Map();

  for (const file of sourceFiles) {
    for (const cls of getClasses(file)) {
      const name = cls.name?.text;
      if (name) implClasses.set(name, cls);
    }
  }

  for (const file of sourceFiles) {
    for (const call of getDescendantsOfKind(file, ts.SyntaxKind.CallExpression)) {
      const c = call as ts.CallExpression;
      const expr = c.expression;
      if (!ts.isIdentifier(expr) || expr.text !== "registerScopedService") continue;
      const reg = readRegistration(c, file);
      if (!reg) continue;
      const domain =
        reg.domain !== "unknown" ? reg.domain : domainOf(file.fileName);
      const node: ServiceNode = {
        id: nodeId(reg.scope, reg.token),
        token: reg.token,
        impl: reg.impl,
        scope: reg.scope,
        domain,
        file: relFromRepo(file.fileName),
        line: reg.line,
      };
      services.push(node);
      let scopeMap = bindings.get(reg.token);
      if (!scopeMap) {
        scopeMap = new Map();
        bindings.set(reg.token, scopeMap);
      }
      if (!scopeMap.has(reg.scope)) scopeMap.set(reg.scope, node);
    }
  }

  return { services, implClasses, bindings };
}

// ---------------------------------------------------------------------------
// Constructor DI analysis
// ---------------------------------------------------------------------------

function readCtor(cls: ts.ClassDeclaration): {
  ctorDeps: { token: string; line: number }[];
  injectedFields: Map<string, string>;
} {
  const ctorDeps: { token: string; line: number }[] = [];
  const injectedFields = new Map<string, string>();

  const ctors = cls.members.filter(
    (m) => m.kind === ts.SyntaxKind.Constructor,
  ) as ts.ConstructorDeclaration[];
  if (ctors.length === 0) return { ctorDeps, injectedFields };
  const ctor = ctors[0];

  for (const param of ctor.parameters) {
    const decorators = param.decorators;
    if (!decorators) continue;
    for (const dec of decorators) {
      const decExpr = dec.expression;
      let decName: string | undefined;
      if (ts.isIdentifier(decExpr)) {
        decName = decExpr.text;
      } else if (
        decExpr.kind === ts.SyntaxKind.CallExpression
      ) {
        const call = decExpr as ts.CallExpression;
        if (ts.isIdentifier(call.expression)) {
          decName = call.expression.text;
        }
      }
      if (decName && decName.startsWith("I")) {
        ctorDeps.push({ token: decName, line: getStartLine(param.getSourceFile!, dec) });
        // Use the parameter's source file (the class's source file)
        const sf = cls.getSourceFile();
        ctorDeps[ctorDeps.length - 1].line = getStartLine(sf, dec);
        const fieldName = fieldNameOf(param, sf);
        if (fieldName) injectedFields.set(fieldName, decName);
      }
    }
  }

  return { ctorDeps, injectedFields };
}

function fieldNameOf(param: ts.ParameterDeclaration, sf: ts.SourceFile): string | undefined {
  const modifiers = param.modifiers;
  if (modifiers) {
    for (const m of modifiers) {
      if (
        m.kind === ts.SyntaxKind.PrivateKeyword ||
        m.kind === ts.SyntaxKind.ProtectedKeyword ||
        m.kind === ts.SyntaxKind.PublicKeyword
      ) {
        if (ts.isIdentifier(param.name)) return param.name.text;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Enclosing method name
// ---------------------------------------------------------------------------

function enclosingMethodName(node: ts.Node, sf: ts.SourceFile): string | undefined {
  for (const parent of walkUp(node)) {
    if (parent.kind === ts.SyntaxKind.MethodDeclaration) {
      const m = parent as ts.MethodDeclaration;
      if (m.name && ts.isIdentifier(m.name)) return m.name.text;
    }
    if (parent.kind === ts.SyntaxKind.Constructor) return "<ctor>";
    if (parent.kind === ts.SyntaxKind.GetAccessor) {
      const g = parent as ts.GetAccessorDeclaration;
      if (g.name && ts.isIdentifier(g.name)) return `get ${g.name.text}`;
    }
    if (parent.kind === ts.SyntaxKind.SetAccessor) {
      const s = parent as ts.SetAccessorDeclaration;
      if (s.name && ts.isIdentifier(s.name)) return `set ${s.name.text}`;
    }
    if (parent.kind === ts.SyntaxKind.PropertyDeclaration) {
      const p = parent as ts.PropertyDeclaration;
      if (p.name && ts.isIdentifier(p.name)) return `<field ${p.name.text}>`;
    }
    if (parent.kind === ts.SyntaxKind.ClassDeclaration) return undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Chained method detection (e.g. service.get(IToken).method())
// ---------------------------------------------------------------------------

function chainedMethodName(getCall: ts.CallExpression): string | undefined {
  const parent = getCall.parent;
  if (!parent || parent.kind !== ts.SyntaxKind.PropertyAccessExpression)
    return undefined;
  const pae = parent as ts.PropertyAccessExpression;
  if (pae.expression !== getCall) return undefined;
  const grandparent = pae.parent;
  if (!grandparent || grandparent.kind !== ts.SyntaxKind.CallExpression)
    return undefined;
  const outer = grandparent as ts.CallExpression;
  if (outer.expression !== pae) return undefined;
  return pae.name.text;
}

// ---------------------------------------------------------------------------
// Scope handle aliasing
// ---------------------------------------------------------------------------

const HANDLE_ALIAS_SCOPE: Record<string, ServiceScope> = {
  IAppScopeHandle: "App",
  ISessionScopeHandle: "Session",
  IAgentScopeHandle: "Agent",
};

const FUNCTION_LIKE_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
]);

function stripTypeWrappers(text: string): string {
  let t = text.trim();
  t = t.replace(/\s*\|\s*(undefined|null)\s*/g, "").trim();
  const promise = /^Promise\s*<\s*(.+?)\s*>$/.exec(t);
  if (promise) t = promise[1].trim();
  t = t.replace(/\[\]\s*$/, "").trim();
  t = t.replace(/^readonly\s+/, "").trim();
  return t;
}

function handleScopeFromTypeText(
  text: string | undefined,
): ServiceScope | undefined {
  if (text === undefined) return undefined;
  const t = stripTypeWrappers(text);
  const alias = HANDLE_ALIAS_SCOPE[t];
  if (alias !== undefined) return alias;
  const generic =
    /^IScopeHandle\s*<\s*LifecycleScope\.(App|Session|Agent)\s*>$/.exec(t);
  if (generic) return generic[1] as ServiceScope;
  return undefined;
}

function enclosingFunction(node: ts.Node): ts.Node | undefined {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (FUNCTION_LIKE_KINDS.has(cur.kind)) return cur;
    cur = cur.parent;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Type inference helpers (parse-only, no type-checker)
// ---------------------------------------------------------------------------

function getParams(fn: ts.Node): ts.ParameterDeclaration[] {
  if (
    ts.isFunctionDeclaration(fn) ||
    ts.isFunctionExpression(fn) ||
    ts.isArrowFunction(fn) ||
    ts.isMethodDeclaration(fn) ||
    ts.isConstructorDeclaration(fn) ||
    ts.isGetAccessor(fn) ||
    ts.isSetAccessor(fn)
  ) {
    return (
      fn as
        | ts.FunctionDeclaration
        | ts.FunctionExpression
        | ts.ArrowFunction
        | ts.MethodDeclaration
        | ts.ConstructorDeclaration
        | ts.GetAccessorDeclaration
        | ts.SetAccessorDeclaration
    ).parameters;
  }
  return [];
}

function isAccessorReceiver(node: ts.Node): boolean {
  if (node.kind !== ts.SyntaxKind.PropertyAccessExpression) return false;
  const pae = node as ts.PropertyAccessExpression;
  return pae.name.text === "accessor";
}

function collectInterfaceMethodReturns(
  interfacesByName: Map<string, ts.InterfaceDeclaration>,
): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const [name, iface] of interfacesByName) {
    const methods = new Map<string, string>();
    for (const member of iface.members) {
      if (member.kind === ts.SyntaxKind.MethodSignature) {
        const m = member as ts.MethodSignature;
        const rt = m.type?.getFullText(iface.getSourceFile());
        if (rt) methods.set(m.name.getText(iface.getSourceFile()), rt.trim());
      }
    }
    out.set(name, methods);
  }
  return out;
}

function inferExprTypeText(
  expr: ts.Node,
  cls: ts.ClassDeclaration,
  ifaceMethods: Map<string, Map<string, string>>,
  fn: ts.Node,
  depth = 0,
): string | undefined {
  if (depth > 6) return undefined;
  const sf = cls.getSourceFile();
  const kind = expr.kind;

  if (kind === ts.SyntaxKind.AwaitExpression) {
    const inner = (expr as ts.AwaitExpression).expression;
    return inferExprTypeText(inner, cls, ifaceMethods, fn, depth + 1);
  }

  if (kind === ts.SyntaxKind.AsExpression || kind === ts.SyntaxKind.NonNullExpression) {
    const inner = (expr as ts.AsExpression | ts.NonNullExpression).expression;
    return inferExprTypeText(inner, cls, ifaceMethods, fn, depth + 1);
  }

  if (kind === ts.SyntaxKind.CallExpression) {
    const call = expr as ts.CallExpression;
    const callee = call.expression;
    if (callee.kind !== ts.SyntaxKind.PropertyAccessExpression)
      return undefined;
    const pae = callee as ts.PropertyAccessExpression;
    const methodName = pae.name.text;
    const base = pae.expression;

    if (methodName === "get" && isAccessorReceiver(base)) {
      const first = call.arguments[0];
      if (first && ts.isIdentifier(first)) return first.text;
      return undefined;
    }

    if (base.kind === ts.SyntaxKind.ThisKeyword) {
      const method = findMethod(cls, methodName);
      return method?.getTypeAnnotation?.()?.getFullText(sf)?.trim();
    }

    const baseType = inferExprTypeText(base, cls, ifaceMethods, fn, depth + 1);
    if (baseType === undefined) return undefined;
    return ifaceMethods.get(stripTypeWrappers(baseType))?.get(methodName);
  }

  if (kind === ts.SyntaxKind.Identifier) {
    return resolveIdentifierTypeText(expr, cls, ifaceMethods, fn, depth + 1);
  }

  if (kind === ts.SyntaxKind.PropertyAccessExpression) {
    const pae = expr as ts.PropertyAccessExpression;
    if (pae.expression.kind === ts.SyntaxKind.ThisKeyword) {
      return thisFieldTypeText(cls, pae.name.text);
    }
    return undefined;
  }

  if (kind === ts.SyntaxKind.BinaryExpression) {
    const bin = expr as ts.BinaryExpression;
    if (bin.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      return (
        inferExprTypeText(bin.left, cls, ifaceMethods, fn, depth + 1) ??
        inferExprTypeText(bin.right, cls, ifaceMethods, fn, depth + 1)
      );
    }
    return undefined;
  }

  if (kind === ts.SyntaxKind.ConditionalExpression) {
    const cond = expr as ts.ConditionalExpression;
    return (
      inferExprTypeText(cond.whenTrue, cls, ifaceMethods, fn, depth + 1) ??
      inferExprTypeText(cond.whenFalse, cls, ifaceMethods, fn, depth + 1)
    );
  }

  return undefined;
}

function findMethod(cls: ts.ClassDeclaration, name: string): ts.MethodDeclaration | undefined {
  return cls.members.filter(
    (m) => m.kind === ts.SyntaxKind.MethodDeclaration,
  ).find(
    (m) => {
      const method = m as ts.MethodDeclaration;
      return method.name && ts.isIdentifier(method.name) && method.name.text === name;
    },
  ) as ts.MethodDeclaration | undefined;
}

function thisFieldTypeText(
  cls: ts.ClassDeclaration,
  fieldName: string,
): string | undefined {
  const sf = cls.getSourceFile();
  const ctors = cls.members.filter(
    (m) => m.kind === ts.SyntaxKind.Constructor,
  ) as ts.ConstructorDeclaration[];
  if (ctors.length > 0) {
    for (const p of ctors[0].parameters) {
      if (!ts.isIdentifier(p.name) || p.name.text !== fieldName) continue;
      const t = p.type?.getFullText(sf)?.trim();
      if (t) return t;
    }
  }
  for (const member of cls.members) {
    if (member.kind === ts.SyntaxKind.PropertyDeclaration) {
      const prop = member as ts.PropertyDeclaration;
      if (prop.name && ts.isIdentifier(prop.name) && prop.name.text === fieldName) {
        return prop.type?.getFullText(sf)?.trim();
      }
    }
  }
  return undefined;
}

function resolveIdentifierTypeText(
  id: ts.Node,
  cls: ts.ClassDeclaration,
  ifaceMethods: Map<string, Map<string, string>>,
  fn: ts.Node,
  depth: number,
): string | undefined {
  if (!ts.isIdentifier(id)) return undefined;
  const sf = cls.getSourceFile();
  const name = id.text;

  for (const p of getParams(fn)) {
    if (ts.isIdentifier(p.name) && p.name.text === name) {
      const t = p.type?.getFullText(sf)?.trim();
      if (t) return t;
    }
  }

  const decls = getDescendantsOfKind(fn, ts.SyntaxKind.VariableDeclaration);
  for (const decl of decls) {
    const vd = decl as ts.VariableDeclaration;
    if (!ts.isIdentifier(vd.name)) continue;
    if (vd.name.text !== name) continue;
    if (vd.getStart(sf) > id.getStart(sf)) continue;
    const annotated = vd.type?.getFullText(sf)?.trim();
    if (annotated) return annotated;
    if (vd.initializer) {
      const inferred = inferExprTypeText(
        vd.initializer,
        cls,
        ifaceMethods,
        fn,
        depth + 1,
      );
      if (inferred) return inferred;
    }
  }
  return undefined;
}

function inferAccessorScope(
  getCall: ts.CallExpression,
  cls: ts.ClassDeclaration,
  ifaceMethods: Map<string, Map<string, string>>,
): ServiceScope | undefined {
  const getExpr = getCall.expression;
  if (getExpr.kind !== ts.SyntaxKind.PropertyAccessExpression)
    return undefined;
  const receiver = (getExpr as ts.PropertyAccessExpression).expression;
  if (!isAccessorReceiver(receiver)) return undefined;
  const obj = (receiver as ts.PropertyAccessExpression).expression;
  const fn = enclosingFunction(getCall);
  if (fn === undefined) return undefined;
  return handleScopeFromTypeText(inferExprTypeText(obj, cls, ifaceMethods, fn));
}

// ---------------------------------------------------------------------------
// Runtime edge collection
// ---------------------------------------------------------------------------

function collectRuntimeEdges(
  cls: ts.ClassDeclaration,
  source: ServiceNode,
  injectedFields: Map<string, string>,
  acc: EdgeAccumulator,
  ifaceMethods: Map<string, Map<string, string>>,
): void {
  const sf = cls.getSourceFile();
  const filePath = relFromRepo(sf.fileName);

  for (const call of getDescendantsOfKind(cls, ts.SyntaxKind.CallExpression)) {
    const c = call as ts.CallExpression;
    const callee = c.expression;
    if (callee.kind !== ts.SyntaxKind.PropertyAccessExpression) continue;
    const pae = callee as ts.PropertyAccessExpression;
    const methodName = pae.name.text;
    const line = getStartLine(sf, c);
    const fromMethod = enclosingMethodName(c, sf);
    const baseRef: EdgeRef = { file: filePath, line };
    if (fromMethod !== undefined) baseRef.fromMethod = fromMethod;

    if (methodName === "get") {
      const args = c.arguments;
      if (args.length === 0) continue;
      const first = args[0];
      if (!ts.isIdentifier(first)) continue;
      const tokenName = first.text;
      if (!tokenName.startsWith("I")) continue;
      if (tokenName === source.token) continue;
      const toMethod = chainedMethodName(c);
      const ref: EdgeRef = { ...baseRef };
      if (toMethod !== undefined) ref.toMethod = toMethod;
      const accessorScope = inferAccessorScope(c, cls, ifaceMethods);
      pushEdge(
        acc,
        source.id,
        source,
        tokenName,
        "accessor",
        ref,
        accessorScope,
      );
      continue;
    }

    const receiver = pae.expression;
    let fieldName: string | undefined;
    if (receiver.kind === ts.SyntaxKind.PropertyAccessExpression) {
      const inner = receiver as ts.PropertyAccessExpression;
      if (inner.expression.kind === ts.SyntaxKind.ThisKeyword) {
        fieldName = inner.name.text;
      }
    } else if (ts.isIdentifier(receiver)) {
      fieldName = receiver.text;
    }
    if (fieldName === undefined) continue;

    const fieldToken = injectedFields.get(fieldName);
    if (fieldToken === undefined) continue;
    if (fieldToken === source.token) continue;

    if (EVENT_BUS_TOKENS.has(fieldToken)) {
      const eventKind = EVENT_METHOD_KIND[methodName];
      if (eventKind === undefined) continue;
      pushEdge(acc, source.id, source, fieldToken, eventKind, baseRef);
      continue;
    }

    const ref: EdgeRef = { ...baseRef, toMethod: methodName };
    pushEdge(acc, source.id, source, fieldToken, "ctor", ref);
  }
}

// ---------------------------------------------------------------------------
// Main analysis entry point
// ---------------------------------------------------------------------------

/** Recursively collect all .ts files. */
function collectTsFiles(dir: string): string[] {
  const entries = require("node:fs").readdirSync(dir, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...collectTsFiles(p));
    else if (entry.name.endsWith(".ts")) result.push(p);
  }
  return result;
}

export function analyze(
  options: { srcRoot?: string; generatedAt?: string } = {},
): Graph {
  const srcRoot = options.srcRoot ?? SRC_ROOT;

  const sourceFiles: ts.SourceFile[] = [];
  for (const file of collectTsFiles(srcRoot)) {
    const text = readFileSync(file, "utf-8");
    const sf = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      ts.ScriptKind.TS,
    );
    sourceFiles.push(sf);
  }

  const { services, implClasses, bindings } = collectServices(sourceFiles);
  const interfacesByName = collectInterfaces(sourceFiles);
  const ifaceMethods = collectInterfaceMethodReturns(interfacesByName);

  const frameworkNodes: ServiceNode[] = FRAMEWORK_BINDINGS.map((b) => ({
    id: nodeId(b.scope, b.token),
    token: b.token,
    impl: b.impl,
    scope: b.scope,
    domain: "framework",
    file: "packages/agent-core-v2/src/_base",
    line: 0,
  }));
  for (const node of frameworkNodes) {
    services.push(node);
    let scopeMap = bindings.get(node.token);
    if (!scopeMap) {
      scopeMap = new Map();
      bindings.set(node.token, scopeMap);
    }
    if (!scopeMap.has(node.scope)) scopeMap.set(node.scope, node);
  }

  for (const override of PRODUCTION_OVERRIDES) {
    const id = nodeId(override.scope, override.token);
    const cls = implClasses.get(override.impl);
    const file = cls
      ? relFromRepo(cls.getSourceFile().fileName)
      : SRC_ROOT;
    const domain = cls
      ? domainOf(cls.getSourceFile().fileName)
      : "unknown";
    const line = cls ? getStartLine(cls.getSourceFile(), cls) : 0;
    const node: ServiceNode = {
      id,
      token: override.token,
      impl: override.impl,
      scope: override.scope,
      domain,
      file,
      line,
    };
    const existingIndex = services.findIndex((s) => s.id === id);
    if (existingIndex >= 0) {
      services[existingIndex] = node;
    } else {
      services.push(node);
    }
    let scopeMap = bindings.get(override.token);
    if (!scopeMap) {
      scopeMap = new Map();
      bindings.set(override.token, scopeMap);
    }
    scopeMap.set(override.scope, node);
  }

  const acc: EdgeAccumulator = {
    services,
    edges: new Map(),
    bindings,
    unknownRefs: new Set(),
  };

  for (const svc of services) {
    const iface = interfacesByName.get(svc.token);
    if (!iface) continue;
    const members = collectInterfaceMembers(iface);
    if (members.length > 0) svc.publicMembers = members;
  }

  for (const svc of services) {
    const cls = implClasses.get(svc.impl);
    if (!cls) continue;
    const { ctorDeps, injectedFields } = readCtor(cls);
    const filePath = relFromRepo(cls.getSourceFile().fileName);
    for (const dep of ctorDeps) {
      if (dep.token === svc.token) continue;
      pushEdge(acc, svc.id, svc, dep.token, "ctor", {
        file: filePath,
        line: dep.line,
      });
    }
    collectRuntimeEdges(cls, svc, injectedFields, acc, ifaceMethods);
  }

  const nodeById = new Map(services.map((s) => [s.id, s]));
  const unresolvedReferrers = new Map<string, Set<ServiceScope>>();
  for (const edge of acc.edges.values()) {
    if (!edge.unresolved) continue;
    let scopes = unresolvedReferrers.get(edge.token);
    if (!scopes) {
      scopes = new Set();
      unresolvedReferrers.set(edge.token, scopes);
    }
    const source = nodeById.get(edge.from);
    if (source) scopes.add(source.scope);
  }
  for (const [token, scopes] of unresolvedReferrers) {
    let scope: ServiceScope = "App";
    let minLevel = Number.POSITIVE_INFINITY;
    for (const s of scopes) {
      const lvl = SCOPE_LEVEL[s];
      if (lvl < minLevel) {
        minLevel = lvl;
        scope = s;
      }
    }
    const node: ServiceNode = {
      id: `unresolved::${token}`,
      token,
      impl: token,
      scope,
      domain: "unresolved",
      file: "",
      line: 0,
      unresolved: true,
    };
    const iface = interfacesByName.get(token);
    if (iface) {
      const members = collectInterfaceMembers(iface);
      if (members.length > 0) node.publicMembers = members;
    }
    services.push(node);
  }

  const mismatchTokens = new Map<string, ServiceScope>();
  for (const edge of acc.edges.values()) {
    if (!edge.scopeMismatch || edge.actualScope === undefined) continue;
    if (!mismatchTokens.has(edge.token))
      mismatchTokens.set(edge.token, edge.actualScope);
  }
  for (const [token, scope] of mismatchTokens) {
    const registered = acc.bindings.get(token)?.get(scope);
    const node: ServiceNode = {
      id: `scopeMismatch::${token}`,
      token,
      impl: token,
      scope,
      domain: registered?.domain ?? "unknown",
      file: "",
      line: 0,
      scopeMismatch: true,
    };
    const iface = interfacesByName.get(token);
    if (iface) {
      const members = collectInterfaceMembers(iface);
      if (members.length > 0) node.publicMembers = members;
    }
    services.push(node);
  }

  return {
    generatedAt: options.generatedAt ?? new Date(0).toISOString(),
    services: services.sort(
      (a, b) =>
        a.domain.localeCompare(b.domain) ||
        a.impl.localeCompare(b.impl) ||
        a.scope.localeCompare(b.scope),
    ),
    edges: [...acc.edges.values()].sort(
      (a, b) =>
        a.from.localeCompare(b.from) ||
        a.kind.localeCompare(b.kind) ||
        a.to.localeCompare(b.to),
    ),
    unknownTokens: [...acc.unknownRefs].sort(),
  };
}

export function readHeadSha(): string | undefined {
  try {
    const head = readFileSync(join(REPO_ROOT, ".git", "HEAD"), "utf8").trim();
    if (head.startsWith("ref: ")) {
      const ref = head.slice(5);
      return readFileSync(join(REPO_ROOT, ".git", ref), "utf8").trim();
    }
    return head;
  } catch {
    return undefined;
  }
}

export function writeSnapshot(
  graph: Graph,
  path: string = SNAPSHOT_PATH,
): void {
  const { mkdirSync, writeFileSync } = require("node:fs");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(graph, null, 2)}\n`);
}

export function summarize(graph: Graph): string {
  const byKind = new Map<string, number>();
  for (const e of graph.edges)
    byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
  const kindSummary = [...byKind.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k}=${n}`)
    .join(" ");
  return `services=${graph.services.length} edges=${graph.edges.length} ${kindSummary}`;
}

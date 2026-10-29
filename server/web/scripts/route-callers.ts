/**
 * Which handlers of a route file read the caller the HTTP pipeline answers,
 * and which kind: the gate's step that runs a guard's
 * answer once, from the request's ROUTE_POLICY row, before the handler,
 * and refuses with it (lib/auth/session.ts answerRouteCaller). A handler
 * reads it with a reader instead of calling a session guard: ownerCaller()
 * (and its two projections) for the owner guard, memberCaller() for the
 * member guard, anyLoginCaller() for the any-login guard, chatCaller()
 * for the chat guard (the one list, eslint-rules/session-guards.mjs
 * READER_ANSWERS).
 *
 * The route manifest generator (gen-route-manifest.ts) asks this of every
 * route file, and the manifest carries the answer (`reads`, each method to
 * its caller kind); the route's ROUTE_POLICY rows say so (`caller`), and
 * the gate answers only those rows, with that kind's guard. A handler that
 * reads the callers of two kinds is refused. A handler that reads with no answer on its row would
 * throw; a row answered for a handler that also runs a guard would run the
 * guard's effects twice. So the answer is read from the code itself, with
 * the TypeScript parser, never kept by hand. It goes by bindings, not by
 * names, and a file it cannot answer for is refused (the generator fails,
 * at build and before every test run):
 *
 *  - the reader imported under another name, from another module, or not
 *    imported; read off an object (`auth.ownerCaller()`,
 *    `x['ownerCaller']()`); or named other than in a plain call
 *    (`const f = ownerCaller`, `ownerCaller.call()`, `ownerCaller?.()`, a
 *    local of that name);
 *  - a reader called outside an exported handler (a helper of the file):
 *    which methods read it is not plain;
 *  - a handler that reads and is not a plain function (`withX(async () =>
 *    ...)`, `C.GET`), is declared with let or var, or is a default export;
 *  - a handler that runs code before it reads (the gate answers before the
 *    handler, so whatever the handler answered before its guard would come
 *    after the gate's refusal), a parameter's default value included, but
 *    for a kind answered at the read (KINDS_AT_READ), and
 *    a handler that wraps a reading handler (another route file's, or one
 *    of its own file: POST's `return GET(req)`, which reads as GET does)
 *    with code before the call (the /api/v1 files: a key's 404 before the
 *    page's guard), unless the handler is marked
 *    `// route-callers: hand case` once its order was checked by hand;
 *  - a reading handler, of another route file or of this one, passed
 *    around other than called or re-exported, or called outside an
 *    exported handler; a route file that reads imported whole or
 *    re-exported with `*`;
 *  - in a file that reads: a handler that reads and also calls a session
 *    guard; a guard imported under another name; a guard called outside
 *    an exported handler (a helper, a wrapper) or named other than in a
 *    call.
 *
 * A helper of lib that would read the caller cannot: only a route file
 * under app/api imports ownerCaller, by its own name (ESLint,
 * eslint-rules/owner-caller-imports.mjs).
 *
 * Once no route file calls a session guard itself, every row is answered
 * and this module can go.
 */
import { posix } from 'node:path';
import ts from 'typescript';
import { errorMessage } from '@mantle/std';
import {
  CALLER_READERS,
  READER_ANSWERS,
  SESSION_GUARDS,
} from '../../../eslint-rules/session-guards.mjs';
import type { RouteCaller } from '../lib/auth/route-policy';
import { GONE_KINDS, isGoneGuard, type GoneGuard } from '../lib/gone-kinds';
import {
  ROUTE_SWITCH_NAMES,
  ROUTE_SWITCHES_EXPORT,
  isRouteSwitch,
  type RouteSwitch,
} from '../lib/auth/route-switches';
import {
  DECLARED_METHODS,
  ROUTE_DECLARATION_MODULE,
  ROUTE_POLICY_EXPORT,
  validateRoutePolicy,
  type RoutePolicyDeclaration,
} from '../lib/auth/route-declaration';

/** The readers and the session guards: the one list
 *  (eslint-rules/session-guards.mjs). */
export { CALLER_READERS, SESSION_GUARDS };

/** Each method whose handler reads the caller the pipeline answers, to the
 *  caller kind its reader reads. */
export type HandlerCallers = Readonly<Record<string, RouteCaller>>;

/** The modules a reader is imported from (lib/auth.ts re-exports
 *  lib/auth/session.ts). */
export const READER_MODULES: readonly string[] = ['@/lib/auth', '@/lib/auth/session'];

/**
 * A retired route's 410 stub: `export const GET =
 * gone('owner', ...)`, `gone` imported from GONE_MODULE. Its handler reads
 * the caller of the stub's kind (lib/gone.ts reads it, then answers 410),
 * so the method reads that kind and its row is a gone row: the gate
 * answers the stub's guard, as for any reading handler. Each kind to the
 * caller the gate answers: the one table (lib/gone-kinds.ts GONE_KINDS),
 * held here to the reader each kind reads (READER_ANSWERS).
 */
export const GONE_MODULE = '@/lib/gone';

/** Whether `spec`, imported by the route file `file` (its path from
 *  server/web), names the gone module (lib/gone.ts) in any spelling: the
 *  alias with an extension or an index, or a relative path to it. */
function isGoneModule(spec: string, file: string): boolean {
  const plain = (p: string) => p.replace(/\.(?:[cm]?[jt]sx?)$/, '').replace(/\/index$/, '');
  if (spec.startsWith('.')) {
    return /(?:^|\/)lib\/gone$/.test(plain(posix.normalize(posix.join(posix.dirname(file), spec))));
  }
  return plain(spec) === GONE_MODULE;
}
export const GONE_CALLERS: Readonly<Record<GoneGuard, RouteCaller>> = Object.freeze(
  Object.fromEntries(
    Object.entries(GONE_KINDS).map(([kind, { caller, reader }]) => {
      const answers = (READER_ANSWERS as Record<string, { caller: string } | undefined>)[reader];
      if (answers?.caller !== caller) {
        throw new Error(
          `route-callers: the gone kind ${kind} reads ${reader}, which answers no ${caller} caller`,
        );
      }
      return [kind, caller];
    }),
  ) as Record<GoneGuard, RouteCaller>,
);

/** The mark of a reading handler whose order was checked by hand: it may
 *  run code before its read or its wrapped call. */
export const HAND_CASE_MARK = 'route-callers: hand case';

/**
 * The caller kinds answered at the read (READER_ANSWERS `atRead`;
 * route-policy.ts ANSWERED_AT_READ): the gate binds the answer and the
 * handler's first read runs it, so
 * code before that read keeps its place (a public row's own checks, an
 * /api/v1 key rule) and needs no hand-case mark.
 */
export const KINDS_AT_READ: ReadonlySet<RouteCaller> = new Set(
  Object.values(READER_ANSWERS as Record<string, { caller: RouteCaller; atRead?: true }>)
    .filter((r) => r.atRead === true)
    .map((r) => r.caller),
);

const HTTP_METHODS: ReadonlySet<string> = new Set(DECLARED_METHODS);
const READERS = new Set(CALLER_READERS);
const GUARDS = new Set(SESSION_GUARDS);

type Fn = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;
const isFn = (n: ts.Node): n is Fn =>
  ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n);

/** `e` without parentheses, `as`, `satisfies` and `!`. */
function bare(e: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

const modifiers = (n: ts.Node) => (ts.canHaveModifiers(n) ? (ts.getModifiers(n) ?? []) : []);
const hasModifier = (n: ts.Node, kind: ts.SyntaxKind) => modifiers(n).some((m) => m.kind === kind);

/** Whether `inner` lies inside `outer`. */
const within = (inner: ts.Node, outer: ts.Node) => inner.pos >= outer.pos && inner.end <= outer.end;

/** An argument evaluated with no code of its own: a name, a property of
 *  one, a literal. */
function plainArg(e: ts.Expression): boolean {
  const b = bare(e);
  if (ts.isIdentifier(b) || ts.isLiteralExpression(b)) return true;
  if (ts.isPropertyAccessExpression(b)) return plainArg(b.expression);
  return (
    b.kind === ts.SyntaxKind.TrueKeyword ||
    b.kind === ts.SyntaxKind.FalseKeyword ||
    b.kind === ts.SyntaxKind.NullKeyword
  );
}

/**
 * The reads of another module's exports (a handler a route file imports
 * or re-exports, as the /api/v1 files do: `export { GET } from
 * '../../notes/route'`): `follow(specifier)` answers that module's
 * handlers that read, each to its caller kind, or null where it does not
 * know the module (not a route file): its handlers are taken as not
 * reading. A handler that reads with no answer on its row throws when
 * called (fail closed).
 */
export type FollowReads = (specifier: string) => HandlerCallers | null;

/** A method's handler: its function (null: not a plain function), the
 *  node it was declared by, and the statement that carries its marks. */
type Handler = { fn: Fn | null; decl: ts.Node; statement: ts.Node; mutable: boolean };

/**
 * The methods of `src` (a route file's text) whose handler reads the
 * pipeline's answer, sorted (handlerCallers' methods).
 */
export function handlerReads(src: string, file: string, follow?: FollowReads): string[] {
  return Object.keys(handlerCallers(src, file, follow)).sort();
}

/**
 * Each method of `src` (a route file's text) whose handler reads the
 * pipeline's answer, to the caller kind it reads. Throws, naming `file`,
 * on a file it cannot answer for (see above).
 */
export function handlerCallers(src: string, file: string, follow?: FollowReads): HandlerCallers {
  return analyzeRouteFile(src, file, follow).callers;
}

/** What the generator reads of a route file: each method that reads the
 *  pipeline's answer, to its caller kind (handlerCallers), and each method
 *  exported as a gone stub, to the stub's kind (goneStubs). One reading of
 *  the file for both, so they cannot disagree. */
export type RouteFileReads = Readonly<{
  callers: HandlerCallers;
  gone: Readonly<Record<string, GoneGuard>>;
}>;

export function analyzeRouteFile(src: string, file: string, follow?: FollowReads): RouteFileReads {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
  const fail = (node: ts.Node, msg: string): never => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    throw new Error(`${file}:${line + 1}: ${msg}`);
  };
  /** The caller kind a handler of another module reads, if it reads. */
  const kindOf = (spec: string, name: string): RouteCaller | undefined =>
    follow?.(spec)?.[name] ?? undefined;

  // ── The file's bindings ──────────────────────────────────────────────────
  // Its top-level functions and constants, by name; what it imports, each
  // local to the module and the name it has there; the methods it exports,
  // each to its handler; a handler from another module, to that module.
  const local = new Map<string, Handler>();
  const imported = new Map<string, { spec: string; name: string; node: ts.Node }>();
  const readerImported = new Set<string>();
  const guardLocals = new Map<string, string>();
  const aliasedGuards: Array<{ node: ts.Node; name: string; local: string }> = [];
  const methods = new Map<string, Handler>();
  const elsewhere = new Map<string, { spec: string; name: string }>();
  const aliases: Array<[method: string, localName: string]> = [];
  const wholeImports: Array<{ node: ts.Node; spec: string }> = [];

  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) {
      const h: Handler = { fn: st, decl: st, statement: st, mutable: false };
      local.set(st.name.text, h);
      if (
        hasModifier(st, ts.SyntaxKind.ExportKeyword) &&
        !hasModifier(st, ts.SyntaxKind.DefaultKeyword) &&
        HTTP_METHODS.has(st.name.text)
      ) {
        methods.set(st.name.text, h);
      }
    } else if (ts.isVariableStatement(st)) {
      const mutable = (st.declarationList.flags & ts.NodeFlags.Const) === 0;
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        const init = bare(d.initializer);
        const h: Handler = { fn: isFn(init) ? init : null, decl: d, statement: st, mutable };
        local.set(d.name.text, h);
        if (hasModifier(st, ts.SyntaxKind.ExportKeyword) && HTTP_METHODS.has(d.name.text)) {
          methods.set(d.name.text, h);
        }
      }
    } else if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const spec = st.moduleSpecifier.text;
      const clause = st.importClause;
      if (clause?.name) imported.set(clause.name.text, { spec, name: 'default', node: clause });
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        wholeImports.push({ node: bindings, spec });
      } else if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          const name = (el.propertyName ?? el.name).text;
          const as = el.name.text;
          if (READERS.has(name) || READERS.has(as)) {
            if (name !== as) {
              fail(el, `imports ${name} as ${as}: import ${name} by its own name`);
            }
            if (!READER_MODULES.includes(spec)) {
              fail(el, `imports ${name} from ${spec}: import it from ${READER_MODULES[0]}`);
            }
            readerImported.add(as);
          }
          if (GUARDS.has(name)) {
            guardLocals.set(as, name);
            if (as !== name) aliasedGuards.push({ node: el, name, local: as });
          }
          imported.set(as, { spec, name, node: el });
        }
      }
    } else if (ts.isExportDeclaration(st)) {
      const spec =
        st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)
          ? st.moduleSpecifier.text
          : null;
      if (!st.exportClause) {
        if (spec) wholeImports.push({ node: st, spec });
      } else if (ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements) {
          const exported = el.name.text;
          if (!HTTP_METHODS.has(exported)) continue;
          const name = (el.propertyName ?? el.name).text;
          if (spec) elsewhere.set(exported, { spec, name });
          else aliases.push([exported, name]);
        }
      }
    }
  }
  // A route file whose handlers read, imported whole or re-exported with
  // `*`: which of its handlers this file runs is not plain.
  for (const { node, spec } of wholeImports) {
    if (Object.keys(follow?.(spec) ?? {}).length > 0) {
      fail(node, `takes all of ${spec}, whose handlers read the caller: name the handlers`);
    }
  }
  // `export { handle as GET }` and `export const GET = handle`: the local
  // handler, or the one imported from another module.
  const resolveName = (method: string, name: string) => {
    const from = imported.get(name);
    const h = local.get(name);
    if (from) elsewhere.set(method, from);
    else if (h) methods.set(method, h);
  };
  for (const [method, name] of aliases) resolveName(method, name);
  // The names a method is exported as (`export const GET = handle`).
  const exportedAs = new Set<ts.Node>();
  for (const [method, h] of [...methods]) {
    const init = ts.isVariableDeclaration(h.decl) ? h.decl.initializer : undefined;
    const b = init ? bare(init) : undefined;
    if (b && ts.isIdentifier(b) && (imported.has(b.text) || local.has(b.text))) {
      exportedAs.add(b);
      methods.delete(method);
      resolveName(method, b.text);
    }
  }
  // The gone stubs (GONE_KINDS): a method exported as `gone('<kind>', ...)`
  // reads the caller of that kind.
  const gone = goneOf(methods, imported, fail);
  // A handler taken from another route file that reads: it may be
  // re-exported, exported as a method, or called first in a handler.
  const readingImports = new Set(
    [...imported].filter(([, f]) => kindOf(f.spec, f.name)).map(([l]) => l),
  );

  // ── Every name the answer turns on, where it stands ──────────────────────
  const readCalls: ts.CallExpression[] = [];
  const wrapCalls: ts.CallExpression[] = [];
  /** The caller kind each read and each wrap reads. */
  const kindAt = new Map<ts.CallExpression, RouteCaller>();
  const guardCalls: Array<{ call: ts.CallExpression; name: string }> = [];
  const guardRefs: Array<{ node: ts.Node; name: string }> = [];
  /** Each use of a top-level function or constant of the file by name
   *  (`return GET(req)` in POST): a handler of the file that reads. */
  const localRefs: Array<{ node: ts.Identifier; name: string }> = [];
  /** Whether the name `n` refers to `decl` (a top-level declaration or an
   *  import of the file), by binding: a parameter or a local of the same
   *  name (`POST(req, GET) { return GET(); }`) is another binding. */
  const bindingOf = symbolsOf(sf);
  const refersTo = (n: ts.Identifier, decl: ts.Node) =>
    bindingOf(n)?.declarations?.includes(decl as ts.Declaration) ?? false;
  /** The call `node` is the callee of (`f()` or `x.f()`), else null. */
  const calleeOf = (node: ts.Node): ts.CallExpression | null => {
    const p = node.parent;
    if (ts.isCallExpression(p) && p.expression === node) return p;
    if (ts.isPropertyAccessExpression(p) && p.name === node) {
      const g = p.parent;
      if (ts.isCallExpression(g) && g.expression === p) return g;
    }
    return null;
  };
  const visit = (n: ts.Node) => {
    // A type (`type T = typeof GET`, `x as ReturnType<typeof ownerCaller>`)
    // runs nothing and calls nothing: no name in it is a use.
    if (ts.isTypeNode(n) && !ts.isExpressionWithTypeArguments(n)) return;
    if (ts.isIdentifier(n)) {
      const p = n.parent;
      const declares = ts.isImportSpecifier(p) || ts.isExportSpecifier(p);
      if (READERS.has(n.text) && !ts.isImportSpecifier(p)) {
        if (ts.isPropertyAccessExpression(p) && p.name === n) {
          fail(n, `reads ${n.text} off an object: import ${n.text} by name and call it`);
        }
        const call = calleeOf(n);
        if (!call || call.questionDotToken) {
          fail(n, `names ${n.text} other than in a plain call: call ${n.text}() itself`);
        }
        if (!readerImported.has(n.text)) {
          fail(n, `calls ${n.text}() with no import of it from ${READER_MODULES[0]}`);
        }
        readCalls.push(call!);
        kindAt.set(call!, (READER_ANSWERS[n.text] as { caller: RouteCaller }).caller);
      }
      const isMember = ts.isPropertyAccessExpression(p) && p.name === n;
      const guard = isMember
        ? GUARDS.has(n.text)
          ? n.text
          : null
        : (guardLocals.get(n.text) ?? (GUARDS.has(n.text) ? n.text : null));
      if (guard && !declares) {
        const call = calleeOf(n);
        if (call) guardCalls.push({ call, name: guard });
        else guardRefs.push({ node: n, name: guard });
      }
      if (
        local.has(n.text) &&
        !isMember &&
        !declares &&
        !exportedAs.has(n) &&
        !namesDecl(n) &&
        refersTo(n, local.get(n.text)!.decl)
      ) {
        localRefs.push({ node: n, name: n.text });
      }
      if (
        readingImports.has(n.text) &&
        !isMember &&
        !declares &&
        !exportedAs.has(n) &&
        refersTo(n, imported.get(n.text)!.node)
      ) {
        const call = calleeOf(n);
        if (!call) {
          const { spec } = imported.get(n.text)!;
          fail(
            n,
            `passes ${n.text} (a handler of ${spec} that reads the caller) other than calling it`,
          );
        }
        wrapCalls.push(call!);
        const { spec, name } = imported.get(n.text)!;
        kindAt.set(call!, kindOf(spec, name)!);
      }
    } else if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)) {
      const key = n.argumentExpression.text;
      if (READERS.has(key))
        fail(n, `reads ${key} off an object: import ${key} by name and call it`);
      if (GUARDS.has(key)) guardRefs.push({ node: n, name: key });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  // ── The gone module, in the one form read here ──────────────────────────
  // `import { gone } from '@/lib/gone'`, called only as a method's export
  // (`export const GET = gone('owner')`, or a const a method is exported
  // as). Any other form (a relative or other spelling of the module, the
  // module imported whole or by default, gone under another name,
  // re-exported, or called or named anywhere else) is refused: a stub the
  // generator did not read would be served with no gone row, its reader
  // answered by no one (it throws: a 500 where the 410 was).
  for (const st of sf.statements) {
    const spec =
      (ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) &&
      st.moduleSpecifier &&
      ts.isStringLiteral(st.moduleSpecifier)
        ? st.moduleSpecifier.text
        : null;
    if (spec === null || !isGoneModule(spec, file)) continue;
    if (spec !== GONE_MODULE) {
      fail(st, `imports the gone module as ${spec}: import it from '${GONE_MODULE}'`);
    }
    if (ts.isExportDeclaration(st)) fail(st, `re-exports from ${GONE_MODULE}: import what it uses`);
    const clause = (st as ts.ImportDeclaration).importClause;
    if (clause?.name) fail(clause, `imports ${GONE_MODULE} by default: import gone by name`);
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      fail(bindings, `imports ${GONE_MODULE} whole: import gone by its own name`);
    }
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        if ((el.propertyName ?? el.name).text === 'gone' && el.name.text !== 'gone') {
          fail(el, `imports gone as ${el.name.text}: import gone by its own name`);
        }
      }
    }
  }
  const goneImport = imported.get('gone');
  if (goneImport && goneImport.spec === GONE_MODULE && goneImport.name === 'gone') {
    // The declarations a method is exported as: its stub's call, if any,
    // is the one place gone may be called.
    const stubCalls = new Set<ts.Node>();
    for (const h of methods.values()) {
      const init = ts.isVariableDeclaration(h.decl) ? h.decl.initializer : undefined;
      if (init) stubCalls.add(bare(init));
    }
    const uses = (n: ts.Node): void => {
      if (ts.isTypeNode(n) && !ts.isExpressionWithTypeArguments(n)) return;
      if (
        ts.isIdentifier(n) &&
        n.text === 'gone' &&
        !ts.isImportSpecifier(n.parent) &&
        !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) &&
        !namesDecl(n) &&
        refersTo(n, goneImport.node)
      ) {
        const call = n.parent;
        if (!ts.isCallExpression(call) || call.expression !== n || !stubCalls.has(call)) {
          fail(
            n,
            `uses gone other than as a method's export (export const GET = gone('owner')): the generator reads no other form`,
          );
        }
      }
      ts.forEachChild(n, uses);
    };
    uses(sf);
  }

  // ── A handler of the file that runs another (POST: `return GET(req)`) ──
  // reads what the one it runs reads, as a handler of another route file
  // does: to a fixed point, from the handlers that read or wrap.
  // Each reading handler, to the caller kinds it reads.
  const scopeOf = (h: Handler) => h.fn ?? h.decl;
  const readingLocal = new Map<Handler, Set<RouteCaller>>();
  const localCall = (r: { node: ts.Identifier }) => {
    const p = r.node.parent;
    return ts.isCallExpression(p) && p.expression === r.node ? p : null;
  };
  for (let grew = true; grew;) {
    grew = false;
    for (const h of methods.values()) {
      const scope = scopeOf(h);
      const kinds = new Set<RouteCaller>();
      for (const r of localRefs) {
        const target = local.get(r.name)!;
        const of = readingLocal.get(target);
        if (target !== h && of && within(r.node, scope) && localCall(r)) {
          for (const k of of) kinds.add(k);
        }
      }
      for (const c of [...readCalls, ...wrapCalls]) {
        if (within(c, scope)) kinds.add(kindAt.get(c)!);
      }
      const had = readingLocal.get(h);
      if (kinds.size > (had?.size ?? 0)) {
        readingLocal.set(h, kinds);
        grew = true;
      }
    }
  }
  for (const r of localRefs) {
    const target = local.get(r.name)!;
    const of = readingLocal.get(target);
    if (!of) continue;
    const call = localCall(r);
    if (!call) {
      fail(
        r.node,
        `passes ${r.name} (a handler of this file that reads the caller) other than calling it`,
      );
    }
    if (!within(call!, scopeOf(target))) {
      wrapCalls.push(call!);
      // A handler reading two kinds is refused below, where it is a method.
      kindAt.set(call!, [...of][0]!);
    }
  }

  // ── Each method ──────────────────────────────────────────────────────────
  const out: Record<string, RouteCaller> = Object.fromEntries(
    Object.entries(gone).map(([method, k]) => [method, GONE_CALLERS[k]]),
  );
  for (const [method, { spec, name }] of elsewhere) {
    const kind = kindOf(spec, name);
    if (kind) out[method] = kind;
  }
  const answered = new Set<ts.CallExpression>();
  const handlerNodes: ts.Node[] = [];
  for (const [method, h] of methods) {
    const scope = scopeOf(h);
    handlerNodes.push(scope);
    const readsIn = readCalls.filter((c) => within(c, scope));
    const wrapsIn = wrapCalls.filter((c) => within(c, scope));
    if (readsIn.length === 0 && wrapsIn.length === 0) continue;
    const at = readsIn[0] ?? wrapsIn[0]!;
    if (!h.fn) {
      fail(
        at,
        `${method} reads the caller but is not a plain function: the exported handler itself must read it`,
      );
    }
    if (h.mutable) {
      fail(
        at,
        `${method} reads the caller but is declared with let or var: declare it with const or function`,
      );
    }
    const guards = guardCalls.filter((g) => within(g.call, scope)).map((g) => g.name);
    if (guards.length > 0) {
      throw new Error(
        `${file}: ${method} reads the pipeline's caller and also calls ${[...new Set(guards)].join(', ')}: one or the other`,
      );
    }
    const atRead = [...(readingLocal.get(h) ?? [])].every((k) => KINDS_AT_READ.has(k));
    if (!atRead && !isHandCase(h.statement, sf) && !readsFirst(h.fn!, readsIn, wrapsIn)) {
      fail(
        at,
        `${method} runs code before it reads the caller the pipeline answers (the gate answers before ` +
          `the handler, so what the handler answered before its guard would come after the gate's ` +
          `refusal): read it first, or mark the handler "// ${HAND_CASE_MARK}" once its order is checked by hand`,
      );
    }
    for (const c of readsIn) answered.add(c);
    for (const c of wrapsIn) answered.add(c);
    const kinds = [...(readingLocal.get(h) ?? [])];
    if (kinds.length !== 1) {
      fail(
        at,
        `${method} reads the callers of ${kinds.length === 0 ? 'no kind' : kinds.sort().join(' and ')}: ` +
          `the gate answers one kind for a row, so a handler reads one kind's reader`,
      );
    }
    out[method] = kinds[0]!;
  }
  // A reader, or a reading handler of another file, anywhere else in the
  // file: no method can be said to read it.
  for (const c of [...readCalls, ...wrapCalls]) {
    if (!answered.has(c)) {
      const name = c.expression.getText(sf);
      fail(c, `${name}() outside an exported handler: call it in the handler itself`);
    }
  }
  // A file that reads: every guard stands in a handler, by its own name,
  // called (a guard in a helper or a wrapper could run beside the read).
  if (answered.size > 0) {
    for (const g of aliasedGuards) {
      fail(
        g.node,
        `imports ${g.name} as ${g.local} beside a read of the caller: import it by its own name`,
      );
    }
    for (const g of guardRefs) {
      fail(g.node, `names ${g.name} other than in a call, beside a read of the caller`);
    }
    for (const g of guardCalls) {
      if (!handlerNodes.some((n) => within(g.call, n))) {
        fail(
          g.call,
          `calls ${g.name} outside an exported handler (a helper or a wrapper), beside a read of the caller: call it in the handler that needs it`,
        );
      }
    }
  }
  return {
    callers: Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1))),
    gone,
  };
}

/**
 * The gone stubs of a route file (GONE_KINDS): each method exported as
 * `gone('<kind>', ...)`, `gone` imported by its own name from GONE_MODULE,
 * to the stub's kind. A call of it that is not a method's export, or names
 * no kind in a string literal, is refused: the generator could not say
 * whose answer the stub reads.
 */
function goneOf(
  methods: Map<string, Handler>,
  imported: Map<string, { spec: string; name: string; node: ts.Node }>,
  fail: (node: ts.Node, msg: string) => never,
): Record<string, GoneGuard> {
  const out: Record<string, GoneGuard> = {};
  const isGone = (e: ts.Expression) => {
    const b = bare(e);
    if (!ts.isIdentifier(b)) return false;
    const from = imported.get(b.text);
    if (!from || from.spec !== GONE_MODULE || from.name !== 'gone') return false;
    if (b.text !== 'gone') fail(b, `imports gone as ${b.text}: import gone by its own name`);
    return true;
  };
  for (const [method, h] of methods) {
    const init = ts.isVariableDeclaration(h.decl) ? h.decl.initializer : undefined;
    const call = init ? bare(init) : undefined;
    if (!call || !ts.isCallExpression(call) || !isGone(call.expression)) continue;
    const arg = call.arguments[0];
    const kind = arg && ts.isStringLiteralLike(arg) && isGoneGuard(arg.text) ? arg.text : undefined;
    if (!kind)
      fail(
        call,
        `${method} = gone(...) names no stub kind (${Object.keys(GONE_KINDS).join(', ')})`,
      );
    if (h.mutable)
      fail(call, `${method} = gone(...) is declared with let or var: declare it with const`);
    out[method] = kind!;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** The methods of `src` (a route file's text) exported as a gone stub
 *  (GONE_KINDS), sorted: their rows are gone rows (route-policy.ts). */
export function handlerGone(src: string, file: string, follow?: FollowReads): string[] {
  return Object.keys(goneStubs(src, file, follow));
}

/** Each method of `src` exported as a gone stub, to the stub's kind
 *  (GONE_KINDS): the generator's reading (analyzeRouteFile), which the
 *  guard sweep names a stub's entry by too. */
export function goneStubs(
  src: string,
  file: string,
  follow?: FollowReads,
): Readonly<Record<string, GoneGuard>> {
  return analyzeRouteFile(src, file, follow).gone;
}

/** Each method of a route file to the switch it is served under
 *  (route-switches.ts). */
export type HandlerSwitches = Readonly<Record<string, RouteSwitch>>;

/**
 * The switches a route file declares (route-switches.ts):
 * `export const routeSwitches = { POST: 'not-production' }` (with `as
 * const` or `satisfies RouteSwitches`), each method the file exports to a
 * switch, read into the manifest so the declaration moves with the handler.
 * Refused (the generator fails): the export in any other form (let or
 * var, not an object literal, a spread, a computed or non-method key, a
 * value that is not a switch's name in a string literal, `export { x as
 * routeSwitches }`, a re-export), a switch for a method the file does not
 * export, and a handler taken from another route file served under a
 * switch there (`follow`, as in handlerCallers) while this file's methods
 * do not all declare the same switch: the handler would be served here
 * with the switch off.
 */
export function handlerSwitches(
  src: string,
  file: string,
  follow?: (specifier: string) => HandlerSwitches | null,
): HandlerSwitches {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
  const fail = (node: ts.Node, msg: string): never => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    throw new Error(`${file}:${line + 1}: ${msg}`);
  };
  const NAME = ROUTE_SWITCHES_EXPORT;
  const exported = new Set<string>();
  const out: Record<string, RouteSwitch> = {};
  let declared: ts.Node | null = null;
  /** Each name taken from another module: [node, specifier, its name there]. */
  const taken: Array<[ts.Node, string, string]> = [];
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && hasModifier(st, ts.SyntaxKind.ExportKeyword)) {
      if (st.name.text === NAME)
        fail(st, `${NAME} is a function: declare it as export const ${NAME} = { ... }`);
      if (HTTP_METHODS.has(st.name.text)) exported.add(st.name.text);
    } else if (ts.isVariableStatement(st) && hasModifier(st, ts.SyntaxKind.ExportKeyword)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        if (HTTP_METHODS.has(d.name.text)) exported.add(d.name.text);
        if (d.name.text !== NAME) continue;
        declared = d;
        if ((st.declarationList.flags & ts.NodeFlags.Const) === 0) {
          fail(d, `${NAME} is declared with let or var: declare it with const`);
        }
        const obj = d.initializer ? bare(d.initializer) : undefined;
        if (!obj || !ts.isObjectLiteralExpression(obj)) {
          fail(d, `${NAME} is not an object literal: each method to its switch's name`);
        }
        for (const p of (obj as ts.ObjectLiteralExpression).properties) {
          if (!ts.isPropertyAssignment(p)) {
            fail(p, `${NAME}: each entry is a method to its switch's name, written out`);
          }
          const a = p as ts.PropertyAssignment;
          const key =
            ts.isIdentifier(a.name) || ts.isStringLiteral(a.name) ? a.name.text : undefined;
          if (!key || !HTTP_METHODS.has(key))
            fail(a.name, `${NAME}: ${a.name.getText(sf)} is no method`);
          if (Object.hasOwn(out, key!)) fail(a.name, `${NAME}: ${key} is named twice`);
          const v = bare(a.initializer);
          if (!ts.isStringLiteralLike(v) || !isRouteSwitch(v.text)) {
            fail(
              a.initializer,
              `${NAME}: ${key} names no switch (${ROUTE_SWITCH_NAMES.join(', ')})`,
            );
          }
          out[key!] = (v as ts.StringLiteralLike).text as RouteSwitch;
        }
      }
    } else if (ts.isExportDeclaration(st)) {
      const spec =
        st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)
          ? st.moduleSpecifier.text
          : null;
      if (!st.exportClause) {
        if (spec && Object.keys(follow?.(spec) ?? {}).length > 0) {
          fail(st, `takes all of ${spec}, whose handlers are served under a switch: name them`);
        }
        continue;
      }
      if (!ts.isNamedExports(st.exportClause)) continue;
      for (const el of st.exportClause.elements) {
        if (el.name.text === NAME) {
          fail(
            el,
            `${NAME} is exported by name: declare it here as export const ${NAME} = { ... }`,
          );
        }
        if (HTTP_METHODS.has(el.name.text)) exported.add(el.name.text);
        if (spec) taken.push([el, spec, (el.propertyName ?? el.name).text]);
      }
    } else if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const spec = st.moduleSpecifier.text;
      const bindings = st.importClause?.namedBindings;
      if (st.importClause?.name) taken.push([st.importClause, spec, 'default']);
      if (bindings && ts.isNamespaceImport(bindings)) {
        if (Object.keys(follow?.(spec) ?? {}).length > 0) {
          fail(
            bindings,
            `imports all of ${spec}, whose handlers are served under a switch: name them`,
          );
        }
      } else if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          taken.push([el, spec, (el.propertyName ?? el.name).text]);
        }
      }
    }
  }
  if (declared) {
    for (const m of Object.keys(out)) {
      if (!exported.has(m)) fail(declared, `${NAME}: ${m} is a method this file does not export`);
    }
  }
  // A handler served under a switch in its own route file, taken here: it
  // keeps the switch on every method of this file (any of them may run it).
  for (const [node, spec, name] of taken) {
    const there = follow?.(spec)?.[name];
    if (!there) continue;
    for (const m of exported) {
      if (out[m] !== there) {
        fail(
          node,
          `takes ${name} from ${spec}, served under ${there} there: declare ${NAME} = { ${m}: '${there}' } here too`,
        );
      }
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/**
 * The binding a name of `sf` refers to, from the TypeScript binder (a
 * program of the one file, nothing resolved): it walks the scopes, so a
 * parameter, a local or a catch variable that shadows a top-level name is
 * its own binding. A shorthand property (`{ GET }`) refers to the value it
 * names.
 */
function symbolsOf(sf: ts.SourceFile): (n: ts.Identifier) => ts.Symbol | undefined {
  let checker: ts.TypeChecker | null = null;
  return (n) => {
    if (!checker) {
      const host: ts.CompilerHost = {
        getSourceFile: (name) => (name === sf.fileName ? sf : undefined),
        writeFile: () => {},
        getDefaultLibFileName: () => 'lib.d.ts',
        useCaseSensitiveFileNames: () => true,
        getCanonicalFileName: (f) => f,
        getCurrentDirectory: () => '',
        getNewLine: () => '\n',
        fileExists: (f) => f === sf.fileName,
        readFile: () => undefined,
      };
      checker = ts
        .createProgram({
          rootNames: [sf.fileName],
          options: { noLib: true, noResolve: true, types: [] },
          host,
        })
        .getTypeChecker();
    }
    const p = n.parent;
    return ts.isShorthandPropertyAssignment(p) && p.name === n
      ? checker.getShorthandAssignmentValueSymbol(p)
      : checker.getSymbolAtLocation(n);
  };
}

/** Whether `n` is the name a declaration gives (not a use of a name). */
function namesDecl(n: ts.Identifier): boolean {
  const p = n.parent;
  return (
    ((ts.isFunctionDeclaration(p) ||
      ts.isFunctionExpression(p) ||
      ts.isVariableDeclaration(p) ||
      ts.isParameter(p) ||
      ts.isClassDeclaration(p) ||
      ts.isPropertyAssignment(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isPropertySignature(p)) &&
      p.name === n) ||
    (ts.isBindingElement(p) && (p.name === n || p.propertyName === n))
  );
}

/** Whether a handler's parameters run code of their own: a default value
 *  (`GET(req, ctx, x = audit())`, `GET(req, { params = sideFx() })`) or a
 *  computed key, at any depth of a destructuring. It runs before the first
 *  statement, so before the read. */
function paramsRunCode(fn: Fn): boolean {
  const runs = (name: ts.BindingName): boolean =>
    !ts.isIdentifier(name) &&
    name.elements.some(
      (el) =>
        !ts.isOmittedExpression(el) &&
        (!!el.initializer ||
          (!!el.propertyName && ts.isComputedPropertyName(el.propertyName)) ||
          runs(el.name)),
    );
  return fn.parameters.some((p) => !!p.initializer || runs(p.name));
}

/** Whether the statement that declares a handler is marked as a hand
 *  case (a comment right above it). */
function isHandCase(statement: ts.Node, sf: ts.SourceFile): boolean {
  const ranges = ts.getLeadingCommentRanges(sf.text, statement.pos) ?? [];
  return ranges.some((r) => sf.text.slice(r.pos, r.end).includes(HAND_CASE_MARK));
}

/**
 * Whether `fn` reads the caller before anything else: its first statement
 * is the read (`ownerCaller();`, `const x = ownerCaller();`), or, for a
 * handler that runs a reading handler (another file's, or one of its own
 * file: POST's `return GET(req)`), `return h(args)` (or `return await
 * h(args)`, or the arrow's body) with arguments that run no code of their
 * own; and its parameters run none (no default value).
 */
function readsFirst(fn: Fn, readsIn: ts.CallExpression[], wrapsIn: ts.CallExpression[]): boolean {
  const body = fn.body;
  if (!body || paramsRunCode(fn)) return false;
  const isRead = (e: ts.Expression | undefined) => {
    const b = e && bare(e);
    return !!b && ts.isCallExpression(b) && readsIn.includes(b);
  };
  const isWrap = (e: ts.Expression | undefined) => {
    let b = e && bare(e);
    if (b && ts.isAwaitExpression(b)) b = bare(b.expression);
    return !!b && ts.isCallExpression(b) && wrapsIn.includes(b) && b.arguments.every(plainArg);
  };
  if (!ts.isBlock(body)) return isRead(body) || isWrap(body);
  const first = body.statements[0];
  if (!first) return false;
  if (ts.isExpressionStatement(first)) return isRead(first.expression);
  if (ts.isVariableStatement(first)) {
    const ds = first.declarationList.declarations;
    return ds.length === 1 && isRead(ds[0]!.initializer);
  }
  if (ts.isReturnStatement(first)) return isWrap(first.expression);
  return false;
}

/** The module a route file imports routePolicy from, by its own name. */
const DECLARATION_MODULE = ROUTE_DECLARATION_MODULE;

/**
 * The policy a route file declares (lib/auth/route-declaration.ts):
 *
 *     export const policy = routePolicy({ GET: { class: 'content', effect: 'read' } });
 *
 * read from the code, as data: the generator puts it in the manifest
 * (`policy`), so the loader has it when it registers the route without
 * loading the module. Null: the file declares none.
 *
 * Refused (the generator fails): the export in any other form (let or
 * var, not a call of routePolicy imported by its own name from
 * DECLARATION_MODULE with one object literal, `export { x as policy }`, a
 * re-export), a value that is not a literal (a name, a call, a spread, a
 * computed key, a template with a substitution), a key named twice or
 * `__proto__`, a value validateRoutePolicy refuses (route-declaration.ts:
 * the one validator, the boot's too; a method the file does not export,
 * `route.methods`, the manifest entry's), and a method the file exports
 * that the declaration does not name. What needs the whole manifest
 * (an alias's base) is the boot's (route-policy.ts declaredFacts).
 */
export function handlerPolicy(
  src: string,
  file: string,
  route: Readonly<{ pattern: string; methods: readonly string[] }>,
): RoutePolicyDeclaration | null {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
  const fail = (node: ts.Node, msg: string): never => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    throw new Error(`${file}:${line + 1}: ${msg}`);
  };
  const NAME = ROUTE_POLICY_EXPORT;
  let declared: ts.VariableDeclaration | null = null;
  let call: ts.CallExpression | null = null;
  let importedAs: string | null = null;
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const named = st.importClause?.namedBindings;
      if (st.moduleSpecifier.text !== DECLARATION_MODULE || !named || !ts.isNamedImports(named)) {
        continue;
      }
      for (const el of named.elements) {
        if ((el.propertyName ?? el.name).text !== 'routePolicy') continue;
        if (el.propertyName) fail(el, `imports routePolicy as ${el.name.text}: by its own name`);
        importedAs = 'routePolicy';
      }
    } else if (
      ts.isFunctionDeclaration(st) &&
      st.name &&
      hasModifier(st, ts.SyntaxKind.ExportKeyword)
    ) {
      if (st.name.text === NAME) fail(st, `${NAME} is a function: declare it with routePolicy`);
    } else if (ts.isVariableStatement(st) && hasModifier(st, ts.SyntaxKind.ExportKeyword)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || d.name.text !== NAME) continue;
        declared = d;
        if ((st.declarationList.flags & ts.NodeFlags.Const) === 0) {
          fail(d, `${NAME} is declared with let or var: declare it with const`);
        }
        const init = d.initializer ? bare(d.initializer) : undefined;
        if (
          !init ||
          !ts.isCallExpression(init) ||
          !ts.isIdentifier(init.expression) ||
          init.expression.text !== 'routePolicy' ||
          init.arguments.length !== 1
        ) {
          fail(d, `${NAME} is not routePolicy({ ... }): each method to its policy, written out`);
        }
        call = init as ts.CallExpression;
      }
    } else if (
      ts.isExportDeclaration(st) &&
      st.exportClause &&
      ts.isNamedExports(st.exportClause)
    ) {
      for (const el of st.exportClause.elements) {
        if (el.name.text === NAME) {
          fail(el, `${NAME} is exported by name: declare it here with routePolicy({ ... })`);
        }
      }
    }
  }
  if (!declared || !call) return null;
  if (!importedAs) fail(call, `calls routePolicy with no import of it from ${DECLARATION_MODULE}`);
  const value = (e: ts.Expression): unknown => {
    const b = bare(e);
    if (ts.isStringLiteral(b) || ts.isNoSubstitutionTemplateLiteral(b)) return b.text;
    if (b.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (b.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (b.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isArrayLiteralExpression(b)) {
      return b.elements.map((x) => {
        if (ts.isSpreadElement(x)) fail(x, `${NAME}: a spread; write each value out`);
        return value(x);
      });
    }
    if (ts.isObjectLiteralExpression(b)) {
      // No prototype: a key is only ever data (`__proto__` is refused too).
      const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const p of b.properties) {
        if (!ts.isPropertyAssignment(p))
          fail(p, `${NAME}: each entry is a key to a literal, written out`);
        const a = p as ts.PropertyAssignment;
        const k = ts.isIdentifier(a.name) || ts.isStringLiteral(a.name) ? a.name.text : null;
        if (k === null) fail(a.name, `${NAME}: ${a.name.getText(sf)} is a computed key`);
        if (k === '__proto__') fail(a.name, `${NAME}: __proto__ is no key of a declaration`);
        if (Object.hasOwn(out, k!)) fail(a.name, `${NAME}: ${k} is named twice`);
        out[k!] = value(a.initializer);
      }
      return out;
    }
    return fail(b, `${NAME}: ${b.getText(sf)} is not a literal: a declaration is data`);
  };
  const decl = value(call.arguments[0]!);
  let policy: RoutePolicyDeclaration;
  try {
    policy = validateRoutePolicy(decl, route.pattern, route.methods);
  } catch (e) {
    return fail(call, errorMessage(e));
  }
  // Each method the file exports is declared: the boot
  // (requireRouteDeclarations), the lint and the
  // tests refuse a missing one; the generator says it first, at the line.
  const missing = route.methods.filter((m) => !Object.hasOwn(policy, m));
  if (missing.length > 0) {
    fail(call, `${NAME} names no ${missing.join(', ')}, which the file exports: declare each`);
  }
  return policy;
}

/**
 * The HTTP methods a route file exports (DECLARED_METHODS), read from its
 * syntax: `export async function GET`, `export const GET =`, and an export
 * clause, re-exported or not (`export { handler as GET }`, `export { GET }
 * from '../notes/route'`); a type-only export is none. The one reader of
 * them for the generator (gen-route-manifest.ts: the manifest's `methods`,
 * which handlerPolicy and the rows read); the lint
 * (route-plumbing.mjs route-policy-declared) reads the same forms in
 * ESLint's tree, and route-plumbing.test.ts holds the two to each form.
 */
export function exportedMethods(src: string, file: string): string[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
  const methods = DECLARED_METHODS as readonly string[];
  const found = new Set<string>();
  const exported = (n: ts.Node) =>
    ts.canHaveModifiers(n) &&
    (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && exported(st)) {
      if (methods.includes(st.name.text)) found.add(st.name.text);
    } else if (ts.isVariableStatement(st) && exported(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && methods.includes(d.name.text)) found.add(d.name.text);
      }
    } else if (ts.isExportDeclaration(st) && !st.isTypeOnly && st.exportClause) {
      if (!ts.isNamedExports(st.exportClause)) continue;
      for (const el of st.exportClause.elements) {
        if (!el.isTypeOnly && methods.includes(el.name.text)) found.add(el.name.text);
      }
    }
  }
  return methods.filter((m) => found.has(m));
}

/** A handler a route file takes from another module, unchanged: the
 *  method it is exported as, to the module (`spec`) and the name it has
 *  there. */
export type ReExportedHandlers = Readonly<Record<string, Readonly<{ spec: string; name: string }>>>;

/**
 * The methods a route file exports as another module's handler, unchanged
 * (an /api/v1 alias): `export { GET } from '../../notes/route'`, `export {
 * GET as POST } from ...`, or an imported handler exported by name
 * (`import { GET } from ...; export { GET }`). A method the file defines
 * itself (a wrapper that calls an imported handler) is not one.
 */
export function reExportedHandlers(src: string, file: string): ReExportedHandlers {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
  const imported = new Map<string, { spec: string; name: string }>();
  const out: Record<string, { spec: string; name: string }> = Object.create(null);
  const methods = DECLARED_METHODS as readonly string[];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const named = st.importClause?.namedBindings;
      if (st.importClause?.isTypeOnly || !named || !ts.isNamedImports(named)) continue;
      for (const el of named.elements) {
        if (el.isTypeOnly) continue;
        const name = (el.propertyName ?? el.name).text;
        imported.set(el.name.text, { spec: st.moduleSpecifier.text, name });
      }
    }
  }
  for (const st of sf.statements) {
    if (!ts.isExportDeclaration(st) || st.isTypeOnly) continue;
    const clause = st.exportClause;
    if (!clause || !ts.isNamedExports(clause)) continue;
    const spec =
      st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : null;
    for (const el of clause.elements) {
      const as = el.name.text;
      if (el.isTypeOnly || !methods.includes(as)) continue;
      const local = (el.propertyName ?? el.name).text;
      const from = spec !== null ? { spec, name: local } : imported.get(local);
      if (from) out[as] = from;
    }
  }
  return out;
}

/** The route segments of a route file's directory under app/ (`rel`,
 *  posix, '' for app itself): route groups dropped, `[x]` as `:x`, a
 *  catch-all (`[...x]`, optional `[[...x]]`) as `*`. The generator's
 *  pattern of every route file, and the pattern a handler's `from` spec
 *  resolves to (specPattern): one spelling. */
export function routeDirSegments(rel: string): {
  segments: string[];
  catchAll: string | null;
  catchAllOptional: boolean;
} {
  const rawSegs = rel === '' ? [] : rel.split('/');
  const segments: string[] = [];
  let catchAll: string | null = null;
  let catchAllOptional = false;
  for (const seg of rawSegs) {
    if (seg.startsWith('(') && seg.endsWith(')')) continue; // route group
    let m: RegExpMatchArray | null;
    if ((m = seg.match(/^\[\[\.\.\.(.+)\]\]$/))) {
      catchAll = m[1]!;
      catchAllOptional = true;
      segments.push('*');
    } else if ((m = seg.match(/^\[\.\.\.(.+)\]$/))) {
      catchAll = m[1]!;
      segments.push('*');
    } else if ((m = seg.match(/^\[(.+)\]$/))) {
      segments.push(`:${m[1]}`);
    } else {
      segments.push(seg);
    }
  }
  return { segments, catchAll, catchAllOptional };
}

/** Whether `file` (posix, from server/web) is a route file: app/**\/route.ts(x). */
const ROUTE_FILE = /^app\/(?:.*\/)?route\.tsx?$/;

/** The route pattern of a route file (posix, from server/web:
 *  `app/api/notes/[id]/route.ts` is `/api/notes/:id`); null where `file`
 *  is no route file. */
export function routeFilePattern(file: string): string | null {
  if (!ROUTE_FILE.test(file)) return null;
  const dir = posix.dirname(file).slice('app'.length).replace(/^\//, '');
  return '/' + routeDirSegments(dir).segments.join('/');
}

/**
 * The route file a module spec of the route file `file` names (both posix,
 * from server/web), or null where it names none (a lib module, a
 * package). `exists` says whether a path from server/web is a file. A
 * spec that names a route file other than by a relative path (`@/app/...`
 * or an absolute path; a spec whose last segment is `route`) is refused,
 * it throws: the generator follows a route file's
 * handlers and reads, and checks an alias, only through a relative one,
 * so another spelling would read as no route file. One resolver for the
 * generator and its cells (route-callers-policy.test.ts).
 */
export function specRouteFile(
  file: string,
  spec: string,
  exists: (rel: string) => boolean,
): string | null {
  if (!spec.startsWith('./') && !spec.startsWith('../')) {
    const local = spec.startsWith('@/') ? spec.slice(2) : null;
    const named =
      /(^|\/)route(\.tsx?)?$/.test(spec) ||
      (local !== null &&
        [local, `${local}.ts`, `${local}.tsx`].some((f) => ROUTE_FILE.test(f) && exists(f)));
    if (named) {
      throw new Error(
        `${file}: imports the route file ${spec} by a path that is not relative: write it relative (./ or ../), so the generator follows it`,
      );
    }
    return null;
  }
  const base = posix.normalize(posix.join(posix.dirname(file), spec));
  const found = (/\.tsx?$/.test(base) ? [base] : [`${base}.ts`, `${base}.tsx`]).find(exists);
  return found && ROUTE_FILE.test(found) ? found : null;
}

/** The route pattern a module spec of the route file `file` names
 *  (specRouteFile, then routeFilePattern), or null where it names no
 *  route file. */
export function specPattern(
  file: string,
  spec: string,
  exists: (rel: string) => boolean,
): string | null {
  const target = specRouteFile(file, spec, exists);
  return target ? routeFilePattern(target) : null;
}

/**
 * Where a route file's declared `aliasOf` is not the route its handler
 * comes from: each declared method's alias
 * is exactly the route file it re-exports (`patternOf` its spec, the
 * same method there), and a method that re-exports another route file's
 * handler declares that alias. `patternOf` gives the route pattern of a
 * spec that names a route file, else null (a lib module: not an alias).
 * Each mismatch, as the generator reports it; none: the file holds.
 */
export function aliasMismatches(
  src: string,
  file: string,
  policy: RoutePolicyDeclaration | null,
  patternOf: (spec: string) => string | null,
): string[] {
  if (!policy) return [];
  const out: string[] = [];
  const reExported = reExportedHandlers(src, file);
  for (const m of DECLARED_METHODS) {
    const p = policy[m];
    if (!p) continue;
    const declared = Object.hasOwn(p, 'aliasOf') ? (p as { aliasOf?: string }).aliasOf : undefined;
    const from = reExported[m];
    let pattern: string | null;
    try {
      pattern = from ? patternOf(from.spec) : null;
    } catch (e) {
      out.push(errorMessage(e));
      continue;
    }
    const actual = from && pattern !== null ? `${from.name} ${pattern}` : null;
    if (declared === undefined && actual !== null) {
      out.push(`${file}: ${m} re-exports the handler of ${actual} and declares no aliasOf`);
    } else if (declared !== undefined && actual === null) {
      out.push(`${file}: ${m} declares aliasOf ${declared} and re-exports no route's handler`);
    } else if (declared !== undefined && declared !== actual) {
      out.push(`${file}: ${m} declares aliasOf ${declared}, but re-exports ${actual}`);
    }
  }
  return out;
}

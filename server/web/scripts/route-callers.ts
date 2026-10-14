/**
 * Which handlers of a route file read the caller the HTTP pipeline answers
 * (arch A4 step 3b): the gate's step that runs the owner guard's answer
 * once, from the request's ROUTE_POLICY row, before the handler, and
 * refuses with it (lib/auth/session.ts answerRouteCaller). A handler reads
 * it with ownerCaller() instead of calling a session guard.
 *
 * The route manifest generator (gen-route-manifest.ts) asks this of every
 * route file, and the manifest carries the answer (`reads`, the methods);
 * the route's ROUTE_POLICY rows say so (`caller`), and the gate answers
 * only those rows. A handler that reads with no answer on its row would
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
 *    after the gate's refusal), a parameter's default value included, and
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
 * Batch by batch (docs/actors.md, A4 step 3b) the guard calls go; when they
 * are gone every row is answered and this goes with them.
 */
import ts from 'typescript';
import { CALLER_READERS, SESSION_GUARDS } from '../../../eslint-rules/session-guards.mjs';

/** The readers and the session guards: the one list
 *  (eslint-rules/session-guards.mjs). */
export { CALLER_READERS, SESSION_GUARDS };

/** The modules a reader is imported from (lib/auth.ts re-exports
 *  lib/auth/session.ts). */
export const READER_MODULES: readonly string[] = ['@/lib/auth', '@/lib/auth/session'];

/** The mark of a reading handler whose order was checked by hand: it may
 *  run code before its read or its wrapped call. */
export const HAND_CASE_MARK = 'route-callers: hand case';

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
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
 * '../../notes/route'`): `follow(specifier)` answers the methods that
 * module's handlers read, or null where it does not know the module (not
 * a route file): its handlers are taken as not reading. A handler that
 * reads with no answer on its row throws when called (fail closed).
 */
export type FollowReads = (specifier: string) => readonly string[] | null;

/** A method's handler: its function (null: not a plain function), the
 *  node it was declared by, and the statement that carries its marks. */
type Handler = { fn: Fn | null; decl: ts.Node; statement: ts.Node; mutable: boolean };

/**
 * The methods of `src` (a route file's text) whose handler reads the
 * pipeline's answer. Throws, naming `file`, on a file it cannot answer for
 * (see above).
 */
export function handlerReads(src: string, file: string, follow?: FollowReads): string[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
  const fail = (node: ts.Node, msg: string): never => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    throw new Error(`${file}:${line + 1}: ${msg}`);
  };
  const reads = (spec: string, name: string) => follow?.(spec)?.includes(name) ?? false;

  // ── The file's bindings ──────────────────────────────────────────────────
  // Its top-level functions and constants, by name; what it imports, each
  // local to the module and the name it has there; the methods it exports,
  // each to its handler; a handler from another module, to that module.
  const local = new Map<string, Handler>();
  const imported = new Map<string, { spec: string; name: string }>();
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
      if (clause?.name) imported.set(clause.name.text, { spec, name: 'default' });
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
          imported.set(as, { spec, name });
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
    if ((follow?.(spec)?.length ?? 0) > 0) {
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
  // A handler taken from another route file that reads: it may be
  // re-exported, exported as a method, or called first in a handler.
  const readingImports = new Set(
    [...imported].filter(([, f]) => reads(f.spec, f.name)).map(([l]) => l),
  );

  // ── Every name the answer turns on, where it stands ──────────────────────
  const readCalls: ts.CallExpression[] = [];
  const wrapCalls: ts.CallExpression[] = [];
  const guardCalls: Array<{ call: ts.CallExpression; name: string }> = [];
  const guardRefs: Array<{ node: ts.Node; name: string }> = [];
  /** Each use of a top-level function or constant of the file by name
   *  (`return GET(req)` in POST): a handler of the file that reads. */
  const localRefs: Array<{ node: ts.Identifier; name: string }> = [];
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
      if (local.has(n.text) && !isMember && !declares && !exportedAs.has(n) && !namesDecl(n)) {
        localRefs.push({ node: n, name: n.text });
      }
      if (readingImports.has(n.text) && !isMember && !declares && !exportedAs.has(n)) {
        const call = calleeOf(n);
        if (!call) {
          const { spec } = imported.get(n.text)!;
          fail(
            n,
            `passes ${n.text} (a handler of ${spec} that reads the caller) other than calling it`,
          );
        }
        wrapCalls.push(call!);
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

  // ── A handler of the file that runs another (POST: `return GET(req)`) ──
  // reads what the one it runs reads, as a handler of another route file
  // does: to a fixed point, from the handlers that read or wrap.
  const scopeOf = (h: Handler) => h.fn ?? h.decl;
  const readingLocal = new Set<Handler>();
  const localCall = (r: { node: ts.Identifier }) => {
    const p = r.node.parent;
    return ts.isCallExpression(p) && p.expression === r.node ? p : null;
  };
  for (let grew = true; grew;) {
    grew = false;
    for (const h of methods.values()) {
      if (readingLocal.has(h)) continue;
      const scope = scopeOf(h);
      const runsReader = localRefs.some((r) => {
        const target = local.get(r.name)!;
        return target !== h && readingLocal.has(target) && within(r.node, scope) && !!localCall(r);
      });
      if (
        runsReader ||
        readCalls.some((c) => within(c, scope)) ||
        wrapCalls.some((c) => within(c, scope))
      ) {
        readingLocal.add(h);
        grew = true;
      }
    }
  }
  for (const r of localRefs) {
    const target = local.get(r.name)!;
    if (!readingLocal.has(target)) continue;
    const call = localCall(r);
    if (!call) {
      fail(
        r.node,
        `passes ${r.name} (a handler of this file that reads the caller) other than calling it`,
      );
    }
    if (!within(call!, scopeOf(target))) wrapCalls.push(call!);
  }

  // ── Each method ──────────────────────────────────────────────────────────
  const out: string[] = [];
  for (const [method, { spec, name }] of elsewhere) {
    if (reads(spec, name)) out.push(method);
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
    if (!isHandCase(h.statement, sf) && !readsFirst(h.fn!, readsIn, wrapsIn)) {
      fail(
        at,
        `${method} runs code before it reads the caller the pipeline answers (the gate answers before ` +
          `the handler, so what the handler answered before its guard would come after the gate's ` +
          `refusal): read it first, or mark the handler "// ${HAND_CASE_MARK}" once its order is checked by hand`,
      );
    }
    for (const c of readsIn) answered.add(c);
    for (const c of wrapsIn) answered.add(c);
    out.push(method);
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
  return [...new Set(out)].sort();
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

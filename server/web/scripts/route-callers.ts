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
 * the TypeScript parser, never kept by hand, and a file this cannot answer
 * for is refused (the generator fails, at build and before every test run):
 *
 *  - a reader called outside an exported handler (a helper of the file):
 *    which methods read it is not plain;
 *  - a handler that reads and also calls a session guard.
 *
 * Batch by batch (docs/actors.md, A4 step 3b) the guard calls go; when they
 * are gone every row is answered and this goes with them.
 */
import ts from 'typescript';

/** The readers of the pipeline's answer (lib/auth/session.ts). */
export const CALLER_READERS: readonly string[] = ['ownerCaller'];

/** The session guards (lib/auth/session.ts): each resolves the caller
 *  itself. A handler that reads the pipeline's answer calls none. */
export const SESSION_GUARDS: readonly string[] = [
  'getOwnerForAsset',
  'getMemberForAsset',
  'getReaderForAsset',
  'getSessionUserWithSource',
  'getSessionUser',
  'requireOwner',
  'requireOwnerForRender',
  'requireOwnerWithSource',
  'getOwnerOr401',
  'getOwnerOr401WithSource',
  'getOwnerOr401WithLogin',
  'getMemberOr401',
  'getLoginOr401',
  'getChatLoginOr401',
  'getCookieUpgradeLoginOr401',
];

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/** The names called in `node`: plain calls `f()` and member calls `x.f()`. */
function calledNames(node: ts.Node): Map<string, ts.CallExpression[]> {
  const out = new Map<string, ts.CallExpression[]>();
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null;
      if (name) out.set(name, [...(out.get(name) ?? []), n]);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

const hasExport = (n: ts.Node) =>
  ts.canHaveModifiers(n) &&
  (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

/**
 * The methods of `src` (a route file's text) whose handler reads the
 * pipeline's answer. Throws, naming `file`, on a file it cannot answer for
 * (see above).
 */
export function handlerReads(src: string, file: string): string[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
  // The file's top-level functions and constants, by name, and the
  // methods it exports, each to the node that is its handler.
  const local = new Map<string, ts.Node>();
  const methods = new Map<string, ts.Node>();
  const aliases: Array<[method: string, localName: string]> = [];
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) {
      local.set(st.name.text, st);
      if (hasExport(st) && HTTP_METHODS.has(st.name.text)) methods.set(st.name.text, st);
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        local.set(d.name.text, d);
        if (hasExport(st) && HTTP_METHODS.has(d.name.text)) methods.set(d.name.text, d);
      }
    } else if (
      ts.isExportDeclaration(st) &&
      st.exportClause &&
      ts.isNamedExports(st.exportClause)
    ) {
      for (const el of st.exportClause.elements) {
        const exported = el.name.text;
        if (HTTP_METHODS.has(exported)) aliases.push([exported, (el.propertyName ?? el.name).text]);
      }
    }
  }
  for (const [method, name] of aliases) {
    const node = local.get(name);
    if (node) methods.set(method, node);
  }

  const reads: string[] = [];
  const inHandler = new Set<ts.CallExpression>();
  for (const [method, node] of methods) {
    const called = calledNames(node);
    const readCalls = CALLER_READERS.flatMap((r) => called.get(r) ?? []);
    if (readCalls.length === 0) continue;
    for (const c of readCalls) inHandler.add(c);
    const guards = SESSION_GUARDS.filter((g) => called.has(g));
    if (guards.length > 0) {
      throw new Error(
        `${file}: ${method} reads the pipeline's caller and also calls ${guards.join(', ')}: one or the other`,
      );
    }
    reads.push(method);
  }
  // A reader anywhere else in the file: no method can be said to read it.
  const all = calledNames(sf);
  for (const r of CALLER_READERS) {
    for (const c of all.get(r) ?? []) {
      if (!inHandler.has(c)) {
        const { line } = sf.getLineAndCharacterOfPosition(c.getStart(sf));
        throw new Error(
          `${file}:${line + 1}: ${r}() outside an exported handler: call it in the handler itself`,
        );
      }
    }
  }
  return reads.sort();
}

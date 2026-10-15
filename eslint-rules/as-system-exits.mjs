/**
 * The honest count of system-pool exits (arch A6 fix round 1, L1), read by
 * arch-counts.mjs (asSystemExits) and pinned in
 * scripts/arch-scoreboard.pins.json.
 *
 * A pinned asSystem site is where the code CAN leave the scope; the places
 * that make it leave are the calls of the function holding the site. So
 * the count parses each file (the TypeScript parser, no type checker) and,
 * for every asSystem call, finds the innermost named function holding it
 * (a function declaration, a `const f = (...) => ...` or `function`
 * expression, a method or a `name: () => ...` property; arrow, async and
 * generic forms alike) and counts every place that function is used:
 *
 *  - a call or any other use of its name (passed as a callback, put in a
 *    list): a use, wherever the name is bound in the defining file;
 *  - exported: also every use in another file that binds the name (a named
 *    import, a destructured dynamic import) and every `x.name` there (a
 *    namespace import). An exported holder's name must be unique among the
 *    exported holders (holderProblems), so a use cannot be miscounted;
 *  - a method or a property function: every `x.name` in its own file.
 *
 * A holder no code uses (a route handler, a tool handler the dispatcher
 * calls by its table) counts its own sites. An asSystem call in no named
 * function (top-level code) counts once. Each use counts in the file that
 * makes it.
 *
 * Several sites in one holder (a conditional wrapper: two reasons, one
 * taken) are one exit per use: a use leaves the scope once.
 */
import ts from 'typescript';

/** @param {string} path @param {string} text */
function parse(path, text) {
  return ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

const hasExport = (node) => !!node?.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

/**
 * The name of a function-like node and how it is reached: 'binding' (a
 * declaration or a variable), 'member' (a method or a property function),
 * or null (anonymous: a callback). `exported` for a binding.
 */
function holderOf(fn) {
  if (ts.isFunctionDeclaration(fn) && fn.name) {
    return { name: fn.name.text, kind: 'binding', exported: hasExport(fn) };
  }
  if (ts.isMethodDeclaration(fn) && fn.name && ts.isIdentifier(fn.name)) {
    return { name: fn.name.text, kind: 'member', exported: false };
  }
  if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
    let p = fn.parent;
    // `const f = <T>(x) => ...` through a cast or parentheses.
    while (
      p &&
      (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isSatisfiesExpression?.(p))
    ) {
      p = p.parent;
    }
    if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) {
      const stmt = p.parent?.parent;
      return { name: p.name.text, kind: 'binding', exported: hasExport(stmt) };
    }
    if (p && ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) {
      return { name: p.name.text, kind: 'member', exported: false };
    }
  }
  return null;
}

/** The asSystem holders of one file: `{ name, kind, exported, sites,
 *  reasons }`, name null for the sites in no named function (each counts
 *  once). */
export function asSystemHolders(path, text) {
  if (!/\basSystem\b/.test(text)) return [];
  const sf = parse(path, text);
  /** @type {Map<string, { name: string|null, kind: string|null, exported: boolean, sites: number, reasons: string[] }>} */
  const out = new Map();
  // Names exported later (`export { f }`).
  const exportedLater = new Set();
  const scan = (n) => {
    if (
      ts.isExportDeclaration(n) &&
      !n.moduleSpecifier &&
      n.exportClause &&
      ts.isNamedExports(n.exportClause)
    ) {
      for (const e of n.exportClause.elements) exportedLater.add((e.propertyName ?? e.name).text);
    }
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'asSystem'
    ) {
      let h = null;
      for (let p = n.parent; p && !h; p = p.parent) {
        if (ts.isFunctionLike(p)) h = holderOf(p);
      }
      // The reason: the call's last argument, a string literal.
      const last = n.arguments[n.arguments.length - 1];
      const reason = last && ts.isStringLiteralLike(last) ? last.text : null;
      if (!h) h = { name: null, kind: null, exported: false };
      const key = `${h.kind}:${h.name}`;
      const cur = out.get(key);
      if (cur) {
        cur.sites += 1;
        if (reason && !cur.reasons.includes(reason)) cur.reasons.push(reason);
      } else out.set(key, { ...h, sites: 1, reasons: reason ? [reason] : [] });
    }
    ts.forEachChild(n, scan);
  };
  scan(sf);
  return [...out.values()].map((h) => ({
    ...h,
    reasons: [...h.reasons].sort(),
    exported: h.exported || (h.kind === 'binding' && exportedLater.has(h.name)),
  }));
}

/** Whether identifier `id` is a declaration, import or export of its name
 *  (not a use), or a property name (`x.name`, `{ name: v }`). */
function notAUse(id) {
  const p = id.parent;
  if (!p) return true;
  if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name === id) return true;
  if (ts.isVariableDeclaration(p) && p.name === id) return true;
  if (ts.isParameter(p) && p.name === id) return true;
  if (ts.isBindingElement(p) && (p.name === id || p.propertyName === id)) return true;
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) return true;
  if (ts.isExportSpecifier(p)) return true;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return true;
  if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) && p.name === id) return true;
  if (ts.isTypeQueryNode(p) || ts.isTypeReferenceNode(p)) return true;
  return false;
}

/** Uses in `sf` of `name`: as a bare name (when `bare`) and as `x.name`
 *  (when `member`). */
function usesIn(sf, name, { bare, member }) {
  let n = 0;
  const visit = (node) => {
    if (ts.isIdentifier(node) && node.text === name) {
      const p = node.parent;
      if (member && p && ts.isPropertyAccessExpression(p) && p.name === node) n += 1;
      else if (bare && !notAUse(node)) n += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return n;
}

/** Whether `sf` binds `name` from elsewhere (a named import, a
 *  destructured dynamic import or require). */
function bindsImported(sf, name) {
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (ts.isImportSpecifier(node) && node.name.text === name) found = true;
    else if (
      ts.isBindingElement(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      (node.propertyName
        ? ts.isIdentifier(node.propertyName) && node.propertyName.text === name
        : true)
    )
      found = true;
    else ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** A renaming import or export of `name` in `sf` (`{ name as other }`), or
 *  null: a renamed holder's uses would not be found by its name. */
function aliasOf(sf, name) {
  let found = null;
  const visit = (node) => {
    if (found) return;
    if (
      (ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) &&
      node.propertyName &&
      node.propertyName.text === name &&
      node.name.text !== name
    ) {
      found = `as ${node.name.text}`;
    } else if (
      ts.isBindingElement(node) &&
      node.propertyName &&
      ts.isIdentifier(node.propertyName) &&
      node.propertyName.text === name &&
      ts.isIdentifier(node.name) &&
      node.name.text !== name
    ) {
      found = `: ${node.name.text}`;
    } else ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * The exits of every file: `{ byFile, holders, problems }`.
 * `files`: `[{ path, text }]`, the counted files.
 */
export function asSystemExits(files) {
  const cache = new Map();
  const ast = (f) => {
    let sf = cache.get(f.path);
    if (!sf) {
      sf = parse(f.path, f.text);
      cache.set(f.path, sf);
    }
    return sf;
  };
  const byFile = {};
  const add = (path, n) => {
    if (n) byFile[path] = (byFile[path] ?? 0) + n;
  };
  const holders = [];
  for (const f of files) {
    for (const h of asSystemHolders(f.path, f.text)) holders.push({ ...h, path: f.path });
  }
  const problems = holderProblems(holders);
  for (const h of holders) {
    if (h.name === null) {
      add(h.path, h.sites);
      h.uses = 0;
      continue;
    }
    const own = files.find((f) => f.path === h.path);
    const word = new RegExp(`\\b${h.name}\\b`);
    const perFile = new Map();
    const local =
      h.kind === 'binding'
        ? usesIn(ast(own), h.name, { bare: true, member: false })
        : usesIn(ast(own), h.name, { bare: false, member: true });
    if (local) perFile.set(h.path, local);
    if (h.exported) {
      for (const f of files) {
        if (!word.test(f.text)) continue;
        const alias = aliasOf(ast(f), h.name);
        if (alias)
          problems.push(`${f.path} renames the asSystem holder ${h.name} (${alias}): use its name`);
        if (f.path === h.path) continue;
        const sf = ast(f);
        const bare = bindsImported(sf, h.name);
        const n = usesIn(sf, h.name, { bare, member: true });
        if (n) perFile.set(f.path, n);
      }
    }
    h.uses = [...perFile.values()].reduce((a, b) => a + b, 0);
    if (h.uses === 0) add(h.path, h.sites);
    else for (const [p, n] of perFile) add(p, n);
  }
  return { byFile, holders, problems };
}

/** An exported holder's name must be unique among exported holders (its
 *  uses elsewhere are found by name). */
export function holderProblems(holders) {
  const seen = new Map();
  for (const h of holders) {
    if (!h.exported || !h.name) continue;
    seen.set(h.name, [...(seen.get(h.name) ?? []), h.path]);
  }
  return [...seen]
    .filter(([, ps]) => ps.length > 1)
    .map(([n, ps]) => `exported asSystem holder ${n} in ${ps.join(', ')}: rename one`);
}

/**
 * Direct uses of `systemDb` (the admin pool whatever the scope) in one
 * file: every use of the name but its declaration, imports and exports
 * (A6 fix round 1, L1: pinned apart from the asSystem exits, as
 * systemDbUses). eslint-rules/system-db-allowlist.mjs names the files that
 * may import it.
 */
export function systemDbUses(path, text) {
  if (!/\bsystemDb\b/.test(text)) return 0;
  return usesIn(parse(path, text), 'systemDb', { bare: true, member: false });
}

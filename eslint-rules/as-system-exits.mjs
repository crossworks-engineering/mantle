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
 *
 * The same engine counts the request system exits (rights-counts.mjs,
 * noteRequestSystem) with `follow: 'forwarders'`: there a site with a
 * literal reason is an exit itself (the reason is decided there), and only
 * a holder that passes a parameter on as the reason (a wrapper) is
 * followed to its uses, each use with the reason it passes. One engine
 * follows wrappers for both counts.
 *
 * A call is the bare name or a member of that name (`db.asSystem(...)`
 * through a namespace import), as the per-file site regexes read it. The
 * call, or a followed holder, under another name (a renamed import, a
 * renaming destructure, `const n = call`, `{ n: call }`) is a problem: its
 * calls would count 0. So is a wrapper whose sites pass different
 * parameters on (its uses are read at one). `pnpm arch:check` fails on any
 * problem.
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

/** The parameter index of `fn` named `name`, or -1. */
function paramIndex(fn, name) {
  return (fn?.parameters ?? []).findIndex((p) => ts.isIdentifier(p.name) && p.name.text === name);
}

/** Strip parentheses, casts and non-null marks off an expression. */
function unwrap(e) {
  while (
    e &&
    (ts.isParenthesizedExpression(e) ||
      ts.isAsExpression(e) ||
      ts.isNonNullExpression(e) ||
      ts.isTypeAssertionExpression?.(e) ||
      ts.isSatisfiesExpression?.(e))
  ) {
    e = e.expression;
  }
  return e;
}

/** Whether expression `e` names `name`: the bare name (when `bareName`), or
 *  a member of that name (`x.name`, `x?.name`, `x['name']`, when
 *  `member`). */
function namesIt(e, name, { bareName = true, member = true } = {}) {
  e = unwrap(e);
  if (!e) return false;
  if (ts.isIdentifier(e)) return bareName && e.text === name;
  if (ts.isPropertyAccessExpression(e)) return member && e.name.text === name;
  if (ts.isElementAccessExpression(e)) {
    return (
      member && ts.isStringLiteralLike(e.argumentExpression) && e.argumentExpression.text === name
    );
  }
  return false;
}

/** The holders of the calls of `call` (default asSystem) in one file:
 *  `{ name, kind, exported, sites, reasons, siteList }`, name null for the
 *  sites in no named function (each counts once). `siteList` holds each
 *  site's literal reason (or null) and `forward`, the index of the
 *  holder's parameter the site passes as its reason (or -1). */
export function asSystemHolders(path, text, call = 'asSystem') {
  if (!new RegExp(`\\b${call}\\b`).test(text)) return [];
  const sf = parse(path, text);
  /** @type {Map<string, { name: string|null, kind: string|null, exported: boolean, sites: number, reasons: string[], siteList: { reason: string|null, forward: number }[] }>} */
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
    // A call of the bare name or of a member of that name (`db.call(...)`
    // through a namespace import, `x?.call(...)`, `x['call'](...)`), as the
    // per-file site regexes (arch-counts.mjs) read `x.asSystem(` too.
    if (ts.isCallExpression(n) && namesIt(n.expression, call)) {
      let h = null;
      let fn = null;
      for (let p = n.parent; p && !h; p = p.parent) {
        if (ts.isFunctionLike(p)) {
          h = holderOf(p);
          if (h) fn = p;
        }
      }
      // The reason: the call's last argument, a string literal; or one of
      // the holder's parameters, passed on (a wrapper).
      const last = n.arguments[n.arguments.length - 1];
      const reason = last && ts.isStringLiteralLike(last) ? last.text : null;
      const forward = last && ts.isIdentifier(last) ? paramIndex(fn, last.text) : -1;
      if (!h) h = { name: null, kind: null, exported: false };
      const key = `${h.kind}:${h.name}`;
      const cur = out.get(key);
      const site = { reason, forward };
      if (cur) {
        cur.sites += 1;
        cur.siteList.push(site);
        if (reason && !cur.reasons.includes(reason)) cur.reasons.push(reason);
      } else out.set(key, { ...h, sites: 1, reasons: reason ? [reason] : [], siteList: [site] });
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

/** The uses in `sf` of `name` (their nodes): as a bare name (when `bare`)
 *  and as `x.name` (when `member`). */
function useNodes(sf, name, { bare, member }) {
  const out = [];
  const visit = (node) => {
    if (ts.isIdentifier(node) && node.text === name) {
      const p = node.parent;
      if (member && p && ts.isPropertyAccessExpression(p) && p.name === node) out.push(node);
      else if (bare && !notAUse(node)) out.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** The number of uses in `sf` of `name` (useNodes). */
function usesIn(sf, name, opts) {
  return useNodes(sf, name, opts).length;
}

/** The argument at `index` of the call a use makes (`f(...)`,
 *  `x.f(...)`), or null when the use is no call (a callback, a list). */
function useArgument(node, index) {
  const callee = ts.isPropertyAccessExpression(node.parent) ? node.parent : node;
  const c = callee.parent;
  if (!c || !ts.isCallExpression(c) || c.expression !== callee) return null;
  return c.arguments[index] ?? null;
}

/** The innermost function holding `node`, or null. */
function enclosingFunction(node) {
  for (let p = node.parent; p; p = p.parent) if (ts.isFunctionLike(p)) return p;
  return null;
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

/**
 * The aliases of `name` in `sf`, each as written (`as g`, `: g`, `g =`):
 * its calls under another name would not be found by its name. A renaming
 * import or export (`{ name as g }`), a renaming destructure
 * (`{ name: g } = ...`), and a variable, assignment or object property
 * holding it under another name (`const g = name`, `g = db.name`,
 * `{ g: name }`). `bareName`: whether the bare name is the one meant here
 * (its own file, or a file importing it); `member`: whether `x.name` is.
 */
function aliasesOf(sf, name, { bareName = true, member = true } = {}) {
  const found = [];
  const holds = (e) => namesIt(e, name, { bareName, member });
  const visit = (node) => {
    if (
      (ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) &&
      node.propertyName &&
      node.propertyName.text === name &&
      node.name.text !== name
    ) {
      found.push(`as ${node.name.text}`);
    } else if (
      ts.isBindingElement(node) &&
      node.propertyName &&
      ts.isIdentifier(node.propertyName) &&
      node.propertyName.text === name &&
      ts.isIdentifier(node.name) &&
      node.name.text !== name
    ) {
      found.push(`: ${node.name.text}`);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text !== name &&
      node.initializer &&
      holds(node.initializer)
    ) {
      found.push(`${node.name.text} =`);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      holds(node.right) &&
      !namesIt(node.left, name)
    ) {
      found.push(`${node.left.getText(sf)} =`);
    } else if (
      ts.isPropertyAssignment(node) &&
      !(ts.isIdentifier(node.name) && node.name.text === name) &&
      holds(node.initializer)
    ) {
      found.push(`${node.name.getText(sf)}:`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * The exits of every file: `{ byFile, byReason, holders, problems }`.
 * `files`: `[{ path, text }]`, the counted files. `call`: the function
 * whose calls leave the scope (asSystem). `follow`: 'all' (every holder is
 * followed to its uses: the asSystem count) or 'forwarders' (a site with
 * its own reason counts itself; only a holder passing a parameter on as
 * the reason is followed, each use with the literal reason it passes:
 * the request system exits). `byReason` keys an unreadable reason
 * 'unnamed'; in 'all' a use takes its holder's reason when it has one.
 */
export function asSystemExits(files, { call = 'asSystem', follow = 'all' } = {}) {
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
  const byReason = {};
  const add = (path, n, reason = null) => {
    if (!n) return;
    byFile[path] = (byFile[path] ?? 0) + n;
    const r = reason ?? 'unnamed';
    byReason[r] = (byReason[r] ?? 0) + n;
  };
  const holders = [];
  for (const f of files) {
    for (const h of asSystemHolders(f.path, f.text, call)) holders.push({ ...h, path: f.path });
  }
  const problems = holderProblems(holders, call);
  // The call itself under another name (`import { call as n }`,
  // `const n = call`, `const n = db.call`): its calls would count 0.
  const callWord = new RegExp(`\\b${call}\\b`);
  for (const f of files) {
    if (!callWord.test(f.text)) continue;
    for (const alias of aliasesOf(ast(f), call)) {
      problems.push(`${f.path} renames ${call} (${alias}): call it by its name`);
    }
  }
  for (const h of holders) {
    const forwarding = h.siteList.filter((x) => x.forward >= 0);
    const followed = follow === 'all' ? h.siteList : forwarding;
    // In 'forwarders', a site that decides its own reason is an exit.
    if (follow !== 'all') {
      for (const x of h.siteList) if (x.forward < 0) add(h.path, 1, x.reason);
    }
    // A wrapper passing different parameters on: its uses are read at one
    // parameter only, so a reason passed at another would not be seen.
    const at = forwarding[0]?.forward ?? -1;
    if (follow !== 'all' && forwarding.some((x) => x.forward !== at)) {
      problems.push(
        `${h.path} ${h.name ?? 'top-level code'} passes different parameters on to ${call}: pass one reason parameter`,
      );
    }
    const one = h.reasons.length === 1 ? h.reasons[0] : null;
    if (h.name === null || followed.length === 0) {
      if (followed.length) add(h.path, followed.length, follow === 'all' ? one : null);
      h.uses = 0;
      continue;
    }
    const own = files.find((f) => f.path === h.path);
    const word = new RegExp(`\\b${h.name}\\b`);
    const renamed = (path, alias) =>
      problems.push(`${path} renames the ${call} holder ${h.name} (${alias}): use its name`);
    // A followed holder under another name in its own file.
    const ownAliases =
      h.kind === 'binding'
        ? aliasesOf(ast(own), h.name, { bareName: true, member: false })
        : aliasesOf(ast(own), h.name, { bareName: false, member: true });
    for (const alias of ownAliases) renamed(h.path, alias);
    const perFile = new Map();
    const local =
      h.kind === 'binding'
        ? useNodes(ast(own), h.name, { bare: true, member: false })
        : useNodes(ast(own), h.name, { bare: false, member: true });
    if (local.length) perFile.set(h.path, local);
    if (h.exported) {
      for (const f of files) {
        if (f.path === h.path || !word.test(f.text)) continue;
        const sf = ast(f);
        const imported = bindsImported(sf, h.name);
        for (const alias of aliasesOf(sf, h.name, { bareName: imported, member: true })) {
          renamed(f.path, alias);
        }
        const nodes = useNodes(sf, h.name, { bare: imported, member: true });
        if (nodes.length) perFile.set(f.path, nodes);
      }
    }
    h.uses = [...perFile.values()].reduce((a, b) => a + b.length, 0);
    if (h.uses === 0) {
      add(h.path, followed.length, follow === 'all' ? one : null);
      continue;
    }
    if (follow === 'all') {
      for (const [p, nodes] of perFile) add(p, nodes.length, one);
      continue;
    }
    // A wrapper: each use passes its reason at the forwarded parameter.
    for (const [p, nodes] of perFile) {
      for (const node of nodes) {
        const arg = useArgument(node, at);
        if (arg && ts.isStringLiteralLike(arg)) {
          add(p, 1, arg.text);
          continue;
        }
        add(p, 1, null);
        // A wrapper of a wrapper: its own uses would not be counted.
        if (arg && ts.isIdentifier(arg) && paramIndex(enclosingFunction(node), arg.text) >= 0) {
          problems.push(
            `${p} passes a parameter on to the ${call} wrapper ${h.name}: call it with the reason`,
          );
        }
      }
    }
  }
  return { byFile, byReason, holders, problems };
}

/** An exported holder's name must be unique among exported holders (its
 *  uses elsewhere are found by name). */
export function holderProblems(holders, call = 'asSystem') {
  const seen = new Map();
  for (const h of holders) {
    if (!h.exported || !h.name) continue;
    seen.set(h.name, [...(seen.get(h.name) ?? []), h.path]);
  }
  return [...seen]
    .filter(([, ps]) => ps.length > 1)
    .map(([n, ps]) => `exported ${call} holder ${n} in ${ps.join(', ')}: rename one`);
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

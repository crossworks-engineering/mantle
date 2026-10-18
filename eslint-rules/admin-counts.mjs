/**
 * The Admin counts of the scoreboard: where code, not the scope, decides
 * that a caller is an Admin user or holds an Admin area, and the system
 * exits that come with it (plan v3.2 sections 2.1 and 2.2). Read by
 * rights-counts.mjs, pinned in scripts/arch-scoreboard.pins.json, tested
 * in admin-counts.test.ts. Syntax trees (the TypeScript parser, no type
 * checker), comments and strings never count:
 *
 *  - systemWhole tools: tool policies whose area scope runs whole on the
 *    system pool (`scope: { area, systemWhole: true }`);
 *  - Admin act routes: the entries of ADMIN_ACT_WRITES and each other
 *    place the item gate answers ADMIN_ACT (an Admin user's write on the
 *    system pool, with no scope);
 *  - login kind branches: `x.kind` (or `kind`) compared with 'admin' or
 *    'member', and each such case of a switch on it (a progress counter:
 *    a rename games it; the type test login-shape.test.ts is the check);
 *  - login role decision reads: the same over `role`, and drizzle
 *    `eq(x.role, 'admin')`;
 *  - Admin decision flags: identifiers named isAdmin (a progress counter:
 *    most are the workspace's own flag today);
 *  - TypeScript area rules: functions that decide an Admin area themselves
 *    (read a limits record's `areas`, answer the whole area list, or answer
 *    an `area` asked from those);
 *  - area and Admin asks after the gate: scopeHasArea, loginHasArea,
 *    requireArea and loginHoldsAdmin anywhere but the gates;
 *  - the pin of the login type test (how many of `kind` and `role` the
 *    login type still has).
 */
import ts from 'typescript';
import { readRepoFile, stripComments } from './arch-counts.mjs';
import { parse } from './as-system-exits.mjs';

/** Files the Admin counts never read: test support builds fixtures. */
function isTestSupport(path) {
  return /(^|\/)test-support(\/|\.ts$)/.test(path);
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

/** Each node of `sf`, depth first. */
function walk(sf, visit) {
  const go = (n) => {
    visit(n);
    ts.forEachChild(n, go);
  };
  go(sf);
}

const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

// ── systemWhole tools ───────────────────────────────────────────────────────

/** The tool policies of `text` whose area scope runs whole on the system
 *  pool: an object literal with an `area` property and `systemWhole:
 *  true`. A spread of the flag (`{ systemWhole: true }` with no area, the
 *  policy readers) is not a policy. */
export function systemWholeTools(path, text) {
  if (!/\bsystemWhole\b/.test(text)) return 0;
  let n = 0;
  walk(parse(path, text), (node) => {
    if (!ts.isObjectLiteralExpression(node)) return;
    const named = (k) =>
      node.properties.find(
        (p) =>
          (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
          p.name?.getText() === k,
      );
    const flag = named('systemWhole');
    if (!flag || !named('area')) return;
    if (ts.isPropertyAssignment(flag) && flag.initializer.kind === ts.SyntaxKind.TrueKeyword)
      n += 1;
  });
  return n;
}

// ── Admin act routes ────────────────────────────────────────────────────────

/** The Admin acts of `text`: each string entry of the ADMIN_ACT_WRITES list,
 *  and each use of ADMIN_ACT as an answer (the item gate's other acts). Not
 *  acts: its declaration, a comparison with it, a type, and the answer
 *  picked by `adminActWrite(...)` (the list's entries, counted already). */
export function adminActRoutes(path, text) {
  if (!/\bADMIN_ACT(?:_WRITES)?\b/.test(text)) return [];
  const sf = parse(path, text);
  const out = [];
  walk(sf, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'ADMIN_ACT_WRITES' &&
      node.initializer
    ) {
      walk(node.initializer, (e) => {
        if (ts.isStringLiteralLike(e) && /^[A-Z]+ \//.test(e.text)) out.push(`${e.text}`);
      });
      return;
    }
    if (!ts.isIdentifier(node) || node.text !== 'ADMIN_ACT') return;
    const p = node.parent;
    if (ts.isVariableDeclaration(p) && p.name === node) return;
    for (let q = p; q; q = q.parent) if (ts.isTypeNode(q)) return;
    let top = node;
    while (top.parent && unwrap(top.parent) !== top.parent) top = top.parent;
    const tp = top.parent;
    if (
      tp &&
      ts.isBinaryExpression(tp) &&
      [
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
      ].includes(tp.operatorToken.kind)
    ) {
      return;
    }
    if (
      tp &&
      ts.isConditionalExpression(tp) &&
      /\badminActWrite\s*\(/.test(tp.condition.getText(sf))
    ) {
      return;
    }
    out.push(`${path}:${lineOf(sf, node)}`);
  });
  return out;
}

// ── login kind and role branches ────────────────────────────────────────────

const LOGIN_NAMES = new Set(['admin', 'member']);
const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/** Whether `e` reads `field` (`x.field`, `x?.field`, `x['field']`, or a
 *  bare `field`). */
function readsField(e, field) {
  e = unwrap(e);
  if (!e) return false;
  if (ts.isIdentifier(e)) return e.text === field;
  if (ts.isPropertyAccessExpression(e)) return e.name.text === field;
  if (ts.isElementAccessExpression(e)) {
    const k = unwrap(e.argumentExpression);
    return !!k && ts.isStringLiteralLike(k) && k.text === field;
  }
  return false;
}

const loginName = (e) => {
  e = unwrap(e);
  return !!e && ts.isStringLiteralLike(e) && LOGIN_NAMES.has(e.text);
};

/** Whether `e` is a list literal (`['admin']`, `new Set(['admin'])`) holding
 *  a login name, or a name of the file bound to one (`lists`). */
function loginList(e, lists) {
  e = unwrap(e);
  if (!e) return false;
  if (ts.isIdentifier(e)) return lists.has(e.text);
  if (ts.isArrayLiteralExpression(e)) return e.elements.some(loginName);
  if (
    ts.isNewExpression(e) &&
    ts.isIdentifier(e.expression) &&
    e.expression.text === 'Set' &&
    e.arguments?.length === 1
  ) {
    return loginList(e.arguments[0], lists);
  }
  return false;
}

/** The names of `sf` that hold `field` under another name (`const r =
 *  row.role`, `const { role: r } = row`, `let r; r = row.role`), and the
 *  names bound to a list of login names (`const ADMIN = ['admin']`). By
 *  name in the file, with no scopes: a rename of the field into a local
 *  never lowers the count. */
function fieldAliases(sf, field) {
  const aliases = new Set();
  const lists = new Set();
  for (let grew = true; grew;) {
    grew = false;
    const isField = (e) => {
      e = unwrap(e);
      return !!e && (readsField(e, field) || (ts.isIdentifier(e) && aliases.has(e.text)));
    };
    const add = (set, name) => {
      if (!set.has(name)) {
        set.add(name);
        grew = true;
      }
    };
    walk(sf, (n) => {
      if (ts.isVariableDeclaration(n) && n.initializer) {
        if (ts.isIdentifier(n.name)) {
          if (isField(n.initializer)) add(aliases, n.name.text);
          else if (loginList(n.initializer, lists)) add(lists, n.name.text);
        }
      } else if (
        ts.isBindingElement(n) &&
        ts.isIdentifier(n.name) &&
        (n.propertyName ? n.propertyName.getText(sf) : n.name.text) === field &&
        n.name.text !== field
      ) {
        add(aliases, n.name.text);
      } else if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(n.left) &&
        isField(n.right)
      ) {
        add(aliases, n.left.text);
      }
    });
  }
  return { aliases, lists };
}

/** The places of `text` that branch on `field` ('kind' or 'role') against
 *  a login's 'admin' or 'member': an equality either way round, each such
 *  case of a switch on it, a membership test of a list of login names
 *  (`['admin'].includes(x.field)`, `new Set([...]).has(...)`), and
 *  (`drizzle`) `eq(x.field, 'admin')` / `ne(...)`. A local that holds the
 *  field under another name (`const r = row.role`) reads it too, and the
 *  field read by a literal key (`login['role']`) is the field. Returns
 *  their lines. */
export function loginFieldBranches(path, text, field, { drizzle = false } = {}) {
  if (!new RegExp(String.raw`\b${field}\b`).test(text) || !/'(?:admin|member)'/.test(text)) {
    return [];
  }
  const sf = parse(path, text);
  const { aliases, lists } = fieldAliases(sf, field);
  const reads = (e) => {
    e = unwrap(e);
    return !!e && (readsField(e, field) || (ts.isIdentifier(e) && aliases.has(e.text)));
  };
  const out = [];
  walk(sf, (node) => {
    if (ts.isBinaryExpression(node) && EQUALITY.has(node.operatorToken.kind)) {
      if (
        (reads(node.left) && loginName(node.right)) ||
        (reads(node.right) && loginName(node.left))
      ) {
        out.push(lineOf(sf, node));
      }
      return;
    }
    if (ts.isSwitchStatement(node) && reads(node.expression)) {
      for (const c of node.caseBlock.clauses) {
        if (ts.isCaseClause(c) && loginName(c.expression)) out.push(lineOf(sf, c));
      }
      return;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === 'includes' || node.expression.name.text === 'has') &&
      node.arguments.length === 1 &&
      reads(node.arguments[0]) &&
      loginList(node.expression.expression, lists)
    ) {
      out.push(lineOf(sf, node));
      return;
    }
    if (
      drizzle &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === 'eq' || node.expression.text === 'ne') &&
      node.arguments.length === 2 &&
      !ts.isIdentifier(unwrap(node.arguments[0])) &&
      readsField(node.arguments[0], field) &&
      loginName(node.arguments[1])
    ) {
      out.push(lineOf(sf, node));
    }
  });
  return out;
}

/** Files whose `kind` compared with 'admin' is not a login's kind, each with
 *  why. The count reads syntax, not types, so these are named. */
export const NOT_LOGIN_KIND = Object.freeze({
  'packages/std/src/access-error.ts':
    "an AccessError's kind: 'admin' is the refusal's reason (Admin only), not who the caller is",
  'packages/runtime/src/heartbeats/fire.ts':
    "the agent's workspace kind ('admin' | 'workspace' | 'none'), not a login's",
  'server/web/lib/workspace-look.ts':
    "a workspace's look kind ('admin' | 'private' | 'other'), checked against its list, not a login's",
});

// ── Admin decision flags ────────────────────────────────────────────────────

/** The identifiers named isAdmin in `text` (any binding, property or use).
 *  By name: a progress counter only. */
export function adminDecisionFlags(path, text) {
  if (!/\bisAdmin\b/.test(text)) return 0;
  let n = 0;
  walk(parse(path, text), (node) => {
    if (ts.isIdentifier(node) && node.text === 'isAdmin') n += 1;
  });
  return n;
}

// ── TypeScript area rules ───────────────────────────────────────────────────

/** The named functions of `sf`: `{ name, node, body }` (declarations and
 *  `const f = (...) => ...` / function expressions). */
function namedFunctions(sf) {
  const out = [];
  walk(sf, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      out.push({ name: node.name.text, node });
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(unwrap(node.initializer)) ||
        ts.isFunctionExpression(unwrap(node.initializer)))
    ) {
      out.push({ name: node.name.text, node: unwrap(node.initializer) });
    }
  });
  return out;
}

const AREA_LISTS = new Set(['WORKSPACE_AREAS', 'SCOPE_AREAS']);

/** Whether function `fn` reads the `areas` of a limits record
 *  (`limits.areas`, `x.limits?.areas`, `limits['areas']`). */
function readsLimitsAreas(fn) {
  let found = false;
  walk(fn, (n) => {
    if (found) return;
    const obj =
      ts.isPropertyAccessExpression(n) && n.name.text === 'areas'
        ? n.expression
        : ts.isElementAccessExpression(n) &&
            ts.isStringLiteralLike(n.argumentExpression) &&
            n.argumentExpression.text === 'areas'
          ? n.expression
          : null;
    if (obj && /limits$/i.test(unwrap(obj).getText())) found = true;
  });
  return found;
}

/** Whether function `fn` answers with the whole area list (returns it, a
 *  copy or a filter of it; a membership test on it is no answer). */
function answersAreaList(fn) {
  let found = false;
  walk(fn, (n) => {
    if (found || !ts.isIdentifier(n) || !AREA_LISTS.has(n.text)) return;
    // A membership test (`LIST.includes(x)`) asks, it does not answer.
    let top = n;
    while (top.parent && unwrap(top.parent) !== top.parent) top = top.parent;
    if (
      ts.isPropertyAccessExpression(top.parent) &&
      top.parent.expression === top &&
      top.parent.name.text === 'includes'
    ) {
      return;
    }
    for (let q = n.parent; q && q !== fn; q = q.parent) {
      if (ts.isReturnStatement(q) || (ts.isArrowFunction(fn) && q === fn.body)) {
        found = true;
        return;
      }
      if (ts.isArrowFunction(q) || ts.isFunctionExpression(q) || ts.isFunctionDeclaration(q))
        return;
    }
    if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) found = true;
  });
  return found;
}

/** The TypeScript functions of `text` that decide an Admin area
 *  themselves: one that reads a limits record's `areas`, one that answers
 *  the whole area list, and one with an `area` parameter that answers
 *  `<list>.includes(area)` over a list from such a function of its file
 *  (directly or through a function of the file that calls one). Returns
 *  their names. */
export function tsAreaRules(path, text) {
  if (!/\bareas\b|\bWORKSPACE_AREAS\b|\bSCOPE_AREAS\b/.test(text)) return [];
  const sf = parse(path, text);
  const fns = namedFunctions(sf);
  const rules = new Set(
    fns.filter((f) => readsLimitsAreas(f.node) || answersAreaList(f.node)).map((f) => f.name),
  );
  const decided = new Set(rules);
  // The functions of the file that call a rule, to a fixed point.
  const calls = (fn, names) => {
    let hit = false;
    walk(fn, (n) => {
      if (
        !hit &&
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        names.has(n.expression.text)
      ) {
        hit = true;
      }
    });
    return hit;
  };
  for (let grew = true; grew;) {
    grew = false;
    for (const f of fns) {
      if (!decided.has(f.name) && calls(f.node, decided)) {
        decided.add(f.name);
        grew = true;
      }
    }
  }
  for (const f of fns) {
    if (rules.has(f.name)) continue;
    const area = (f.node.parameters ?? []).some(
      (p) => ts.isIdentifier(p.name) && p.name.text === 'area',
    );
    if (!area || !calls(f.node, decided)) continue;
    let asks = false;
    walk(f.node, (n) => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === 'includes' &&
        n.arguments.length === 1 &&
        ts.isIdentifier(unwrap(n.arguments[0])) &&
        unwrap(n.arguments[0]).text === 'area'
      ) {
        asks = true;
      }
    });
    if (asks) rules.add(f.name);
  }
  return [...rules].sort();
}

// ── area and Admin asks after the gate ──────────────────────────────────────

/** The asks an in-handler check makes: each is a re-ask once the gate let
 *  the request in. */
export const IN_HANDLER_ASKS = Object.freeze([
  'scopeHasArea',
  'loginHasArea',
  'requireArea',
  'loginHoldsAdmin',
]);

/** The gates, which ask by design: the HTTP gate and the tool gate. */
export const AREA_GATES = Object.freeze([
  'server/web/lib/auth/session.ts',
  'packages/tools/src/admin-gate.ts',
]);

/** The call an expression makes when it is only a call of an ask
 *  (`ask(x)`, `await ask(x)`, `!ask(x)`, `db.ask(x)`), else null. */
function onlyAskCall(e, names) {
  for (;;) {
    e = unwrap(e);
    if (!e) return null;
    if (ts.isAwaitExpression(e)) e = e.expression;
    else if (ts.isPrefixUnaryExpression(e)) e = e.operand;
    else break;
  }
  if (!ts.isCallExpression(e)) return null;
  const callee = unwrap(e.expression);
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : null;
  return name && names.has(name) ? name : null;
}

/** Whether function-like `fn`'s whole body is one call of an ask (an arrow
 *  answering it, or a block of one return or expression statement of it):
 *  a wrapper that only renames the ask. */
function thinAskWrapper(fn, names) {
  const body = fn.body;
  if (!body) return null;
  if (!ts.isBlock(body)) return onlyAskCall(body, names);
  if (body.statements.length !== 1) return null;
  const st = body.statements[0];
  if (ts.isReturnStatement(st) && st.expression) return onlyAskCall(st.expression, names);
  if (ts.isExpressionStatement(st)) return onlyAskCall(st.expression, names);
  return null;
}

/** The name a function-like node goes by (its own, or the const it is
 *  bound to), and whether that is exported. */
function functionName(node) {
  const exported = (n) =>
    !!ts.getCombinedModifierFlags?.(n) &&
    (ts.getCombinedModifierFlags(n) & ts.ModifierFlags.Export) !== 0;
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) {
    return ts.isIdentifier(node.name) ? { name: node.name.text, exported: exported(node) } : null;
  }
  let p = node.parent;
  while (p && unwrap(p) !== p) p = p.parent;
  if (
    p &&
    ts.isVariableDeclaration(p) &&
    ts.isIdentifier(p.name) &&
    unwrap(p.initializer) === node
  ) {
    return { name: p.name.text, exported: exported(p) };
  }
  return null;
}

/** The thin wrappers of the asks in `text` (a named function whose whole
 *  body is one call of an ask, of `names`): `[{ name, exported, pos, end }]`.
 *  A callback (`.map((a) => ask(a))`) asks where it is, so only a named
 *  function wraps. */
export function thinAskWrappers(path, text, names) {
  if (![...names].some((n) => text.includes(n))) return [];
  const out = [];
  walk(parse(path, text), (node) => {
    if (
      !ts.isFunctionDeclaration(node) &&
      !ts.isMethodDeclaration(node) &&
      !ts.isArrowFunction(node) &&
      !ts.isFunctionExpression(node)
    ) {
      return;
    }
    const own = functionName(node);
    if (!own || names.has(own.name) || !thinAskWrapper(node, names)) return;
    out.push({ ...own, pos: node.body.pos, end: node.body.end });
  });
  return out;
}

/** The thin wrappers of every file, to a fixed point (a wrapper of a
 *  wrapper too): `{ global, local }`, the exported names and each file's
 *  own, and `bodies`, each file's wrapper bodies (the ask inside one is
 *  counted at the wrapper's uses instead). */
export function askWrappers(texts) {
  const global = new Set();
  const local = new Map();
  const bodies = new Map();
  const namesFor = (path) => new Set([...IN_HANDLER_ASKS, ...global, ...(local.get(path) ?? [])]);
  for (let grew = true, guard = 0; grew && guard < 8; guard += 1) {
    grew = false;
    for (const { path, text } of texts) {
      if (isTestSupport(path)) continue;
      for (const w of thinAskWrappers(path, text, namesFor(path))) {
        const set = w.exported ? global : (local.get(path) ?? new Set());
        if (!w.exported) local.set(path, set);
        if (!set.has(w.name)) {
          set.add(w.name);
          grew = true;
        }
        const b = bodies.get(path) ?? [];
        if (!b.some((x) => x.pos === w.pos)) b.push({ pos: w.pos, end: w.end });
        bodies.set(path, b);
      }
    }
  }
  return { global, local, bodies };
}

/** The asks of `text` (IN_HANDLER_ASKS, and the thin wrappers `wrappers`
 *  follows): every use of one of the names, a call or a callback, bare or
 *  a member (`db.loginHasArea`), but its own declaration, imports, exports
 *  and types, and the ask inside a thin wrapper (its uses count instead,
 *  so wrapping an ask never lowers the count). Returns `[{ name, line }]`.
 *  With `{ problems }`, also what would hide asks from the count: a name
 *  holding an ask (`const ask = scopeHasArea`, an assignment, an object
 *  property, `.bind`, `.call` or `.apply`), and an ask renamed (an import
 *  or export `as`, a renaming destructure), as as-system-exits.mjs reads
 *  a renamed asSystem. */
export function areaAsks(path, text, { problems = null, wrappers = null } = {}) {
  const names = new Set([
    ...IN_HANDLER_ASKS,
    ...(wrappers?.global ?? []),
    ...(wrappers?.local.get(path) ?? []),
  ]);
  if (![...names].some((n) => text.includes(n))) return [];
  const sf = parse(path, text);
  const inside = wrappers?.bodies.get(path) ?? [];
  const out = [];
  walk(sf, (node) => {
    if (!ts.isIdentifier(node) || !names.has(node.text)) return;
    const p = node.parent;
    // The ask under another name (`import { scopeHasArea as can }`, a
    // renaming export, `const { loginHasArea: can } = m`): its calls would
    // count 0, so it is a problem, and the rename itself is no ask.
    if (
      p &&
      (ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isBindingElement(p)) &&
      p.propertyName === node &&
      ts.isIdentifier(p.name) &&
      p.name.text !== node.text
    ) {
      problems?.push(
        `${path}:${lineOf(sf, node)}: ${node.text} is renamed (${p.name.text}), so the count misses its calls: call ${node.text} by its name`,
      );
      return;
    }
    if (
      !p ||
      ts.isImportSpecifier(p) ||
      ts.isImportClause(p) ||
      ts.isNamespaceImport(p) ||
      ts.isExportSpecifier(p) ||
      ts.isQualifiedName(p) ||
      ((ts.isFunctionDeclaration(p) ||
        ts.isVariableDeclaration(p) ||
        ts.isMethodDeclaration(p) ||
        ts.isPropertyAssignment(p) ||
        ts.isPropertySignature(p) ||
        ts.isBindingElement(p)) &&
        p.name === node)
    ) {
      return;
    }
    for (let q = p; q; q = q.parent) if (ts.isTypeNode(q)) return;
    if (inside.some((b) => node.pos >= b.pos && node.end <= b.end)) return;
    out.push({ name: node.text, line: lineOf(sf, node) });
    if (!problems) return;
    // The ask (or `db.ask`) as a value another name holds.
    let top = node;
    if (ts.isPropertyAccessExpression(p) && p.name === node) top = p;
    while (top.parent && unwrap(top.parent) !== top.parent) top = top.parent;
    const tp = top.parent;
    const held =
      (ts.isVariableDeclaration(tp) && tp.initializer === top) ||
      (ts.isBinaryExpression(tp) &&
        tp.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        tp.right === top) ||
      (ts.isPropertyAssignment(tp) && tp.initializer === top) ||
      ts.isShorthandPropertyAssignment(tp) ||
      (ts.isPropertyAccessExpression(tp) &&
        tp.expression === top &&
        ['bind', 'call', 'apply'].includes(tp.name.text));
    if (held) {
      problems.push(
        `${path}:${lineOf(sf, node)}: ${node.text} is held under another name, so the count misses its calls: call ${node.text} where it is asked`,
      );
    }
  });
  return out;
}

// ── the login type test ─────────────────────────────────────────────────────

/** The type test of the login's shape (plan v3.2 section 2.2: no `kind`,
 *  no `role`): the compiler holds its pin to the type. */
export const LOGIN_SHAPE_TEST = 'server/web/lib/auth/login-shape.test.ts';

/** The lines the pin is held by, whitespace aside: the login is the return
 *  of getLoginOr401, ShapeKeys reads every key of each shape and of the
 *  records it carries, Has asks them, and the pin's type is Has of each
 *  key. A test that loosens any of them (`kind: boolean`, a Login of its
 *  own) holds nothing, so the pin is not readable. */
const LOGIN_SHAPE_HELD = Object.freeze([
  'type Login = Exclude<Awaited<ReturnType<typeof getLoginOr401>>, NextResponse>;',
  'type KeysOf<T> = T extends unknown ? keyof T : never;',
  `type ShapeKeys<L> = L extends unknown
    ? | keyof L
      | {
          [K in Exclude<keyof L, 'actor'>]: L[K] extends object ? KeysOf<L[K]> : never;
        }[Exclude<keyof L, 'actor'>]
    : never;`,
  'type Has<K extends string> = K extends ShapeKeys<Login> ? true : false;',
  "export const LOGIN_SHAPE_PIN: { kind: Has<'kind'>; role: Has<'role'> } =",
]);

/** How many of `kind` and `role` the login type still has, as the type
 *  test pins it (LOGIN_SHAPE_PIN), or -1 when the pin is not readable (no
 *  literal, or a line that holds it to the type changed). */
export function loginShapePin(root, text = readRepoFile(root, LOGIN_SHAPE_TEST)) {
  const code = stripComments(text ?? '');
  const flat = code.replace(/\s+/g, ' ');
  const held = LOGIN_SHAPE_HELD.every((line) => flat.includes(line.replace(/\s+/g, ' ')));
  if (!held) return -1;
  if (!/import type \{ getLoginOr401 \} from '\.\/session';/.test(flat)) return -1;
  const m =
    /\bLOGIN_SHAPE_PIN\b[^=]*=\s*\{\s*kind:\s*(true|false)\s*,\s*role:\s*(true|false)\s*,?\s*\}/.exec(
      code,
    );
  if (!m) return -1;
  return (m[1] === 'true' ? 1 : 0) + (m[2] === 'true' ? 1 : 0);
}

// ── all of them ─────────────────────────────────────────────────────────────

/**
 * The Admin counts of the counted files' texts ([{ path, text }]):
 * `{ numbers, detail }`. The named role reads the plan moves in S8c
 * (mcp-auth.ts, pair-code.ts) are listed in detail.loginRoleDecisionReads.
 */
export function adminCounts(root, texts) {
  let wholeTools = 0;
  const acts = [];
  const kindBranches = {};
  const roleReads = {};
  const flags = {};
  const areaRules = {};
  const asks = {};
  const problems = [];
  const wrappers = askWrappers(texts);
  for (const { path, text } of texts) {
    if (isTestSupport(path)) continue;
    wholeTools += systemWholeTools(path, text);
    acts.push(...adminActRoutes(path, text));
    const k = Object.hasOwn(NOT_LOGIN_KIND, path) ? [] : loginFieldBranches(path, text, 'kind');
    if (k.length) kindBranches[path] = k;
    const r = loginFieldBranches(path, text, 'role', { drizzle: true });
    if (r.length) roleReads[path] = r;
    const f = adminDecisionFlags(path, text);
    if (f) flags[path] = f;
    const a = tsAreaRules(path, text);
    if (a.length) areaRules[path] = a;
    const x = areaAsks(path, text, { problems, wrappers });
    if (x.length && !AREA_GATES.includes(path)) asks[path] = x.map((y) => `${y.name}:${y.line}`);
  }
  const total = (o) => Object.values(o).reduce((s, v) => s + (Array.isArray(v) ? v.length : v), 0);
  return {
    numbers: {
      systemWholeTools: wholeTools,
      adminActRoutes: acts.length,
      loginKindBranches: total(kindBranches),
      loginRoleDecisionReads: total(roleReads),
      adminDecisionFlags: total(flags),
      tsAreaRules: total(areaRules),
      inHandlerAreaChecks: total(asks),
      inHandlerAreaCheckFiles: Object.keys(asks).length,
      loginTypeKindOrRole: loginShapePin(root),
    },
    detail: {
      adminActRoutes: acts,
      loginKindBranches: kindBranches,
      loginRoleDecisionReads: roleReads,
      adminDecisionFlags: flags,
      tsAreaRules: areaRules,
      inHandlerAreaChecks: asks,
    },
    problems,
  };
}

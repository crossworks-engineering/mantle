/**
 * The name lists of a file, read from its syntax tree (arch plan A10 #12 and
 * #13, low round): the sites where a list of names is written by hand, each
 * with its own string entries and its place. no-hand-kind-lists and
 * no-hand-role-lists (and the scoreboard counts in arch-counts.mjs) judge
 * the entries; this module only finds the lists. It parses with the
 * TypeScript parser (no type checker), so a list is found wherever it is
 * written, not only after the tokens a text scan knew:
 *
 *  - array: an array literal (`[...]` anywhere: after `of`, `&&`, `||`,
 *    `export default`, inside a spread, a call or a Set); its own entries
 *    are its string and plain template elements (a nested list, an object
 *    or a spread is not an entry of it). A tuple type of string literals.
 *  - union: a union type; its entries are its string literal members.
 *  - keys: an object literal or an object type; its entries are its plain
 *    keys (an identifier or a string, not a computed key). `dispatch` when
 *    every member is a function: a table of behaviour per name.
 *  - chain: a comparison chain on one subject joined by `||` or `&&`
 *    (`r === 'admin' || r === 'member'`, `a?.role !== 'x' && a?.role !==
 *    'y'`, `f(x) === 'a' || f(x) === 'b'`); the subject is compared by its
 *    text, the literal may stand on either side.
 *  - switch: the cases of a switch that share one body (`case 'a': case
 *    'b': return true`). Cases with bodies of their own are behaviour per
 *    name, not a list.
 *  - sql: a SQL `in ('a', 'b')` or `array['a', 'b']` inside a string or a
 *    template, its entries all quoted literals.
 *
 * Comments are not code, so they never count.
 */
import ts from 'typescript';

/** @param {string} path @param {string} text */
function parse(path, text) {
  const kind = path.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : /\.[cm]?js$/.test(path)
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
}

/** A string or plain template literal's value, else null. */
function stringOf(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/** `node` without parentheses, `as`, `satisfies` and `!`. */
function bare(node) {
  let n = node;
  while (
    n &&
    (ts.isParenthesizedExpression(n) ||
      ts.isAsExpression(n) ||
      ts.isNonNullExpression(n) ||
      (ts.isSatisfiesExpression && ts.isSatisfiesExpression(n)))
  ) {
    n = n.expression;
  }
  return n;
}

const LOGICAL = new Set([ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken]);
const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

function isLogical(node) {
  const n = bare(node);
  return !!n && ts.isBinaryExpression(n) && LOGICAL.has(n.operatorToken.kind);
}

/** The leaves of a logical chain (through `||`, `&&` and parentheses). */
function chainLeaves(node, out = []) {
  const n = bare(node);
  if (isLogical(n)) {
    chainLeaves(n.left, out);
    chainLeaves(n.right, out);
  } else out.push(n);
  return out;
}

/** A comparison leaf `S op 'lit'` (either side): { subject, value }, else
 *  null. A `typeof x` subject is a type test, not a name. */
function comparison(leaf, sf) {
  if (!ts.isBinaryExpression(leaf) || !EQUALITY.has(leaf.operatorToken.kind)) return null;
  const l = bare(leaf.left);
  const r = bare(leaf.right);
  const lv = stringOf(l);
  const rv = stringOf(r);
  const [subject, value] =
    rv !== null && lv === null ? [l, rv] : lv !== null && rv === null ? [r, lv] : [];
  if (!subject || ts.isTypeOfExpression(subject)) return null;
  return { subject: subject.getText(sf).replace(/\s+/g, ''), value };
}

/** A SQL list in `text`: `in ( 'a', 'b' )` or `array[ 'a', 'b' ]`, all of
 *  its items quoted literals. Each as its items and its offset. */
const SQL_LIST = /\b(?:in\s*\(([^()]*)\)|array\s*\[([^[\]]*)\])/gi;
const SQL_ITEMS = /^\s*'[^'\n]*'(?:\s*,\s*'[^'\n]*')*\s*$/;
function sqlLists(text) {
  const out = [];
  for (const m of text.matchAll(SQL_LIST)) {
    const body = m[1] ?? m[2];
    if (!SQL_ITEMS.test(body)) continue;
    out.push({
      strings: [...body.matchAll(/'([^'\n]*)'/g)].map((x) => x[1]),
      at: m.index,
      len: m[0].length,
    });
  }
  return out;
}

/** Whether an object member is a function (a method, or a property whose
 *  value or type is one). */
function isFunctionMember(m) {
  if (ts.isMethodDeclaration(m) || ts.isMethodSignature(m)) return true;
  if (ts.isPropertyAssignment(m)) {
    const v = bare(m.initializer);
    return ts.isArrowFunction(v) || ts.isFunctionExpression(v);
  }
  if (ts.isPropertySignature(m)) return !!m.type && ts.isFunctionTypeNode(m.type);
  return false;
}

/** The plain key of a property or member, else null. */
function keyOf(member) {
  const name = member.name;
  if (!name || ts.isComputedPropertyName(name)) return null;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier?.(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return null;
}

/**
 * The name list sites of one file: `{ form, strings, start, end }`, start
 * and end as `{ line, column }` (line 1-based, column 0-based, as ESLint
 * reports them).
 */
export function nameListSites(path, text) {
  const sf = parse(path, text);
  const out = [];
  const at = (pos) => {
    const p = sf.getLineAndCharacterOfPosition(pos);
    return { line: p.line + 1, column: p.character };
  };
  const push = (form, strings, from, to) => {
    if (strings.length) out.push({ form, strings, start: at(from), end: at(to) });
  };
  const visit = (node) => {
    if (ts.isArrayLiteralExpression(node)) {
      const own = node.elements.map(stringOf).filter((s) => s !== null);
      push('array', own, node.getStart(sf), node.end);
    } else if (ts.isTupleTypeNode(node)) {
      const own = node.elements
        .map((e) => (ts.isLiteralTypeNode(e) ? stringOf(e.literal) : null))
        .filter((s) => s !== null);
      push('array', own, node.getStart(sf), node.end);
    } else if (ts.isUnionTypeNode(node)) {
      const own = node.types
        .map((t) => (ts.isLiteralTypeNode(t) ? stringOf(t.literal) : null))
        .filter((s) => s !== null);
      push('union', own, node.getStart(sf), node.end);
    } else if (ts.isObjectLiteralExpression(node) || ts.isTypeLiteralNode(node)) {
      const members = ts.isObjectLiteralExpression(node) ? node.properties : node.members;
      const own = members.map(keyOf).filter((s) => s !== null);
      push('keys', own, node.getStart(sf), node.end);
      if (own.length) out[out.length - 1].dispatch = members.every(isFunctionMember);
    } else if (
      ts.isBinaryExpression(node) &&
      LOGICAL.has(node.operatorToken.kind) &&
      isChainTop(node)
    ) {
      const groups = new Map();
      for (const leaf of chainLeaves(node)) {
        const c = comparison(leaf, sf);
        if (!c) continue;
        if (!groups.has(c.subject)) groups.set(c.subject, []);
        groups.get(c.subject).push(c.value);
      }
      for (const values of groups.values()) {
        if (values.length >= 2) push('chain', values, node.getStart(sf), node.end);
      }
    } else if (ts.isCaseBlock(node)) {
      let group = [];
      let from = -1;
      for (const clause of node.clauses) {
        if (ts.isCaseClause(clause)) {
          const v = stringOf(bare(clause.expression));
          if (v !== null) {
            if (from < 0) from = clause.getStart(sf);
            group.push(v);
          }
        }
        if (clause.statements.length) {
          if (group.length >= 2) push('switch', group, from, clause.end);
          group = [];
          from = -1;
        }
      }
      if (group.length >= 2) push('switch', group, from, node.end);
    }
    // SQL inside a string or a template, part by part (a list split by a
    // `${...}` is not all quoted literals).
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const start = node.getStart(sf);
      for (const l of sqlLists(node.getText(sf))) {
        push('sql', l.strings, start + l.at, start + l.at + l.len);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Whether the logical expression `node` is the top of its chain: the
 *  first ancestor beyond parentheses is no `||` or `&&` (a chain is read
 *  once, from its top). */
function isChainTop(node) {
  let p = node.parent;
  while (p && ts.isParenthesizedExpression(p)) p = p.parent;
  return !(p && ts.isBinaryExpression(p) && LOGICAL.has(p.operatorToken.kind));
}

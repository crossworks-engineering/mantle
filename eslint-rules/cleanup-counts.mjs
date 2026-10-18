/**
 * Two cleanup counts of the scoreboard, in count mode until their lints
 * exist (plan v3.2 sections 3.2 and 4.3). Read by arch-counts.mjs
 * measure(), pinned in scripts/arch-scoreboard.pins.json, tested in
 * cleanup-counts.test.ts.
 *
 *  - raw write SQL in scoped code: SQL text the code writes by hand that
 *    inserts, updates, deletes, merges or truncates, where a typed drizzle
 *    write or a definer call would let the database route it;
 *  - history codes in code comments: provenance a comment carries (fix
 *    rounds, audit finding codes, step codes next to a provenance word or
 *    named in the history file's headings) instead of the why.
 *
 * Syntax trees (the TypeScript parser): a string is never a comment, a
 * comment is never SQL.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { readRepoFile } from './arch-counts.mjs';
import { parse } from './as-system-exits.mjs';

const lineOf = (sf, pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;

function isTestSupport(path) {
  return /(^|\/)test-support(\/|\.ts$)/.test(path);
}

// ── raw write SQL ───────────────────────────────────────────────────────────

/** The SQL tags: `<tag>.raw(text)` is SQL text (a tagged template is read
 *  whatever its tag), and a name holding one is a tag too (sqlTagNames). */
export const SQL_TAGS = Object.freeze(['sql', 'sqlTag']);

/** Where the rule applies: product code under packages/<name>/src and
 *  server/. */
export function rawWriteSwept(path) {
  return /^packages\/[^/]+\/src\//.test(path) || path.startsWith('server/');
}

/** SQL `text` with `--` and block comments blanked. */
function dropSqlComments(text) {
  return text.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
}

const WRITE_START = /^(insert|update|delete|merge|truncate)\b/i;
const WRITE_CTE = /\bas\s*(?:not\s+)?(?:materialized\s+)?\(\s*(insert|update|delete|merge)\b/i;

/** The statement after a leading WITH and its CTEs, or the text itself. */
function afterWith(sql) {
  let t = sql.trim();
  const w = /^with\s+(?:recursive\s+)?/i.exec(t);
  if (!w) return t;
  t = t.slice(w[0].length);
  for (let guard = 0; guard < 64; guard += 1) {
    const head =
      /^"?[A-Za-z_][\w$]*"?\s*(?:\([^)]*\)\s*)?as\s+(?:(?:not\s+)?materialized\s+)?\(/i.exec(t);
    if (!head) return t;
    let depth = 0;
    let i = head[0].length - 1;
    for (; i < t.length; i += 1) {
      if (t[i] === '(') depth += 1;
      else if (t[i] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    t = t.slice(i + 1).trim();
    if (t.startsWith(',')) t = t.slice(1).trim();
    else return t;
  }
  return t;
}

/** Why the static SQL `text` is a raw write ('write' or 'write-cte'), or
 *  null for a read (FOR UPDATE included) or a definer call. A template's
 *  leading placeholders (`${TAG} insert ...`, a tag comment before the
 *  statement) are skipped. */
export function rawWriteKind(text) {
  const sql = afterLeadingPlaceholders(text);
  if (WRITE_START.test(afterWith(sql))) return 'write';
  if (WRITE_CTE.test(sql)) return 'write-cte';
  return null;
}

/** The static text of a template (its literal parts, each `${}` a
 *  placeholder). */
function templateText(tpl) {
  if (ts.isNoSubstitutionTemplateLiteral(tpl)) return tpl.text;
  return [tpl.head.text, ...tpl.templateSpans.map((s) => s.literal.text)].join(' $1 ');
}

/** A statement's first word: a template is SQL text the code holds only
 *  when its static text, after any leading placeholders (and an opening
 *  parenthesis), starts with one. Else its SQL is in the placeholders
 *  (`${stmt}`, `${a}; select 1`, `${'insert'} into t`, a fragment such as
 *  `array[...]::text[]`), so it is no literal. */
const STATEMENT_START =
  /^\(*\s*(?:select|insert|update|delete|merge|truncate|with|values|table|create|alter|drop|grant|revoke|set|reset|show|lock|copy|call|do|explain|begin|start|commit|end|rollback|abort|savepoint|release|listen|unlisten|notify|vacuum|analyze|refresh|reindex|cluster|comment|declare|fetch|move|close|discard|prepare|execute|deallocate)\b/i;

/** The static text of a template after its leading placeholders. */
function afterLeadingPlaceholders(text) {
  return dropSqlComments(text).replace(/^\s*(?:\$1\s*)+/, '');
}

/** Whether `e` is SQL text the code holds as a literal (a string, or a
 *  template whose static text starts a statement), or null. */
function literalText(e) {
  if (ts.isStringLiteralLike(e)) return e.text;
  if (ts.isTemplateExpression(e)) {
    const t = templateText(e);
    return STATEMENT_START.test(afterLeadingPlaceholders(t).trimStart()) ? t : null;
  }
  return null;
}

/** The names of `sf` that are a SQL tag under another name: an import
 *  renaming `sql`, a local holding a tag (`const q = sql`, `q = sql`), and
 *  the transaction handle a tag's callback gets (`sql.begin(async (tx) =>
 *  ...)`, `.savepoint`, `.reserve`, `.transaction`), to a fixed point. */
function sqlTagNames(sf) {
  const tags = new Set(SQL_TAGS);
  const isTag = (e) => {
    while (
      e &&
      (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e))
    )
      e = e.expression;
    return !!e && ts.isIdentifier(e) && tags.has(e.text);
  };
  for (let grew = true, guard = 0; grew && guard < 8; guard += 1) {
    grew = false;
    const add = (name) => {
      if (!tags.has(name)) {
        tags.add(name);
        grew = true;
      }
    };
    const visit = (node) => {
      if (
        ts.isImportSpecifier(node) &&
        (node.propertyName ?? node.name).text === 'sql' &&
        node.name.text !== 'sql'
      ) {
        add(node.name.text);
      } else if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        isTag(node.initializer)
      ) {
        add(node.name.text);
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) &&
        isTag(node.right)
      ) {
        add(node.left.text);
      } else if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ['begin', 'savepoint', 'reserve', 'transaction'].includes(node.expression.name.text) &&
        isTag(node.expression.expression)
      ) {
        for (const arg of node.arguments) {
          if ((ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) && arg.parameters[0]) {
            const p = arg.parameters[0].name;
            if (ts.isIdentifier(p)) add(p.text);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return tags;
}

/** `e` without parentheses, `as`, `!` and `.bind(...)`. */
function unwrapExpr(e) {
  for (;;) {
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) {
      e = e.expression;
    } else if (
      ts.isCallExpression(e) &&
      memberOf(e.expression)?.name === 'bind' &&
      memberOf(e.expression).object
    ) {
      e = memberOf(e.expression).object;
    } else {
      return e;
    }
  }
}

/** A member read: `{ object, name }` of `o.name` or `o['name']` (a literal
 *  key), else null. */
function memberOf(e) {
  if (ts.isPropertyAccessExpression(e)) return { object: e.expression, name: e.name.text };
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) {
    return { object: e.expression, name: e.argumentExpression.text };
  }
  return null;
}

/** Whether the member read takes SQL text: `.unsafe` on anything, `.raw`
 *  on a SQL tag (the dot or a literal key): a tag's name, or a member whose
 *  last name is one (`this.sql.raw`, `deps.sql.raw`). */
function isTextMethod(member, tags) {
  if (member.name === 'unsafe') return true;
  if (member.name !== 'raw') return false;
  const o = unwrapExpr(member.object);
  if (ts.isIdentifier(o)) return tags.has(o.text);
  const last = memberOf(o);
  return !!last && tags.has(last.name);
}

/** The names of `sf` that hold a text method under another name: `const
 *  raw = sql.raw`, `const u = pg['unsafe'].bind(pg)`, an assignment, a
 *  destructure (`const { raw } = sql`, `const { unsafe: u } = pg`), and a
 *  name holding one of those (`const r2 = raw`), to a fixed point. */
function textCallNames(sf, tags) {
  const names = new Set();
  const holds = (e) => {
    e = unwrapExpr(e);
    if (ts.isIdentifier(e)) return names.has(e.text);
    const m = memberOf(e);
    return !!m && isTextMethod(m, tags);
  };
  for (let grew = true, guard = 0; grew && guard < 8; guard += 1) {
    grew = false;
    const add = (name) => {
      if (!names.has(name)) {
        names.add(name);
        grew = true;
      }
    };
    const visit = (node) => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        if (ts.isIdentifier(node.name) && holds(node.initializer)) add(node.name.text);
        if (ts.isObjectBindingPattern(node.name)) {
          const from = unwrapExpr(node.initializer);
          for (const el of node.name.elements) {
            const key = el.propertyName ?? el.name;
            if (!ts.isIdentifier(key) || !ts.isIdentifier(el.name)) continue;
            if (isTextMethod({ object: from, name: key.text }, tags)) add(el.name.text);
          }
        }
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) &&
        holds(node.right)
      ) {
        add(node.left.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return names;
}

/**
 * The raw write SQL of `text`: `[{ line, why }]`. Any tagged template whose
 * static text is a write (a tag's alias, a transaction handle or a
 * parameter that holds the tag reads the same text); `.unsafe(text)`,
 * `<tag>.raw(text)` and `.execute(text)` with literal text that is a
 * write; and `.unsafe(x)` or `<tag>.raw(x)` with text that is no literal
 * (`why: 'non-literal'`; a template whose static text does not start a
 * statement, such as `${stmt}` or `${a}; select 1`, is none), unless wrapped in `readSql(...)`. The text
 * methods read the same under a literal key (`pg['unsafe'](x)`) and under
 * another name (`const raw = sql.raw`, `const { unsafe } = pg`,
 * textCallNames). A tag is a SQL
 * tag (SQL_TAGS) or a name holding one (sqlTagNames). `.execute(x)` of a
 * built query is not text (drizzle's execute takes the SQL a tag built,
 * which is read where it is built). Not findings: reads, definer calls
 * (`select "public"."mantle_x"(...)`), drizzle typed writes.
 */
export function rawWriteSqlSites(path, text) {
  if (!/\b(?:insert|update|delete|merge|truncate|unsafe|raw)\b/i.test(text)) return [];
  const sf = parse(path, text);
  const tags = sqlTagNames(sf);
  const textNames = textCallNames(sf, tags);
  const out = [];
  const visit = (node) => {
    if (ts.isTaggedTemplateExpression(node)) {
      // The tag's name never matters: write SQL text in a template is the
      // write, whichever name holds the tag.
      const why = rawWriteKind(templateText(node.template));
      if (why) out.push({ line: lineOf(sf, node.getStart(sf)), why });
    } else if (ts.isCallExpression(node)) {
      const callee = unwrapExpr(node.expression);
      const member = memberOf(callee);
      const m = member?.name ?? null;
      const arg = node.arguments[0];
      const textCall = member
        ? isTextMethod(member, tags)
        : ts.isIdentifier(callee) && textNames.has(callee.text);
      if (arg && (textCall || m === 'execute')) {
        const lit = literalText(arg);
        const wrapped =
          ts.isCallExpression(arg) &&
          ts.isIdentifier(arg.expression) &&
          arg.expression.text === 'readSql';
        if (lit !== null) {
          const why = rawWriteKind(lit);
          if (why) out.push({ line: lineOf(sf, node.getStart(sf)), why });
        } else if (textCall && !wrapped) {
          out.push({ line: lineOf(sf, node.getStart(sf)), why: 'non-literal' });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** The files of the raw write allowlist (eslint-rules/raw-write-allowlist.mjs,
 *  made with the lint; none until then). */
function rawWriteAllowed(root) {
  const text = readRepoFile(root, 'eslint-rules/raw-write-allowlist.mjs');
  if (text === null) return new Set();
  return new Set([...text.matchAll(/^\s*['"]([^'"\n]+)['"]\s*:/gm)].map((m) => m[1]));
}

// ── history codes in comments ───────────────────────────────────────────────

/** The always-findings: a fix round, a round code, an audit finding code.
 *  A bare `round N` counts only in a finding's shape: closed by punctuation
 *  (`round 3, H1`, `(round 2)`, `round 4:`, `"round 3"`) or with a finding
 *  code after it (`round 1 M1`, `round 2 L7`), so `round 2 decimals` is no
 *  history. */
const HISTORY_WORDS =
  /fix round|\bround (?:[0-9]{1,2}[A-Za-z]?|[A-Z])(?=\s*[,):;"']|\s*$|\.(?:\s|$)|\s+[A-Z]-?[0-9]{1,2}\b)|\baudit [HLMN][0-9]+\b/gi;
/** A code in a comment: a letter, a number, and its sub-step letters and
 *  numbers (A4, R0, D1, P1a, A2b1, A2b2b, W5b2). Case-sensitive. */
const CODE = /\b[A-Z][0-9]{1,2}(?:[a-z][0-9]?)*\b/g;
/** A step code of the arch and workspaces plans (A, W, F): a finding next to
 *  a provenance word. */
const STEP_SHAPE = /^[AWF][0-9]{1,2}(?:[a-z][0-9]?)*$/;
/** The provenance words a step code is a finding next to. */
const PROVENANCE = String.raw`(?:arch|phase|plan|step|part|hand batch|integration|fix|audit|round)`;
/** A sheet or formula comment, where a bare A1 is a cell. Sheet words only:
 *  a row, a column or a range is a database's too. */
const SHEET_WORDS = /\b(?:sheet|sheets|formula|formulas|cell|cells|xlsx|excel|spreadsheet)\b/i;
/** A code that can be a cell reference (a letter and a number). */
const CELL_SHAPE = /^[A-Z][0-9]{1,2}$/;

/**
 * Codes that are not history where they stand, each with why (reviewed):
 * the line is matched with the code in place. A code here never counts on
 * such a line, by either path.
 */
export const HISTORY_CODE_STOPLIST = Object.freeze([
  {
    code: 'S3',
    why: 'the object-store service (an S3 backend, S3-compatible, plain S3 calls), not plan v3 S3',
    line: /object[- ]?store|\bbuckets?\b|\bbackend\b|\bendpoint\b|\bS3[- ](?:compatible|client|calls?|stores?|CreateBucket)\b|\b(?:any|other|another|external|plain|self-hosted) S3\b/i,
  },
  { code: 'A4', why: 'the paper size', line: /\bA4 (?:paper|pages?|sheets?|size)\b/i },
  {
    code: 'A8',
    why: "the access matrix suite's own name (A8 matrix, A8 grid, A8 cells, A8 report, A8 exempt, A8 tool cells)",
    // A finding of the suite after its name (A8 matrix F9) is history.
    line: /\bA8 (?:matrix|grid|cell|cells|report|exempt|tool cells)\b(?! [A-Z][0-9])/,
  },
  {
    code: 'Dn',
    why: "an owner decision's label (owner decision D1, the owner's decisions D4 to D6), not a plan step",
    // Read where the code stands: the words just before it, a list of
    // labels between (`owner decisions D4, D5 and D6`).
    before:
      /\bowner(?:'s)? decisions?\s+(?:D[0-9]{1,2}\s*(?:,\s*|\band\s+|\bor\s+|\bto\s+|-\s*))*$/i,
  },
]);

/** Whether a stoplist entry's code is `code` (`Dn`: any D and a number). */
const stopCode = (s, code) => (s.code === 'Dn' ? /^D[0-9]{1,2}$/.test(code) : s.code === code);

/** Whether `code` at `index` of `line` is a stoplisted use
 *  (HISTORY_CODE_STOPLIST): the entry's `line` matches the line, or its
 *  `before` the text before the code. */
function stoplisted(code, line, path, index = 0) {
  if (code === 'S3' && /^packages\/storage\//.test(path ?? '')) return true;
  return HISTORY_CODE_STOPLIST.some(
    (s) =>
      stopCode(s, code) &&
      ((s.line && s.line.test(line)) || (s.before && s.before.test(line.slice(0, index)))),
  );
}

/** The history files whose headings name the codes: the history of the
 *  spec, and each plan v3 step's handover. */
function historyFiles(root) {
  const archive = 'docs/_archive';
  let names;
  try {
    names = readdirSync(join(root, archive));
  } catch {
    names = [];
  }
  return [
    `${archive}/actors-history.md`,
    ...names
      .filter((n) => /^plan-v3-.+-handover\.md$/.test(n))
      .sort()
      .map((n) => `${archive}/${n}`),
  ];
}

/** The codes named in the history files' headings (docs/_archive/
 *  actors-history.md and docs/_archive/plan-v3-*-handover.md), any letter
 *  (R0, D1, S3, P1a, A2b1, A2b2b), each with the first file that names it;
 *  a `#` line in a fenced code block is no heading. `openFences`, when
 *  given, gets each file whose last fence is never closed.
 *  Read only to check the frozen list (headingCodeProblems); the count
 *  reads HISTORY_HEADING_CODES. */
export function historyHeadingCodes(root, { openFences = null } = {}) {
  const codes = new Map();
  for (const file of historyFiles(root)) {
    const text = readRepoFile(root, file) ?? '';
    // A `#` line inside a fenced block (``` or ~~~) is code, no heading.
    let fence = null;
    for (const line of text.split('\n')) {
      const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (f) {
        if (fence === null) fence = f[1];
        else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
        continue;
      }
      if (fence !== null || !/^#{1,6}\s/.test(line)) continue;
      for (const m of line.matchAll(CODE)) if (!codes.has(m[0])) codes.set(m[0], file);
    }
    if (fence !== null) openFences?.push(file);
  }
  return codes;
}

/**
 * The step codes a comment holds as history wherever it names them, but in
 * a sheet comment (a cell) and where the stoplist says it is no step:
 * frozen and reviewed. They are the codes the history files' headings name
 * (historyHeadingCodes) less HEADING_CODES_LEFT_OUT. A heading code in
 * neither list is a problem that fails arch:check, so a new handover's
 * heading never moves the count unreviewed: add its code to one of them.
 */
export const HISTORY_HEADING_CODES = Object.freeze([
  'A10',
  'A2b',
  'A2b1',
  'A2b2a',
  'A2b2b',
  'A3a',
  'A3b',
  'A3c',
  'A4',
  'A5',
  'A6',
  'A6b',
  'A7',
  'A8',
  'F4',
  'P1a',
  'P1b',
  'R0',
  'S11a',
  'S12',
  'S2a',
  'S3',
  'S4a',
]);

/** Heading codes that do not count by name, each with why. Next to a
 *  provenance word a step-shaped code (A, W, F) still counts. Review-gated:
 *  an entry here (or one taken off HISTORY_HEADING_CODES, or a stoplist
 *  entry) lowers historyCodeComments, so it is reviewed like a pin. */
export const HEADING_CODES_LEFT_OUT = Object.freeze({
  D1: 'plan v3.2 D1 (the spec cut) shares its label with owner decision D1 and the D findings of the apps audit, the apps plan and plan v2 (D1 to D8); no counted comment names the step, each D1 there is a decision or a finding',
});

/** Each heading code in neither HISTORY_HEADING_CODES nor
 *  HEADING_CODES_LEFT_OUT, with the file whose heading names it, and each
 *  history file that ends inside a fenced block. */
export function headingCodeProblems(root) {
  const out = [];
  const openFences = [];
  for (const [code, file] of historyHeadingCodes(root, { openFences })) {
    if (HISTORY_HEADING_CODES.includes(code) || Object.hasOwn(HEADING_CODES_LEFT_OUT, code))
      continue;
    out.push(
      `heading code ${code} (${file}) is in neither HISTORY_HEADING_CODES nor HEADING_CODES_LEFT_OUT (eslint-rules/cleanup-counts.mjs); add it to one, with why if left out`,
    );
  }
  for (const file of openFences) {
    out.push(
      `${file} ends inside a fenced code block, so no heading after its last fence is read: close the fence`,
    );
  }
  return out;
}

/** The history findings of one comment's text (its lines): the line
 *  offsets within the comment that hold one. `path` picks the file-wide
 *  stoplist entries (the storage package's S3). */
export function historyFindings(comment, codes, { sheet = false, path = '' } = {}) {
  const lines = comment.split('\n');
  const hits = [];
  lines.forEach((line, i) => {
    HISTORY_WORDS.lastIndex = 0;
    if (HISTORY_WORDS.test(line)) {
      hits.push(i);
      return;
    }
    // A cell reference: a cell-shaped code in a sheet file or on a line
    // that says sheet, formula or cell. Next to a provenance word only the
    // line's own sheet words make it a cell (a sheet file's `A10 part 2` is
    // the step).
    const sheetLine = SHEET_WORDS.test(line);
    for (const m of line.matchAll(CODE)) {
      if (stoplisted(m[0], line, path, m.index)) continue;
      const cell = CELL_SHAPE.test(m[0]);
      const before = line.slice(0, m.index);
      const after = line.slice(m.index + m[0].length);
      const near =
        STEP_SHAPE.test(m[0]) &&
        !(cell && sheetLine) &&
        (new RegExp(String.raw`\b${PROVENANCE}\b[\s,:;()-]*(?:[\w.]+[\s,:;()-]+)?$`, 'i').test(
          before,
        ) ||
          new RegExp(String.raw`^[\s,:;()-]*(?:[\w.]+[\s,:;()-]+)?${PROVENANCE}\b`, 'i').test(
            after,
          ));
      if (near || (codes.has(m[0]) && !(cell && (sheet || sheetLine)))) {
        hits.push(i);
        return;
      }
    }
  });
  return hits;
}

/** The comments of `sf`: `[{ pos, text }]`, each once. */
function commentsOf(sf) {
  const text = sf.getFullText();
  const seen = new Map();
  const add = (ranges) => {
    for (const r of ranges ?? []) if (!seen.has(r.pos)) seen.set(r.pos, text.slice(r.pos, r.end));
  };
  const visit = (node) => {
    add(ts.getLeadingCommentRanges(text, node.getFullStart()));
    add(ts.getTrailingCommentRanges(text, node.getEnd()));
    ts.forEachChild(node, visit);
  };
  visit(sf);
  add(ts.getLeadingCommentRanges(text, sf.endOfFileToken.getFullStart()));
  return [...seen].map(([pos, t]) => ({ pos, text: t }));
}

/** The comment lines of `text` with a history finding: their line
 *  numbers. */
export function historyCommentLines(path, text, codes) {
  HISTORY_WORDS.lastIndex = 0;
  if (!HISTORY_WORDS.test(text) && !/\b[A-Z][0-9]/.test(text)) return [];
  const sf = parse(path, text);
  const sheet = /sheet|formula|xlsx|tabledb/i.test(path);
  const out = new Set();
  for (const c of commentsOf(sf)) {
    const first = lineOf(sf, c.pos);
    for (const i of historyFindings(c.text, codes, { sheet, path })) out.add(first + i);
  }
  return [...out].sort((a, b) => a - b);
}

/** The package or tier a path is in (`packages/db`, `server/web`, `scripts`):
 *  what the comment lint pins by. */
function laneOf(path) {
  const m = /^(packages\/[^/]+|server\/[^/]+)/.exec(path);
  return m ? m[1] : path.split('/')[0];
}

// ── all of them ─────────────────────────────────────────────────────────────

/** The cleanup counts of the counted files ([{ path, text }]). */
export function cleanupCounts(root, texts) {
  const allowed = rawWriteAllowed(root);
  const codes = new Set(HISTORY_HEADING_CODES);
  const rawWrites = {};
  const history = {};
  for (const { path, text } of texts) {
    if (isTestSupport(path)) continue;
    if (rawWriteSwept(path) && !allowed.has(path)) {
      const sites = rawWriteSqlSites(path, text);
      if (sites.length) rawWrites[path] = sites.map((s) => `${s.line}:${s.why}`);
    }
    const lines = historyCommentLines(path, text, codes);
    if (lines.length) {
      const lane = laneOf(path);
      history[lane] = (history[lane] ?? 0) + lines.length;
    }
  }
  const total = (o) => Object.values(o).reduce((s, v) => s + (Array.isArray(v) ? v.length : v), 0);
  const sites = Object.values(rawWrites).flat();
  const nonLiteral = sites.filter((x) => x.endsWith(':non-literal')).length;
  return {
    numbers: {
      rawWriteSqlScoped: sites.length - nonLiteral,
      rawSqlNonLiteral: nonLiteral,
      rawWriteSqlFiles: Object.keys(rawWrites).length,
      historyCodeComments: total(history),
    },
    detail: {
      rawWriteSql: rawWrites,
      historyCodeComments: history,
      problems: headingCodeProblems(root),
    },
  };
}

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
 *  null for a read (FOR UPDATE included) or a definer call. */
export function rawWriteKind(text) {
  const sql = dropSqlComments(text);
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

/** Whether `e` is SQL text the code holds as a literal (a string, a
 *  template, or `readSql(...)`, the reviewed read). */
function literalText(e) {
  if (ts.isStringLiteralLike(e)) return e.text;
  if (ts.isTemplateExpression(e)) return templateText(e);
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

/**
 * The raw write SQL of `text`: `[{ line, why }]`. Any tagged template whose
 * static text is a write (a tag's alias, a transaction handle or a
 * parameter that holds the tag reads the same text); `.unsafe(text)`,
 * `<tag>.raw(text)` and `.execute(text)` with literal text that is a
 * write; and `.unsafe(x)` or `<tag>.raw(x)` with text that is no literal
 * (`why: 'non-literal'`), unless wrapped in `readSql(...)`. A tag is a SQL
 * tag (SQL_TAGS) or a name holding one (sqlTagNames). `.execute(x)` of a
 * built query is not text (drizzle's execute takes the SQL a tag built,
 * which is read where it is built). Not findings: reads, definer calls
 * (`select "public"."mantle_x"(...)`), drizzle typed writes.
 */
export function rawWriteSqlSites(path, text) {
  if (!/\b(?:insert|update|delete|merge|truncate|unsafe|raw)\b/i.test(text)) return [];
  const sf = parse(path, text);
  const tags = sqlTagNames(sf);
  const out = [];
  const visit = (node) => {
    if (ts.isTaggedTemplateExpression(node)) {
      // The tag's name never matters: write SQL text in a template is the
      // write, whichever name holds the tag.
      const why = rawWriteKind(templateText(node.template));
      if (why) out.push({ line: lineOf(sf, node.getStart(sf)), why });
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const m = node.expression.name.text;
      const arg = node.arguments[0];
      const textCall =
        m === 'unsafe' ||
        (m === 'raw' &&
          ts.isIdentifier(node.expression.expression) &&
          tags.has(node.expression.expression.text));
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
]);

/** Whether `code` on `line` is a stoplisted use (HISTORY_CODE_STOPLIST). */
function stoplisted(code, line, path) {
  if (code === 'S3' && /^packages\/storage\//.test(path ?? '')) return true;
  return HISTORY_CODE_STOPLIST.some((s) => s.code === code && s.line.test(line));
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
 *  (R0, D1, S3, P1a, A2b1, A2b2b): each is a finding wherever it is, but in a
 *  sheet comment (a cell) and where the stoplist says it is no step. */
export function historyHeadingCodes(root) {
  const codes = new Set();
  for (const file of historyFiles(root)) {
    const text = readRepoFile(root, file) ?? '';
    for (const line of text.split('\n')) {
      if (!/^#{1,6}\s/.test(line)) continue;
      for (const m of line.matchAll(CODE)) codes.add(m[0]);
    }
  }
  return codes;
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
      if (stoplisted(m[0], line, path)) continue;
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
  const codes = historyHeadingCodes(root);
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
    detail: { rawWriteSql: rawWrites, historyCodeComments: history },
  };
}

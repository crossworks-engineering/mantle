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
import ts from 'typescript';
import { readRepoFile } from './arch-counts.mjs';
import { parse } from './as-system-exits.mjs';

const lineOf = (sf, pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;

function isTestSupport(path) {
  return /(^|\/)test-support(\/|\.ts$)/.test(path);
}

// ── raw write SQL ───────────────────────────────────────────────────────────

/** The SQL tags: a tagged template of one of these names is SQL text. */
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

/**
 * The raw write SQL of `text`: `[{ line, why }]`. A tagged template of a
 * SQL tag (SQL_TAGS, or a local name an import gives `sql`) whose static
 * text is a write; `.unsafe(text)`, `sql.raw(text)` and `.execute(text)`
 * with literal text that is a write; and `.unsafe(x)` or `sql.raw(x)` with
 * text that is no literal (`why: 'non-literal'`), unless wrapped in
 * `readSql(...)`. `.execute(x)` of a built query is not text (drizzle's
 * execute takes the SQL a tag built, which is read where it is built). Not
 * findings: reads, definer calls (`select "public"."mantle_x"(...)`),
 * drizzle typed writes.
 */
export function rawWriteSqlSites(path, text) {
  if (!/\b(?:insert|update|delete|merge|truncate|unsafe|raw)\b/i.test(text)) return [];
  const sf = parse(path, text);
  const tags = new Set(SQL_TAGS);
  const out = [];
  const visit = (node) => {
    if (
      ts.isImportSpecifier(node) &&
      (node.propertyName ?? node.name).text === 'sql' &&
      node.name.text !== 'sql'
    ) {
      tags.add(node.name.text);
    }
    if (ts.isTaggedTemplateExpression(node)) {
      const tag = ts.isIdentifier(node.tag)
        ? node.tag.text
        : ts.isPropertyAccessExpression(node.tag)
          ? node.tag.name.text
          : null;
      const why = tag && tags.has(tag) ? rawWriteKind(templateText(node.template)) : null;
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

/** The always-findings: a fix round, a round code, an audit finding code. */
const HISTORY_WORDS = /fix round|\bround [0-9A-Z]\b|\baudit [HLMN][0-9]+\b/gi;
/** A step code (case-sensitive). */
const STEP_CODE = /\b[AWF][0-9]{1,2}[a-z]?\b/g;
/** The provenance words a step code is a finding next to. */
const PROVENANCE = String.raw`(?:arch|phase|plan|step|part|hand batch|integration|fix|audit|round)`;
/** A sheet or formula comment, where a bare A1 is a cell. */
const SHEET_WORDS =
  /\b(?:sheet|sheets|formula|formulas|cell|cells|xlsx|excel|spreadsheet|range|column|row)\b/i;

/** The step codes named in the history file's headings
 *  (docs/_archive/actors-history.md): each is a finding wherever it is. */
export function historyHeadingCodes(root) {
  const text = readRepoFile(root, 'docs/_archive/actors-history.md') ?? '';
  const codes = new Set();
  for (const line of text.split('\n')) {
    if (!/^#{1,6}\s/.test(line)) continue;
    for (const m of line.matchAll(STEP_CODE)) codes.add(m[0]);
  }
  return codes;
}

/** The history findings of one comment's text (its lines): the line
 *  offsets within the comment that hold one. */
export function historyFindings(comment, codes, { sheet = false } = {}) {
  const lines = comment.split('\n');
  const hits = [];
  lines.forEach((line, i) => {
    HISTORY_WORDS.lastIndex = 0;
    if (HISTORY_WORDS.test(line)) {
      hits.push(i);
      return;
    }
    for (const m of line.matchAll(STEP_CODE)) {
      const before = line.slice(0, m.index);
      const after = line.slice(m.index + m[0].length);
      const near =
        new RegExp(String.raw`\b${PROVENANCE}\b[\s,:;()-]*(?:[\w.]+[\s,:;()-]+)?$`, 'i').test(
          before,
        ) ||
        new RegExp(String.raw`^[\s,:;()-]*(?:[\w.]+[\s,:;()-]+)?${PROVENANCE}\b`, 'i').test(after);
      const cellLike = sheet || SHEET_WORDS.test(line);
      if (near || (codes.has(m[0]) && !cellLike)) {
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
  if (!HISTORY_WORDS.test(text) && !/\b[AWF][0-9]/.test(text)) return [];
  const sf = parse(path, text);
  const sheet = /sheet|formula|xlsx|tabledb/i.test(path);
  const out = new Set();
  for (const c of commentsOf(sf)) {
    const first = lineOf(sf, c.pos);
    for (const i of historyFindings(c.text, codes, { sheet })) out.add(first + i);
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
  return {
    numbers: {
      rawWriteSqlScoped: total(rawWrites),
      rawWriteSqlFiles: Object.keys(rawWrites).length,
      historyCodeComments: total(history),
    },
    detail: { rawWriteSql: rawWrites, historyCodeComments: history },
  };
}

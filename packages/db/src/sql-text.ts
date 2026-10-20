/**
 * The one reader of hand-written SQL text's shape, shared by readSql
 * (./read-sql.ts, at the moment composed text runs) and the raw write lint
 * (eslint-rules/cleanup-counts.mjs, on the literal text in the code), so
 * the two read a statement the same way.
 *
 * No parser: the text is blanked (sqlCode) so that only its code is left,
 * then read for its statements, its leading WITH and its first words. The
 * blanking follows the lexer of PostgreSQL where a mistake could hide code:
 * nested block comments, a `--` comment that a `\r` ends as a `\n` does, a
 * `--` inside a string (no comment), a `$` inside a name (no dollar quote),
 * E'' strings and their backslashes. It assumes
 * standard_conforming_strings on (the default); a plain string whose
 * backslash stands before a quote, and a U&"" name (an escaped name may
 * spell anything), are flagged `ambiguous` instead.
 *
 * Plain TypeScript with no imports and only erasable syntax, so the lint
 * (an .mjs module run by Node) imports this file as it is.
 */

/** The text with its comments and the bodies of its strings, dollar quotes
 *  and quoted names blanked, the same length (a position in one is the
 *  same in the other). */
export type SqlCode = {
  /** Comments are blanks (newlines kept); a string or a dollar quote keeps
   *  a `'` at each end and blanks between; a quoted name keeps its quotes
   *  with every character that is not a letter, a digit, `_` or `$` as `_`. */
  code: string;
  /** A comment, string, dollar quote or quoted name that never closes. */
  unterminated: boolean;
  /** Text PostgreSQL may read otherwise: a backslash before a quote in a
   *  plain string (standard_conforming_strings), or a U&"" name. */
  ambiguous: boolean;
};

const NAME_CHAR = /[A-Za-z0-9_$\u0080-￿]/;
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;

const blanks = (s: string): string => s.replace(/[^\n]/g, ' ');

/** Blank the comments, string and dollar-quote bodies and quoted names of
 *  `text` (SqlCode). */
export function sqlCode(text: string): SqlCode {
  let code = '';
  let unterminated = false;
  let ambiguous = false;
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i]!;
    const next = text[i + 1];
    const before = i > 0 ? text[i - 1]! : '';
    if (c === '-' && next === '-') {
      // A `--` comment ends at the first newline or carriage return (the
      // lexer's non_newline is [^\n\r]): after a lone `\r` is code.
      let stop = i + 2;
      while (stop < n && text[stop] !== '\n' && text[stop] !== '\r') stop += 1;
      code += blanks(text.slice(i, stop));
      i = stop;
    } else if (c === '/' && next === '*') {
      // Block comments nest in PostgreSQL.
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (text[j] === '/' && text[j + 1] === '*') {
          depth += 1;
          j += 2;
        } else if (text[j] === '*' && text[j + 1] === '/') {
          depth -= 1;
          j += 2;
        } else j += 1;
      }
      if (depth > 0) unterminated = true;
      code += blanks(text.slice(i, j));
      i = j;
    } else if (c === "'") {
      // E'' (the E its own token) takes backslash escapes.
      const escaped = /[eE]/.test(before) && !NAME_CHAR.test(i > 1 ? text[i - 2]! : '');
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const d = text[j]!;
        if (escaped && d === '\\') {
          j += 2;
          continue;
        }
        if (d === "'") {
          if (!escaped && text[j - 1] === '\\') ambiguous = true;
          if (text[j + 1] === "'") {
            j += 2;
            continue;
          }
          closed = true;
          break;
        }
        j += 1;
      }
      if (!closed) {
        unterminated = true;
        code += "'" + blanks(text.slice(i + 1));
        i = n;
      } else {
        code += "'" + blanks(text.slice(i + 1, j)) + "'";
        i = j + 1;
      }
    } else if (c === '"') {
      if (before === '&' && /[uU]/.test(i > 1 ? text[i - 2]! : '')) ambiguous = true;
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (text[j] === '"') {
          if (text[j + 1] === '"') {
            j += 2;
            continue;
          }
          closed = true;
          break;
        }
        j += 1;
      }
      const body = text
        .slice(i + 1, closed ? j : n)
        .replace(/[^\n]/g, (ch) => (NAME_CHAR.test(ch) ? ch : '_'));
      if (!closed) {
        unterminated = true;
        code += '"' + body;
        i = n;
      } else {
        code += '"' + body + '"';
        i = j + 1;
      }
    } else if (c === '$' && !NAME_CHAR.test(before)) {
      // A `$` inside a name or after one ($1, a$b$) opens nothing.
      const tag = DOLLAR_TAG.exec(text.slice(i));
      if (!tag) {
        code += c;
        i += 1;
        continue;
      }
      const end = text.indexOf(tag[0], i + tag[0].length);
      if (end < 0) {
        unterminated = true;
        code += "'" + blanks(text.slice(i + 1));
        i = n;
      } else {
        const stop = end + tag[0].length;
        const inner = text.slice(i + 1, stop - 1);
        code += "'" + blanks(inner) + "'";
        i = stop;
      }
    } else {
      code += c;
      i += 1;
    }
  }
  return { code, unterminated, ambiguous };
}

/** The statements of `text`: the text cut at each `;` of its code (never one
 *  in a comment, a string, a dollar quote or a quoted name). The last piece
 *  is kept even when empty. */
export function sqlStatements(text: string): string[] {
  const { code } = sqlCode(text);
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < code.length; i += 1) {
    if (code[i] === ';') {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

/** A statement's leading WITH, read on its code: the body of each CTE (the
 *  text inside its parentheses) and the statement after them (`rest`).
 *  `walked` is false when the WITH does not read as `name [(cols)] AS
 *  [[NOT] MATERIALIZED] (...)` items, a comma between (a SEARCH or CYCLE
 *  clause after a CTE, say, or parentheses that never close); `rest` is
 *  then what is left from the first item not read, the statement in it.
 *  No WITH: no CTEs, `rest` the code itself. */
export type WithParts = { ctes: string[]; rest: string; walked: boolean };

const CTE_HEAD =
  /^(?:"[^"]*"|[A-Za-z_\u0080-￿][\w$\u0080-￿]*)\s*(?:\([^()]*\)\s*)?as\s*(?:(?:not\s+)?materialized\s*)?\(/i;

export function withParts(code: string): WithParts {
  let t = code.trim();
  const w = /^with\s+(?:recursive\s+)?/i.exec(t);
  if (!w) return { ctes: [], rest: t, walked: true };
  t = t.slice(w[0].length);
  const ctes: string[] = [];
  for (;;) {
    const head = CTE_HEAD.exec(t);
    if (!head) return { ctes, rest: t, walked: false };
    let depth = 0;
    let i = head[0].length - 1;
    for (; i < t.length; i += 1) {
      if (t[i] === '(') depth += 1;
      else if (t[i] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) return { ctes, rest: t, walked: false };
    ctes.push(t.slice(head[0].length, i));
    t = t.slice(i + 1).trim();
    if (t.startsWith(',')) t = t.slice(1).trim();
    else return { ctes, rest: t, walked: !/^(?:search|cycle)\b/i.test(t) };
  }
}

/** The first word of `code` after any opening parentheses, lowercased, or
 *  '' (no word there). */
export function firstWord(code: string): string {
  const m = /^[\s(]*([A-Za-z_]+)\b/.exec(code);
  return m ? m[1]!.toLowerCase() : '';
}

/** The items of `code` split at its commas outside parentheses and
 *  brackets, each trimmed. */
function topLevelItems(code: string, text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < code.length; i += 1) {
    const c = code[i];
    if (c === '(' || c === '[') depth += 1;
    else if (c === ')' || c === ']') depth -= 1;
    else if (c === ',' && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out;
}

/**
 * An `insert into t (c1, ...) select v1, ... [from | where ...]` statement
 * read as its column and value pairs, in order: `[column, value]`, the
 * column unquoted, the value as written. A positional insert-select (a
 * typed insert whose select is SQL, which names every column of the table)
 * depends on the select giving each column its value in the table's order;
 * the tests of such a select hold it to this reading. Null when the text
 * is not that shape or the two counts differ.
 */
export function insertSelectPairs(text: string): Array<[string, string]> | null {
  const { code } = sqlCode(text);
  const head = /^\s*insert\s+into\s+[^(]*\(/i.exec(code);
  if (!head) return null;
  let depth = 1;
  let i = head[0].length;
  for (; i < code.length && depth > 0; i += 1) {
    if (code[i] === '(') depth += 1;
    else if (code[i] === ')') depth -= 1;
  }
  const columns = topLevelItems(
    code.slice(head[0].length, i - 1),
    text.slice(head[0].length, i - 1),
  );
  const sel = /^\s*select\s+/i.exec(code.slice(i));
  if (!sel) return null;
  const from = i + sel[0].length;
  let end = code.length;
  depth = 0;
  for (let j = from; j < code.length; j += 1) {
    const c = code[j];
    if (c === '(' || c === '[') depth += 1;
    else if (c === ')' || c === ']') depth -= 1;
    else if (depth === 0 && /\s/.test(code[j - 1] ?? ' ')) {
      if (/^(?:from|where)\b/i.test(code.slice(j))) {
        end = j;
        break;
      }
    }
  }
  const values = topLevelItems(code.slice(from, end), text.slice(from, end));
  if (values.length !== columns.length) return null;
  return columns.map((c, k) => [c.replace(/^"|"$/g, ''), values[k]!.replace(/\s+/g, ' ')]);
}

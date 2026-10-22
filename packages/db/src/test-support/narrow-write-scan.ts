/**
 * The narrow login's writes read from the source (the full re-audit's
 * finding: the measured allowlist is only as
 * good as the suites that drive it; Telegram connect, a mail account's add
 * and edit and the Microsoft mailbox were never driven, so their writes
 * were never measured and would fail, or worse be granted by a guess).
 *
 * Every drizzle write in the app's source (`.insert(t)`, `.update(t).set({
 * ... })` with an upsert's `onConflictDoUpdate({ set })`, `.delete(t)`) on
 * a table that is not a content table (the write role writes those in a
 * login's scope; 0312 counts the rest) is held against the narrow role's
 * allowlist (access-matrix.ts NARROW_WRITES): a write the narrow role may
 * make is fine; any other must sit at a full-route spot (inside an
 * `onFullSystemRoute(...)` call, or in a function of the file that is used
 * only inside one: passed by name or called by its arrow), or in a file that never runs on a narrow exit (worker, boot or
 * migrate code: NARROW_SCAN_SYSTEM_FILES, each with why), or be pinned in
 * the open list (narrow-write-scan.test.ts), which only shrinks. So a new
 * write on a narrow-reachable path that the allowlist does not hold fails
 * the unit suite before any suite has to reach it.
 *
 * A static reading, with named limits: a write through a helper that is
 * not a drizzle chain on a schema table (raw SQL text, a table passed as a
 * variable) is not seen; an update whose set is spread from a variable is
 * read as naming unknown columns (it must be at a spot or pinned).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { ACCESS_MATRIX, narrowMayWrite } from '../access-matrix';

export type ScannedWrite = {
  file: string;
  line: number;
  /** schema.table */
  table: string;
  op: 'insert' | 'update' | 'delete';
  /** Column names an UPDATE (or an upsert's SET) names; '*' when a spread
   *  or a variable hides them. */
  columns: string[];
  /** Inside a full-route spot (lexically, or a function passed to one). */
  atSpot: boolean;
};

/** The source with comments and string contents blanked (same offsets). */
export function codeOnly(src: string): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      const e = src.indexOf('\n', i);
      const end = e === -1 ? n : e;
      blank(i, end);
      i = end;
    } else if (c === '/' && d === '*') {
      const e = src.indexOf('*/', i + 2);
      const end = e === -1 ? n : e + 2;
      blank(i, end);
      i = end;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j++;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join('');
}

/** The offset of the bracket that closes the one at `open`. */
function closing(code: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const stack: string[] = [];
  for (let i = open; i < code.length; i++) {
    const c = code[i]!;
    if (pairs[c]) stack.push(pairs[c]!);
    else if (c === ')' || c === '}' || c === ']') {
      stack.pop();
      if (stack.length === 0) return i;
    }
  }
  return code.length;
}

/** The top-level keys of the object literal whose `{` is at `open`. */
function objectKeys(code: string, open: number): string[] {
  const end = closing(code, open);
  const keys: string[] = [];
  let depth = 0;
  let part = '';
  const flush = () => {
    const t = part.trim();
    part = '';
    if (!t) return;
    if (t.startsWith('...')) {
      // `...(cond ? { a: x } : {})` names its keys; any other spread hides them.
      const inner = t.match(/^\.\.\.\(\s*[^?]*\?\s*\{([^{}]*)\}\s*:\s*\{\s*\}\s*\)$/);
      if (inner) {
        for (const p of inner[1]!.split(',')) {
          const k = p.split(':')[0]!.trim();
          if (k) keys.push(k);
        }
      } else keys.push('*');
      return;
    }
    const m = t.match(/^([A-Za-z_$][\w$]*)\s*(:|$)/);
    keys.push(m ? m[1]! : '*');
  };
  for (let i = open + 1; i < end; i++) {
    const c = code[i]!;
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    if (c === ',' && depth === 0) flush();
    else part += c;
  }
  flush();
  return keys;
}

/** The spans of every `onFullSystemRoute(...)` call's arguments, and the
 *  names of functions a file passes to one. */
function spotSpans(
  code: string,
  calls: readonly string[],
): {
  spans: [number, number][];
  names: Set<string>;
  passed: Set<string>;
} {
  const spans: [number, number][] = [];
  const names = new Set<string>();
  const passed = new Set<string>();
  const re = new RegExp(`\\b(${calls.join('|')})\\s*\\(`, 'g');
  for (let m = re.exec(code); m; m = re.exec(code)) {
    const open = m.index + m[0].length - 1;
    const end = closing(code, open);
    spans.push([open, end]);
    const args = code.slice(open + 1, end);
    const last = args.split(',').pop()!.trim();
    if (/^[A-Za-z_$][\w$]*$/.test(last)) {
      names.add(last);
      passed.add(last);
    }
    // A function the spot's own arrow calls by name (`() => run(a, b)`).
    for (const c of args.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) names.add(c[1]!);
  }
  return { spans, names, passed };
}

/** The names of `names` that the file uses only inside `spans` (besides
 *  their own declaration): a function reached only from a spot. */
function spotOnly(code: string, names: Set<string>, spans: [number, number][]): Set<string> {
  const out = new Set<string>();
  for (const name of names) {
    const re = new RegExp(`\\b${name}\\b`, 'g');
    let ok = true;
    for (let m = re.exec(code); m; m = re.exec(code)) {
      const before = code.slice(Math.max(0, m.index - 20), m.index);
      if (/(?:const|let|function)\s+$/.test(before)) continue;
      if (!spans.some(([a, b]) => m!.index > a && m!.index < b)) {
        ok = false;
        break;
      }
    }
    if (ok) out.add(name);
  }
  return out;
}

/** The spans of `const name = (...) => ...` and `function name(...) {...}`
 *  bodies whose name the file passes to a spot. */
function namedSpans(code: string, names: Set<string>): [number, number][] {
  const out: [number, number][] = [];
  for (const name of names) {
    const fn = new RegExp(`\\b(?:const|let)\\s+${name}\\s*=\\s*(?:async\\s*)?\\(`, 'g');
    for (let m = fn.exec(code); m; m = fn.exec(code)) {
      const paramsEnd = closing(code, m.index + m[0].length - 1);
      const arrow = code.indexOf('=>', paramsEnd);
      if (arrow === -1) continue;
      let k = arrow + 2;
      while (/\s/.test(code[k] ?? '')) k++;
      if (code[k] === '{' || code[k] === '(') out.push([k, closing(code, k)]);
      else {
        const semi = code.indexOf(';', k);
        out.push([k, semi === -1 ? code.length : semi]);
      }
    }
    const decl = new RegExp(`\\bfunction\\s+${name}\\s*\\(`, 'g');
    for (let m = decl.exec(code); m; m = decl.exec(code)) {
      const brace = code.indexOf('{', closing(code, m.index + m[0].length - 1));
      if (brace !== -1) out.push([brace, closing(code, brace)]);
    }
  }
  return out;
}

/** The calls that run their function at a full-route spot: onFullSystemRoute
 *  and the one-spot helpers (as-system-routes.mjs FULL_ROUTE_SPOT_WRAPPERS);
 *  the test passes the helpers' names. */
export const SPOT_CALLS: readonly string[] = ['onFullSystemRoute'];

export type TableInfo = { name: string; columns: Record<string, string>; content: boolean };

/** Every schema table by its export name. */
export function tablesOf(schema: Record<string, unknown>): Map<string, TableInfo> {
  const content = new Set(ACCESS_MATRIX.filter((t) => t.writer === 'content').map((t) => t.table));
  const out = new Map<string, TableInfo>();
  for (const [key, value] of Object.entries(schema)) {
    if (!is(value, PgTable)) continue;
    const t = value as PgTable;
    const name = `${getTableConfig(t).schema ?? 'public'}.${getTableName(t)}`;
    const columns: Record<string, string> = {};
    for (const [prop, col] of Object.entries(getTableColumns(t))) columns[prop] = col.name;
    out.set(key, {
      name,
      columns,
      content: content.has(getTableName(t)) || content.has(name),
    });
  }
  return out;
}

/** The writes of one file. */
export function scanSource(
  file: string,
  src: string,
  tables: Map<string, TableInfo>,
  spotCalls: readonly string[] = SPOT_CALLS,
): ScannedWrite[] {
  const code = codeOnly(src);
  const { spans, names, passed } = spotSpans(code, spotCalls);
  // A function passed to a spot whose other call the file guards with
  // narrowNeedsSpot (the same allowlist, at run time) counts as at the spot.
  const covered = spotOnly(code, names, spans);
  if (/\bnarrowNeedsSpot\s*\(/.test(code)) for (const n of passed) covered.add(n);
  const all = [...spans, ...namedSpans(code, covered)];
  const inSpot = (at: number) => all.some(([a, b]) => at > a && at < b);
  const lineOf = (at: number) => code.slice(0, at).split('\n').length;
  const out: ScannedWrite[] = [];
  const re = /\.\s*(insert|update|delete)\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    const info = tables.get(m[2]!);
    if (!info || info.content) continue;
    const op = m[1] as ScannedWrite['op'];
    const after = m.index + m[0].length;
    // The rest of the chain: up to the statement's end at this depth.
    let end = after;
    let depth = 0;
    for (; end < code.length; end++) {
      const c = code[end]!;
      if (c === '(' || c === '{' || c === '[') depth++;
      else if (c === ')' || c === '}' || c === ']') {
        if (depth === 0) break;
        depth--;
      } else if ((c === ';' || c === ',') && depth === 0) break;
    }
    const chain = code.slice(after, end);
    const cols = new Set<string>();
    const named = (keys: string[]) => {
      for (const k of keys) cols.add(k === '*' ? '*' : (info.columns[k] ?? k));
    };
    if (op === 'update') {
      const s = chain.match(/^\s*\.\s*set\s*\(\s*/);
      if (s) {
        const at = after + s[0].length;
        if (code[at] === '{') named(objectKeys(code, at));
        else cols.add('*');
      } else cols.add('*');
    }
    const up = chain.indexOf('onConflictDoUpdate');
    if (op === 'insert' && up !== -1) {
      const setAt = chain.indexOf('set', up);
      const brace = setAt === -1 ? -1 : chain.indexOf('{', setAt);
      if (brace !== -1 && /^set\s*:\s*$/.test(chain.slice(setAt, brace)))
        named(objectKeys(code, after + brace));
      else cols.add('*');
    }
    out.push({
      file,
      line: lineOf(m.index),
      table: info.name,
      op,
      columns: [...cols].sort(),
      atSpot: inSpot(m.index),
    });
  }
  return out;
}

/** Whether the narrow role may make this write (its allowlist), whatever
 *  the place. An upsert needs INSERT and UPDATE of its SET. */
export function narrowAllows(w: ScannedWrite): boolean {
  if (w.columns.includes('*')) return false;
  if (w.op === 'delete') return narrowMayWrite(w.table, 'delete');
  if (w.op === 'insert')
    return (
      narrowMayWrite(w.table, 'insert') &&
      (w.columns.length === 0 || narrowMayWrite(w.table, 'update', w.columns))
    );
  return narrowMayWrite(w.table, 'update', w.columns);
}

const SKIP_DIR = new Set(['node_modules', 'dist', '.next', '.turbo', 'test', '__tests__', 'e2e']);

/** The app's source files under `roots` (relative to `repo`): .ts and .tsx,
 *  no tests, scripts, migrations or the schema itself. */
export function sourceFiles(repo: string, roots: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIR.has(name) || name === 'scripts' || name === 'migrations') continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name) && !/\.(test|spec|d)\.tsx?$/.test(name)) out.push(p);
    }
  };
  for (const r of roots) walk(join(repo, r));
  return out
    .map((p) => relative(repo, p))
    .filter((p) => !p.startsWith('packages/db/src/schema/'))
    .sort();
}

/** Every write of the source the narrow role may not make outside a spot. */
export function scanRepo(
  repo: string,
  roots: readonly string[],
  tables: Map<string, TableInfo>,
  spotCalls: readonly string[] = SPOT_CALLS,
): ScannedWrite[] {
  const out: ScannedWrite[] = [];
  for (const f of sourceFiles(repo, roots)) {
    for (const w of scanSource(f, readFileSync(join(repo, f), 'utf8'), tables, spotCalls)) {
      if (!w.atSpot && !narrowAllows(w)) out.push(w);
    }
  }
  return out;
}

/** A write's key in the pinned lists: no line number (lines move). */
export function writeKey(w: ScannedWrite): string {
  return `${w.file} ${w.op} ${w.table}${w.op === 'update' || w.columns.length ? ` [${w.columns.join(',')}]` : ''}`;
}

/* ------------------------------------------------------------------------ *
 * The function calls (round 14, the re-audit's app MED-1 class fix): an
 * EXECUTE refusal is no write, so neither the counter nor the write scan
 * above saw a narrow exit call a definer the narrow role may not run (a
 * connector's sync, move and key rotate called mantle_connector_beyond_admin
 * on the Admin area's narrow exit, refused, after the marks were voided).
 * Every `mantle_<name>(` call in the SQL text of the source (a template
 * literal: the sql`...` the app sends) is held against what the narrow role
 * may run: its EXECUTE allowlist and PUBLIC definers (runtime-role.ts), or
 * a function that runs as its caller (no SECURITY DEFINER in its newest
 * definition among the migrations) not taken from PUBLIC. Any other call
 * must sit at a full-route spot, in a system file, or be pinned with its
 * function's decision (narrow-write-scan.pins.ts NARROW_SCAN_FN_DECIDED)
 * and its exact count per file (NARROW_SCAN_FN_OPEN): a new call of a
 * definer the narrow role may not run, in any file, fails the unit suite.
 * runtime-role.db.test.ts checks the "runs as its caller" reading against
 * the catalog (the narrow role's real EXECUTE rights).
 * ------------------------------------------------------------------------ */

export type ScannedCall = { file: string; line: number; fn: string; atSpot: boolean };

/** The spans of the template literals' text in `src` (their `${...}`
 *  parts included: a nested call in one is SQL text too). */
export function templateSpans(src: string): [number, number][] {
  const code = codeOnly(src);
  const out: [number, number][] = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== '`' || code[i] !== '`') continue;
    let j = i + 1;
    while (j < src.length && !(src[j] === '`' && code[j] === '`')) j++;
    out.push([i + 1, j]);
    i = j;
  }
  return out;
}

/** The `mantle_<name>(` calls in the SQL text of one file. */
export function scanCalls(
  file: string,
  src: string,
  spotCalls: readonly string[] = SPOT_CALLS,
): ScannedCall[] {
  const code = codeOnly(src);
  const { spans, names, passed } = spotSpans(code, spotCalls);
  const covered = spotOnly(code, names, spans);
  if (/\bnarrowNeedsSpot\s*\(/.test(code)) for (const n of passed) covered.add(n);
  const all = [...spans, ...namedSpans(code, covered)];
  const inSpot = (at: number) => all.some(([a, b]) => at > a && at < b);
  const lineOf = (at: number) => src.slice(0, at).split('\n').length;
  const out: ScannedCall[] = [];
  const re = /(?<![\w.$])(?:"?public"?\s*\.\s*)?"?(mantle_[a-z0-9_]+)"?\s*\(/g;
  for (const [a, b] of templateSpans(src)) {
    const text = src.slice(a, b);
    for (let m = re.exec(text); m; m = re.exec(text)) {
      out.push({ file, line: lineOf(a + m.index), fn: m[1]!, atSpot: inSpot(a + m.index) });
    }
    re.lastIndex = 0;
  }
  return out;
}

/** Each `public.mantle_*` function's newest definition among the
 *  migrations: whether it is SECURITY DEFINER (false: runs as its caller),
 *  and whether a later migration took EXECUTE on it from PUBLIC. */
export function migrationFunctions(
  repo: string,
): Map<string, { definer: boolean; fromPublic: boolean }> {
  const dir = join(repo, 'packages/db/migrations');
  const out = new Map<string, { definer: boolean; fromPublic: boolean }>();
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith('.sql'))
    .sort()) {
    const s = readFileSync(join(dir, f), 'utf8');
    const def =
      /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?public"?\s*\.\s*)?"?(mantle_\w+)"?\s*\(([\s\S]*?)\$(\w*)\$/gi;
    for (let m = def.exec(s); m; m = def.exec(s))
      out.set(m[1]!, { definer: /SECURITY\s+DEFINER/i.test(m[2]!), fromPublic: false });
    const rev =
      /REVOKE\s+(?:ALL|EXECUTE)\s+ON\s+FUNCTION\s+(?:"?public"?\s*\.\s*)?"?(mantle_\w+)"?[^;]*FROM\s+PUBLIC/gi;
    for (let m = rev.exec(s); m; m = rev.exec(s)) {
      const e = out.get(m[1]!);
      if (e) e.fromPublic = true;
    }
  }
  return out;
}

/** The names the narrow role may run: its allowlists (by name) and the
 *  functions that run as their caller and stay PUBLIC's. */
export function narrowRunnable(
  fns: Map<string, { definer: boolean; fromPublic: boolean }>,
  allowed: readonly string[],
  denied: readonly string[],
): Set<string> {
  const name = (sig: string) => sig.replace(/^public\./, '').replace(/\(.*$/, '');
  const deniedNames = new Set(denied.map(name));
  const out = new Set(allowed.map(name));
  for (const [fn, d] of fns) if (!d.definer && !d.fromPublic && !deniedNames.has(fn)) out.add(fn);
  return out;
}

/** Every call the narrow role may not run outside a spot, by `file fn`
 *  with its count (system files left out). */
export function scanRepoCalls(
  repo: string,
  roots: readonly string[],
  runnable: Set<string>,
  systemFiles: Readonly<Record<string, string>>,
  spotCalls: readonly string[] = SPOT_CALLS,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of sourceFiles(repo, roots)) {
    // Test helpers (test-support.ts and the test-support folders) run in
    // tests only.
    if (systemFiles[f] || /(^|\/)test-support(\/|\.ts$)/.test(f)) continue;
    for (const c of scanCalls(f, readFileSync(join(repo, f), 'utf8'), spotCalls)) {
      if (c.atSpot || runnable.has(c.fn)) continue;
      const k = `${c.file} ${c.fn}`;
      out.set(k, (out.get(k) ?? 0) + 1);
    }
  }
  return out;
}

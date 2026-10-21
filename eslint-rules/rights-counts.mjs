/**
 * The rights counts of the scoreboard (scripts/arch-scoreboard.ts): where
 * the code, not the database, still decides who may do what, and the lists
 * that excuse it. Read by eslint-rules/arch-counts.mjs measure(), pinned in
 * scripts/arch-scoreboard.pins.json, tested in rights-counts.test.ts.
 *
 *  - request system exits by reason: the request paths that leave the
 *    login's scope for the system pool (noteRequestSystem, and any wrapper
 *    that passes its reason on, followed by as-system-exits.mjs);
 *  - scopeHoldsAdmin calls: an Admin ask outside the database's own rule;
 *  - SQL area rules: SQL that decides an Admin area by itself, in a
 *    function the migrations leave (it reads the `areas` limits) or in SQL
 *    text in TypeScript (it joins workspace_users to the Admin workspace);
 *  - raw writes to the four workspace tables in TypeScript, and the SQL
 *    functions the migrations leave that write them;
 *  - the copies of "set the assistant of a workspace";
 *  - tool item pre-checks kept as legacy entries with no owner or end date;
 *  - the raw write SQL allowlist, capped at its pin. (The A8 coverage,
 *    a8Uncovered and a8Exempt, is measured by the generator itself:
 *    server/web/server/a8-coverage.test.ts, S11a.)
 *
 * The SQL functions are read from the migrations in journal order (create,
 * replace, rename, drop, security definer), so the count needs no
 * database; packages/db/src/rights-catalog.db.test.ts proves it equals the
 * live catalog after migrate.
 */
import { balanced, readRepoFile, stripComments } from './arch-counts.mjs';
import { sqlCode } from '../packages/db/src/sql-text.ts';
import { adminCounts } from './admin-counts.mjs';
import { asSystemExits } from './as-system-exits.mjs';
import {
  asSystemReasons,
  asSystemRouteCounts,
  asSystemRouteMap,
  fullRouteSpots,
  requestSystemRouteMap,
} from './as-system-routes.mjs';

/** The four workspace tables only definers should write. */
export const WORKSPACE_TABLES = Object.freeze([
  'workspaces',
  'workspace_users',
  'workspace_events',
  'workspace_resources',
]);

/** A write statement on one of the four workspace tables (SQL text, any
 *  quoting, with or without the public schema, with or without ONLY, as
 *  rawWriteTarget in packages/db/src/gateway/write-route.ts reads one). */
export const WORKSPACE_TABLE_WRITE = new RegExp(
  String.raw`\b(?:insert\s+into|update|delete\s+from|merge\s+into|truncate(?:\s+table)?)\s+` +
    String.raw`(?:only\s+)?(?:"?public"?\s*\.\s*)?"?(?:${WORKSPACE_TABLES.join('|')})"?(?![\w"])`,
  'gi',
);

/** A row lock clause: FOR UPDATE, FOR NO KEY UPDATE, FOR SHARE, FOR KEY
 *  SHARE (each needs UPDATE on the table it locks). */
const ROW_LOCK_CLAUSE = /\bfor\s+(?:no\s+key\s+update|key\s+share|update|share)\b/i;

/** A statement reading one of the four tables: FROM or JOIN it (SQL), or a
 *  drizzle from/join of its table object (bare or through a namespace). */
const NAMES_WORKSPACE_TABLE = new RegExp(
  String.raw`\b(?:from|join)\s+(?:only\s+)?(?:"?public"?\s*\.\s*)?"?(?:${WORKSPACE_TABLES.join('|')})"?(?![\w"])`,
  'i',
);
const TYPED_WORKSPACE_TABLE =
  /\.(?:from|innerJoin|leftJoin|rightJoin|fullJoin|crossJoin)\(\s*(?:[\w$]+\s*\.\s*)*(?:workspaces|workspaceUsers|workspaceEvents|workspaceResources)\s*[,)]/;

/**
 * The statements in `text` that row-lock one of the four tables: a lock
 * clause in a statement that names one anywhere (FROM nodes n JOIN
 * workspaces w ... FOR UPDATE counts), or a drizzle `.for(` on a select of
 * one. Read per statement (split at `;` and template-literal ends). A lock
 * whose OF list names only another table still counts: the count errs to
 * more. The runtime role may not lock these tables (it holds no UPDATE on
 * them), so a lock outside a definer fails at run time.
 */
export function workspaceTableRowLocks(text) {
  return stripComments(text)
    .split(/[;`]/)
    .filter(
      (s) =>
        (ROW_LOCK_CLAUSE.test(s) && NAMES_WORKSPACE_TABLE.test(s)) ||
        (/\.for\(/.test(s) && TYPED_WORKSPACE_TABLE.test(s)),
    ).length;
}

/** Whether a SQL function body row-locks one of the four tables (the
 *  live-catalog cell's test, ws-runtime-read.db.test.ts). */
export function locksWorkspaceTable(body) {
  return workspaceTableRowLocks(body) > 0;
}

/** Files the rights counts never read: test support writes fixtures. */
function isTestSupport(path) {
  return /(^|\/)test-support(\/|\.ts$)/.test(path);
}

// ── request system exits ───────────────────────────────────────────────────

const REQUEST_SYSTEM = 'noteRequestSystem';

/** The first owner's request system exit (packages/db/src/first-owner-exit.ts):
 *  each use of firstOwnerSwitch is one exit, reason 'first-owner'. */
const FIRST_OWNER_SWITCH = 'firstOwnerSwitch';

/** The one file that may call the exit's own entry (viewer.ts
 *  enterFirstOwnerExit, not in index.ts): first-owner-exit.ts. */
const FIRST_OWNER_EXIT = 'enterFirstOwnerExit';
const FIRST_OWNER_EXIT_FILES = new Set([
  'packages/db/src/viewer.ts',
  'packages/db/src/first-owner-exit.ts',
]);

/**
 * The request system exits of the counted files (`[{ path, text }]`) by
 * reason, and the problems that would hide one. The wrapper-following
 * engine of the asSystem exits (as-system-exits.mjs) with noteRequestSystem
 * as its call: a call with a literal reason is an exit with that reason; a
 * function that passes one of its parameters on as the reason (a wrapper:
 * a declaration, an arrow, a method, exported or not) is followed to its
 * uses in any file, each an exit with the literal reason it passes. A
 * reason the count cannot read counts under 'unnamed' (still an exit), as
 * does a wrapper no code calls.
 */
export function requestSystemExits(files) {
  const r = asSystemExits(files, { call: REQUEST_SYSTEM, follow: 'forwarders' });
  const byReason = { ...r.byReason };
  const problems = [...r.problems];
  // The first owner's exit: every call of firstOwnerSwitch, whatever it
  // passes (its reason is its own; its one argument, a login id, is no
  // reason to follow), under 'first-owner'; its entry named in no other
  // file. The engine still reports a renamed or passed-around one.
  const fo = asSystemExits(files, { call: FIRST_OWNER_SWITCH, follow: 'forwarders' });
  const uses = fo.holders.reduce((a, h) => a + h.siteList.length, 0);
  if (uses > 0) byReason['first-owner'] = (byReason['first-owner'] ?? 0) + uses;
  problems.push(...fo.problems);
  for (const { path, text } of files) {
    if (FIRST_OWNER_EXIT_FILES.has(path)) continue;
    if (new RegExp(`\\b${FIRST_OWNER_EXIT}\\b`).test(stripComments(text))) {
      problems.push(`${path}: names ${FIRST_OWNER_EXIT} (only first-owner-exit.ts may)`);
    }
  }
  return { byReason, problems };
}

// ── Admin asks ──────────────────────────────────────────────────────────────

/** Calls of scopeHoldsAdmin in `text` (its definition is not a call). */
export function scopeHoldsAdminCalls(text) {
  const code = stripComments(text);
  let n = 0;
  for (const m of code.matchAll(/\bscopeHoldsAdmin\s*\(/g)) {
    if (/\bfunction\s+$/.test(code.slice(Math.max(0, m.index - 20), m.index))) continue;
    n += 1;
  }
  return n;
}

/** The index of the quote that closes the string opening at `code[i]` (or
 *  the line's end, or the text's). */
function quotedEnd(code, i) {
  const q = code[i];
  let j = i + 1;
  while (j < code.length) {
    if (code[j] === '\\') {
      j += 2;
      continue;
    }
    if (code[j] === q || code[j] === '\n') return j;
    j += 1;
  }
  return code.length;
}

/** The index of the `}` that closes a `${` part whose expression starts at
 *  `code[j]`. Its strings, its braces and the template literals nested in
 *  it are read whole, so a brace or a backtick inside one does not close
 *  the part. */
function expressionEnd(code, j) {
  let depth = 0;
  while (j < code.length) {
    const c = code[j];
    if (c === '`') {
      j = templateEnd(code, j) + 1;
      continue;
    }
    if (c === "'" || c === '"') {
      j = quotedEnd(code, j) + 1;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      if (depth === 0) return j;
      depth -= 1;
    }
    j += 1;
  }
  return code.length;
}

/** The index of the backtick that closes the template literal opening at
 *  `code[i]` (or the text's end); each `${}` part is skipped whole. */
function templateEnd(code, i) {
  let j = i + 1;
  while (j < code.length) {
    const c = code[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '`') return j;
    if (c === '$' && code[j + 1] === '{') {
      j = expressionEnd(code, j + 2) + 1;
      continue;
    }
    j += 1;
  }
  return code.length;
}

/** The template literals of `code` (their raw text, `${}` parts kept, a
 *  literal nested in a `${}` part kept inside its outer one). */
function templateLiterals(code) {
  const out = [];
  let i = code.indexOf('`');
  while (i >= 0) {
    const j = templateEnd(code, i);
    out.push(code.slice(i + 1, j));
    i = code.indexOf('`', j + 1);
  }
  return out;
}

/** `t` with each CTE (`name as (...)`) that joins no workspace user blanked:
 *  a helper such as `admin_ws as (select ... where w.is_admin)` names the
 *  Admin workspace as a fallback, it decides nothing about the login. */
function withoutHelperCtes(t) {
  let out = t;
  for (const m of t.matchAll(/\b[A-Za-z_]\w*\s+as\s+(?:(?:not\s+)?materialized\s+)?\(/gi)) {
    const body = balanced(t, m.index + m[0].length - 1);
    if (!/\bworkspace_users\b/.test(body)) out = out.replace(body, ' '.repeat(body.length));
  }
  return out;
}

/** The SQL texts (template literals) of `text` that ask about a login's
 *  workspace users row for a login they are given (`workspace_users`,
 *  `login_id = ${...}`, an enabled login): `{ rules, membership }`. A rule
 *  decides an Admin area or the Admin user itself: it reads the `areas`
 *  limits, or it holds the joined workspace to the Admin one (`is_admin`
 *  outside a helper CTE). A membership ask holds it to another workspace
 *  (the assistant's), the Admin one only as a fallback. A list or a report
 *  that only shows `is_admin` is neither. */
export function tsAdminSqlKinds(text) {
  let rules = 0;
  let membership = 0;
  for (const t of templateLiterals(stripComments(text))) {
    if (readsAreaLimits(t)) {
      rules += 1;
      continue;
    }
    if (
      !/\bworkspace_users\b/.test(t) ||
      !/\bdisabled_at\b/.test(t) ||
      !/\blogin_id\s*=\s*\$\{/.test(t)
    ) {
      continue;
    }
    if (/\bis_admin\b/.test(withoutHelperCtes(t))) rules += 1;
    else membership += 1;
  }
  return { rules, membership };
}

/** SQL text in `text` that decides an Admin area or Admin user by itself
 *  (tsAdminSqlKinds rules). */
export function tsAdminRuleSql(text) {
  return tsAdminSqlKinds(text).rules;
}

// ── workspace tables ────────────────────────────────────────────────────────

/** Raw SQL writes to the four workspace tables in `text`, and drizzle
 *  writes of their tables, bare or reached through a namespace
 *  (`schema.workspaces`): the runtime role's read-only grant on them rests
 *  on this count being 0. */
export function workspaceTableRawWrites(text) {
  const code = stripComments(text);
  const sqlWrites = [...code.matchAll(WORKSPACE_TABLE_WRITE)].length;
  const typed = [
    ...code.matchAll(
      /\.(?:insert|update|delete)\(\s*(?:[\w$]+\s*\.\s*)*(?:workspaces|workspaceUsers|workspaceEvents|workspaceResources)\s*\)/g,
    ),
  ].length;
  return sqlWrites + typed;
}

/** The TypeScript definitions of "set the assistant of a workspace", by
 *  name (a progress counter only: see isSetAssistantFn). */
export function tsSetAssistantDefs(text) {
  const code = stripComments(text);
  return [
    ...code.matchAll(
      /\bfunction\s+setAssistant\w*\s*\(|\b(?:const|let)\s+setAssistant\w*\s*=\s*(?:async\s*)?(?:\(|function)/g,
    ),
  ].length;
}

// ── the SQL functions the migrations leave ──────────────────────────────────

const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)`;
const QNAME = String.raw`(${IDENT})(?:\s*\.\s*(${IDENT}))?`;

function unquote(id) {
  return id.startsWith('"') ? id.slice(1, -1) : id.toLowerCase();
}

/** [schema, name] of a possibly qualified name match (schema defaults to
 *  public). */
function qualified(a, b) {
  return b ? [unquote(a), unquote(b)] : ['public', unquote(a)];
}

/** SQL `text` with `--` and block comments blanked, outside quotes and
 *  dollar quotes (a function body keeps its own text): sql-text.ts's
 *  reading (nested block comments, a `--` comment a `\r` ends, E'' strings,
 *  a `$` inside a name), the same length. */
function stripSqlComments(text) {
  return sqlCode(text).uncommented;
}

/** The input argument types of a function's parameter list (`a uuid, b
 *  text default null, out c int` -> 'uuid,text'), lower case, names, modes
 *  and defaults dropped. Only a key: never compared with the catalog. */
function argKey(params) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const c of params) {
    if (c === '(') depth += 1;
    if (c === ')') depth -= 1;
    if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) parts.push(cur);
  const types = [];
  for (let p of parts) {
    p = p
      .replace(/\s+(default\b|=).*$/is, '')
      .trim()
      .replace(/"/g, '')
      .toLowerCase();
    const mode = /^(in|out|inout|variadic)\s+/.exec(p);
    if (mode) {
      if (mode[1] === 'out') continue;
      p = p.slice(mode[0].length);
    }
    const words = p.split(/\s+/);
    // `name type`: drop the name. A type of more than one word (double
    // precision, timestamp with time zone) is read as written.
    if (words.length > 1 && !/^(double|timestamp|time|character|bit|interval)$/.test(words[0])) {
      words.shift();
    }
    types.push(words.join(' ').replace(/^public\./, ''));
  }
  return types.join(',');
}

/** The journal's migrations in order (repo-relative paths). */
export function migrationFiles(root) {
  const journal = JSON.parse(
    readRepoFile(root, 'packages/db/migrations/meta/_journal.json') ?? '{}',
  );
  return (journal.entries ?? []).map((e) => `packages/db/migrations/${e.tag}.sql`);
}

/**
 * The SQL functions the migrations leave, in journal order: CREATE [OR
 * REPLACE] FUNCTION, ALTER FUNCTION ... RENAME TO and SECURITY
 * DEFINER/INVOKER, DROP FUNCTION. Returns [{ schema, name, args, definer,
 * body }], keyed by schema, name and input types.
 */
export function migrationFunctions(root) {
  const fns = new Map();
  const create = new RegExp(
    String.raw`\bcreate\s+(?:or\s+replace\s+)?function\s+${QNAME}\s*\(`,
    'gi',
  );
  const alter = new RegExp(String.raw`\balter\s+function\s+${QNAME}\s*(\()?`, 'gi');
  const drop = new RegExp(
    String.raw`\bdrop\s+function\s+(?:if\s+exists\s+)?${QNAME}\s*(\()?`,
    'gi',
  );
  const byName = (schema, name) =>
    [...fns.keys()].filter((k) => k.startsWith(`${schema}.${name}(`));
  for (const path of migrationFiles(root)) {
    const sql = stripSqlComments(readRepoFile(root, path) ?? '');
    const events = [];
    for (const m of sql.matchAll(create)) events.push({ at: m.index, kind: 'create', m });
    for (const m of sql.matchAll(alter)) events.push({ at: m.index, kind: 'alter', m });
    for (const m of sql.matchAll(drop)) events.push({ at: m.index, kind: 'drop', m });
    events.sort((a, b) => a.at - b.at);
    for (const { kind, m } of events) {
      const [schema, name] = qualified(m[1], m[2]);
      const afterName = m.index + m[0].length;
      if (kind === 'create') {
        const params = balanced(sql, afterName - 1).slice(1, -1);
        const rest = sql.slice(afterName - 1 + params.length + 2);
        const dq = /\$([A-Za-z_]\w*)?\$/.exec(rest);
        const head = dq ? rest.slice(0, dq.index) : rest;
        let body = '';
        let tail = '';
        if (dq) {
          const close = rest.indexOf(dq[0], dq.index + dq[0].length);
          body = rest.slice(dq.index + dq[0].length, close < 0 ? undefined : close);
          const after = close < 0 ? '' : rest.slice(close + dq[0].length);
          tail = after.slice(0, Math.max(0, after.indexOf(';')));
        }
        const attrs = `${head} ${tail}`;
        fns.set(`${schema}.${name}(${argKey(params)})`, {
          schema,
          name,
          args: argKey(params),
          definer: /\bsecurity\s+definer\b/i.test(attrs),
          body,
        });
        continue;
      }
      const keys = m[3]
        ? [`${schema}.${name}(${argKey(balanced(sql, afterName - 1).slice(1, -1))})`]
        : byName(schema, name);
      const stmt = sql.slice(
        afterName,
        sql.indexOf(';', afterName) < 0 ? undefined : sql.indexOf(';', afterName),
      );
      for (const key of keys) {
        const fn = fns.get(key);
        if (kind === 'drop') {
          fns.delete(key);
          continue;
        }
        if (!fn) continue;
        const renamed = /\brename\s+to\s+("[^"]+"|[A-Za-z_]\w*)/i.exec(stmt);
        if (renamed) {
          fns.delete(key);
          const to = unquote(renamed[1]);
          fns.set(`${fn.schema}.${to}(${fn.args})`, { ...fn, name: to });
        }
        if (/\bsecurity\s+definer\b/i.test(stmt)) fn.definer = true;
        if (/\bsecurity\s+invoker\b/i.test(stmt)) fn.definer = false;
      }
    }
  }
  return [...fns.values()].sort((a, b) =>
    `${a.schema}.${a.name}(${a.args})`.localeCompare(`${b.schema}.${b.name}(${b.args})`),
  );
}

/** Whether a function body writes one of the four workspace tables. */
export function writesWorkspaceTable(body) {
  return new RegExp(WORKSPACE_TABLE_WRITE.source, 'i').test(body);
}

/** The `areas` key as a SQL string: `'areas'`, the escape form `E'areas'`,
 *  or a dollar quote `$$areas$$`, `$k$areas$k$`. */
const AREAS_KEY = String.raw`(?:(?:\bE)?'areas'|\$[A-Za-z_]?\w*\$areas\$[A-Za-z_]?\w*\$)`;

/** The direct reads of the `areas` key: `-> 'areas'`, `->> 'areas'`, `->
 *  ('areas')`, the subscript `['areas']`, a path `#> '{areas}'`, `#>>
 *  '{areas,x}'`, an array path `#> array['areas']`, `#>> ARRAY['areas',
 *  'x']`, the key tests `? 'areas'`, `?| array['areas']`, a containment
 *  `@> '{"areas": ...}'` (or `<@`), and a JSON path `'$.areas'`,
 *  `'$."areas".x'`, `@.areas`. */
const AREAS_READ = new RegExp(
  [
    String.raw`->>?\s*\(?\s*${AREAS_KEY}`,
    String.raw`\[\s*\(?\s*${AREAS_KEY}\s*\)?\s*\]`,
    String.raw`#>>?\s*(?:\bE)?(?:'|\$[A-Za-z_]?\w*\$)\{\s*"?areas"?\s*[,}]`,
    String.raw`\barray\s*\[\s*${AREAS_KEY}\s*[,\]]`,
    String.raw`\?[|&]?\s*\(?\s*${AREAS_KEY}`,
    String.raw`(?:@>|<@)\s*\(?\s*(?:\bE)?(?:'|\$[A-Za-z_]?\w*\$)\s*\{\s*"areas"\s*:`,
    String.raw`[$@]\s*\.\s*"?areas\b`,
  ].join('|'),
  'i',
);

/** Whether a function body or SQL text decides an Admin area itself (reads
 *  the `areas` limits of a workspace user): AREAS_READ, or the key as an
 *  argument of `json(b)_extract_path(_text)(x, 'areas', ...)` or of
 *  `json(b)_build_object('areas', ...)` (a containment built to test the
 *  limits). */
export function readsAreaLimits(body) {
  if (AREAS_READ.test(body)) return true;
  for (const m of body.matchAll(/\bjsonb?_(?:extract_path(?:_text)?|build_object)\s*\(/gi)) {
    const args = balanced(body, m.index + m[0].length - 1);
    if (new RegExp(AREAS_KEY, 'i').test(args)) return true;
  }
  return false;
}

/** Whether a SQL function is a copy of "set the assistant of a workspace".
 *  By name, as tsSetAssistantDefs: a progress counter only (it falls when
 *  a named copy goes), not a guard; a copy under another name is not seen.
 *  A body check (writes workspace_resources with 'assistant') is no better:
 *  it finds the one-off backfills (mantle_ws_attach_assistants,
 *  mantle_ws_migrate_bridged), not the setter. */
export function isSetAssistantFn(name) {
  return /set_assistant/i.test(name);
}

/** SQL `body` with `--` and block comments blanked (a function body keeps
 *  its comments in the catalog), read as stripSqlComments reads. */
function dropSqlComments(body) {
  return stripSqlComments(body);
}

const SQL_WORDS = new Set(
  'where on set join left right inner full cross natural lateral using group order limit and or union returning for having offset fetch values select from window'.split(
    ' ',
  ),
);

/** Whether a function body reads the role column of auth.users: `x.role`
 *  or `x."role"` for an alias `x` of auth.users (any quoting, `as` or
 *  not), or `users.role`. */
export function readsLoginRole(body) {
  const b = dropSqlComments(body);
  const aliases = new Set(['users']);
  let named = false;
  for (const m of b.matchAll(/\b"?auth"?\s*\.\s*"?users"?(?:\s+(?:as\s+)?"?([A-Za-z_]\w*)"?)?/gi)) {
    named = true;
    const a = m[1]?.toLowerCase();
    if (a && !SQL_WORDS.has(a)) aliases.add(a);
  }
  if (!named) return false;
  for (const m of b.matchAll(/\b"?([A-Za-z_]\w*)"?\s*\.\s*"?role"?(?![\w"])/gi)) {
    if (aliases.has(m[1].toLowerCase())) return true;
  }
  return false;
}

// ── tool pre-checks ────────────────────────────────────────────────────────

/** Legacy tool item pre-checks in `text` with no owner or no end date. */
export function legacyPrecheckUndated(text) {
  const code = stripComments(text);
  let n = 0;
  for (const m of code.matchAll(/\blegacyItemPrecheck\s*:\s*\{/g)) {
    const block = balanced(code, m.index + m[0].length - 1);
    if (!/\buntil\s*:/.test(block) || !/\bowner\s*:/.test(block)) n += 1;
  }
  return n;
}

/** The entries of the raw write SQL allowlist (0 until the list is made). */
export function rawWriteAllowlistEntries(root) {
  const text = readRepoFile(root, 'eslint-rules/raw-write-allowlist.mjs');
  if (text === null) return 0;
  return [...stripComments(text).matchAll(/^\s*['"][^'"\n]+['"]\s*:/gm)].length;
}

/**
 * Every rights count, from the counted files' texts ([{ path, text }]) and
 * the repo root.
 */
export function rightsCounts(root, texts, asSystem = asSystemExits(texts)) {
  const requestExits = requestSystemExits(texts);
  const exits = requestExits.byReason;
  let holdsAdmin = 0;
  let tsAreaSql = 0;
  let tsMembership = 0;
  let rawWrites = 0;
  let rowLocks = 0;
  let tsSetAssistant = 0;
  let undated = 0;
  for (const { path, text } of texts) {
    holdsAdmin += scopeHoldsAdminCalls(text);
    if (!isTestSupport(path)) {
      const k = tsAdminSqlKinds(text);
      tsAreaSql += k.rules;
      tsMembership += k.membership;
    }
    if (!isTestSupport(path)) {
      rawWrites += workspaceTableRawWrites(text);
      rowLocks += workspaceTableRowLocks(text);
    }
    tsSetAssistant += tsSetAssistantDefs(text);
    undated += legacyPrecheckUndated(text);
  }
  const fns = migrationFunctions(root);
  const writers = fns.filter((f) => writesWorkspaceTable(f.body));
  const exitTotal = Object.values(exits).reduce((a, b) => a + b, 0);
  // 'first-owner' is known: counted in requestSystemExits, with its own
  // pin note, never as other.
  const known =
    (exits.area ?? 0) +
    (exits['login-self'] ?? 0) +
    (exits['admin-write'] ?? 0) +
    (exits['first-owner'] ?? 0);
  const roleReaders = fns.filter((f) => readsLoginRole(f.body));
  const admin = adminCounts(root, texts);
  const routeMap = asSystemRouteMap(root);
  const routes = asSystemRouteCounts(asSystem.holders, {
    routes: routeMap.routes,
    reasons: asSystemReasons(root),
    source: routeMap.source,
  });
  const requestRoutes = requestSystemRouteMap(root);
  const spots = fullRouteSpots(root, texts);
  const wholeOnFull =
    routeMap.routes['admin-area'] === 'narrow' ? 0 : admin.numbers.systemWholeTools;
  return {
    numbers: {
      requestSystemExits: exitTotal,
      requestSystemExits_area: exits.area ?? 0,
      requestSystemExits_loginSelf: exits['login-self'] ?? 0,
      requestSystemExits_adminWrite: exits['admin-write'] ?? 0,
      requestSystemExits_other: exitTotal - known,
      // Plan v3.2 S7a: the exits whose why REQUEST_SYSTEM_ROUTE routes narrow.
      requestSystemExits_narrow: Object.entries(exits)
        .filter(([why]) => requestRoutes[why] === 'narrow')
        .reduce((a, [, n]) => a + n, 0),
      fullRouteSpots: spots.entries,
      fullRouteSpotCalls: spots.calls,
      fullRouteSpotWrapperCalls: spots.wrapperCalls,
      scopeHoldsAdminCalls: holdsAdmin,
      sqlAreaRules: fns.filter((f) => readsAreaLimits(f.body)).length + tsAreaSql,
      workspaceTableRawWrites: rawWrites,
      workspaceTableRowLocks: rowLocks,
      workspaceTableWriterFns: writers.length,
      setAssistantCopies: tsSetAssistant + fns.filter((f) => isSetAssistantFn(f.name)).length,
      legacyPrecheckUndated: undated,
      rawWriteAllowlist: rawWriteAllowlistEntries(root),
      sqlMembershipAsks: tsMembership,
      sqlRoleReaders: roleReaders.length,
      asSystemFull: routes.full,
      asSystemNarrow: routes.narrow,
      ...Object.fromEntries(
        Object.entries(routes.byReason)
          .filter(([, v]) => v.route === 'full')
          .map(([k, v]) => [`asSystemFull_${k}`, v.exits]),
      ),
      systemWholeOnFull: wholeOnFull,
      ...admin.numbers,
    },
    detail: {
      sqlRoleReaderFns: roleReaders.map((f) => f.name),
      asSystemRoutes: { source: routeMap.source, byReason: routes.byReason },
      asSystemRouteProblems: [...routes.problems, ...spots.problems],
      ...admin.detail,
      adminCountProblems: admin.problems,
      requestSystemExits: exits,
      requestSystemExitProblems: requestExits.problems,
      workspaceTableWriterFns: writers.map((f) => ({
        fn: `${f.schema}.${f.name}(${f.args})`,
        definer: f.definer,
      })),
      sqlAreaRuleFns: fns.filter((f) => readsAreaLimits(f.body)).map((f) => f.name),
    },
  };
}

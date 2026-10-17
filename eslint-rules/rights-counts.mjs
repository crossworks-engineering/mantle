/**
 * The rights counts of the scoreboard (scripts/arch-scoreboard.ts): where
 * the code, not the database, still decides who may do what, and the lists
 * that excuse it. Read by eslint-rules/arch-counts.mjs measure(), pinned in
 * scripts/arch-scoreboard.pins.json, tested in arch-lints.test.ts.
 *
 *  - request system exits by reason: the request paths that leave the
 *    login's scope for the system pool (noteRequestSystem, and any wrapper
 *    that passes its reason on);
 *  - scopeHoldsAdmin calls: an Admin ask outside the database's own rule;
 *  - SQL area rules: SQL that decides an Admin area by itself, in a
 *    function the migrations leave (it reads the `areas` limits) or in SQL
 *    text in TypeScript (it joins workspace_users to the Admin workspace);
 *  - raw writes to the four workspace tables in TypeScript, and the SQL
 *    functions the migrations leave that write them;
 *  - the copies of "set the assistant of a workspace";
 *  - tool item pre-checks kept as legacy entries with no owner or end date;
 *  - A8 coverage: the registry kinds outside the grid and not exempt, and
 *    the tool policies (a write, or a read taking an item) with no matrix
 *    declaration; the A8 exemptions and the raw write SQL allowlist, each
 *    capped at its pin.
 *
 * The SQL functions are read from the migrations in journal order (create,
 * replace, rename, drop, security definer), so the count needs no
 * database; packages/db/src/rights-catalog.db.test.ts proves it equals the
 * live catalog after migrate.
 */
import { balanced, readRepoFile, stripComments } from './arch-counts.mjs';

/** The four workspace tables only definers should write. */
export const WORKSPACE_TABLES = Object.freeze([
  'workspaces',
  'workspace_users',
  'workspace_events',
  'workspace_resources',
]);

/** A write statement on one of the four workspace tables (SQL text, any
 *  quoting, with or without the public schema). */
export const WORKSPACE_TABLE_WRITE = new RegExp(
  String.raw`\b(?:insert\s+into|update|delete\s+from|merge\s+into|truncate(?:\s+table)?)\s+` +
    String.raw`(?:"?public"?\s*\.\s*)?"?(?:${WORKSPACE_TABLES.join('|')})"?(?![\w"])`,
  'gi',
);

/** Files the rights counts never read: test support writes fixtures. */
function isTestSupport(path) {
  return /(^|\/)test-support(\/|\.ts$)/.test(path);
}

// ── request system exits ───────────────────────────────────────────────────

const REQUEST_SYSTEM = 'noteRequestSystem';

/** The functions of `code` that pass their first parameter on to
 *  noteRequestSystem (session.ts noteSystem): name -> parameter. */
function requestSystemWrappers(code) {
  const out = new Map();
  const re = /\bfunction\s+(\w+)\s*\(\s*(\w+)/g;
  for (const m of code.matchAll(re)) {
    const open = code.indexOf('{', m.index + m[0].length);
    if (open < 0) continue;
    const body = balanced(code, open);
    if (new RegExp(String.raw`\b${REQUEST_SYSTEM}\s*\(\s*${m[2]}\s*\)`).test(body)) {
      out.set(m[1], m[2]);
    }
  }
  return out;
}

/**
 * The request system exits of `text` by reason: every call of
 * noteRequestSystem or of a wrapper that passes its reason on, with a
 * literal reason. A call with any other argument counts under 'unnamed'
 * (a reason the count cannot read is still an exit). A wrapper's own
 * forwarding call is not an exit; the calls of the wrapper are.
 */
export function requestSystemExits(text) {
  const code = stripComments(text);
  const wrappers = requestSystemWrappers(code);
  const names = [REQUEST_SYSTEM, ...wrappers.keys()];
  const params = new Set(wrappers.values());
  const out = {};
  const re = new RegExp(String.raw`\b(${names.join('|')})\s*\(`, 'g');
  for (const m of code.matchAll(re)) {
    if (/\bfunction\s+$/.test(code.slice(Math.max(0, m.index - 20), m.index))) continue;
    const args = balanced(code, m.index + m[0].length - 1)
      .slice(1, -1)
      .trim();
    const lit = /^(['"])([\w-]+)\1$/.exec(args);
    if (!lit && params.has(args)) continue;
    const reason = lit ? lit[2] : 'unnamed';
    out[reason] = (out[reason] ?? 0) + 1;
  }
  return out;
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

/** The template literals of `code` (their raw text, `${}` parts kept). */
function templateLiterals(code) {
  const out = [];
  let i = code.indexOf('`');
  while (i >= 0) {
    let j = i + 1;
    let depth = 0;
    while (j < code.length) {
      const c = code[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (depth === 0 && c === '`') break;
      if (c === '$' && code[j + 1] === '{') {
        depth += 1;
        j += 2;
        continue;
      }
      if (depth > 0 && c === '}') depth -= 1;
      j += 1;
    }
    out.push(code.slice(i + 1, j));
    i = code.indexOf('`', j + 1);
  }
  return out;
}

/** SQL text in `text` that decides an Admin area or Admin user by itself:
 *  a template literal that reads a workspace user's `areas` limits, or
 *  that joins workspace_users to the Admin workspace and asks the login is
 *  enabled, for a login it is given (the whole "is this login an Admin
 *  user" rule). A list or a report that only shows `is_admin` is not a
 *  rule. */
export function tsAdminRuleSql(text) {
  return templateLiterals(stripComments(text)).filter(
    (t) =>
      readsAreaLimits(t) ||
      (/\bworkspace_users\b/.test(t) &&
        /\bis_admin\b/.test(t) &&
        /\bdisabled_at\b/.test(t) &&
        /\blogin_id\s*=\s*\$\{/.test(t)),
  ).length;
}

// ── workspace tables ────────────────────────────────────────────────────────

/** Raw SQL writes to the four workspace tables in `text`, and drizzle
 *  writes of their tables. */
export function workspaceTableRawWrites(text) {
  const code = stripComments(text);
  const sqlWrites = [...code.matchAll(WORKSPACE_TABLE_WRITE)].length;
  const typed = [
    ...code.matchAll(
      /\.(?:insert|update|delete)\(\s*(?:workspaces|workspaceUsers|workspaceEvents|workspaceResources)\s*\)/g,
    ),
  ].length;
  return sqlWrites + typed;
}

/** The TypeScript definitions of "set the assistant of a workspace". */
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
 *  dollar quotes (a function body keeps its own text). */
function stripSqlComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (c === '-' && n === '-') {
      const e = text.indexOf('\n', i);
      const end = e < 0 ? text.length : e;
      out += ' '.repeat(end - i);
      i = end;
      continue;
    }
    if (c === '/' && n === '*') {
      const e = text.indexOf('*/', i + 2);
      const end = e < 0 ? text.length : e + 2;
      out += text.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "'" && text[j + 1] === "'") j += 2;
        else if (text[j] === "'") break;
        else j += 1;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const dq = c === '$' ? /^\$([A-Za-z_]\w*)?\$/.exec(text.slice(i, i + 64)) : null;
    if (dq) {
      const e = text.indexOf(dq[0], i + dq[0].length);
      const end = e < 0 ? text.length : e + dq[0].length;
      out += text.slice(i, end);
      i = end;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
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

/** Whether a function body decides an Admin area itself (reads the
 *  `areas` limits of a workspace user). */
export function readsAreaLimits(body) {
  return /->>?\s*'areas'/i.test(body);
}

/** Whether a SQL function is a copy of "set the assistant of a workspace". */
export function isSetAssistantFn(name) {
  return /set_assistant/i.test(name);
}

// ── tool pre-checks and A8 coverage ─────────────────────────────────────────

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

/** Files holding tool definitions whose policies A8 covers. The dynamic
 *  tool runtime policies (runtime-policy.ts) and the gate's job policies
 *  are not builtins. */
export function toolPolicySwept(path) {
  return (
    (path.startsWith('packages/tools/src/') || path.startsWith('packages/runtime/src/')) &&
    path !== 'packages/tools/src/runtime-policy.ts' &&
    path !== 'packages/tools/src/tool-policy.ts'
  );
}

/** The object literal around `at` (from its `{`), or null. */
function enclosingObject(code, at) {
  let depth = 0;
  for (let i = at; i >= 0; i -= 1) {
    const c = code[i];
    if (c === '}') depth += 1;
    else if (c === '{') {
      if (depth === 0) return balanced(code, i);
      depth -= 1;
    }
  }
  return null;
}

/** Tool policies in `text` that A8 must cover (a write, or a read taking
 *  an item: itemArgs) and that declare no `matrix`. */
export function toolPoliciesUncovered(text) {
  const code = stripComments(text);
  let n = 0;
  for (const m of code.matchAll(/\beffect\s*:\s*'(read|write)'(?=\s*[,}])/g)) {
    const obj = enclosingObject(code, m.index);
    if (!obj) continue;
    if (m[1] === 'read' && !/\bitemArgs\s*:/.test(obj)) continue;
    if (!/\bmatrix\s*:/.test(obj)) n += 1;
  }
  return n;
}

/** The keys of the A8 exemption list in `text` (`A8_EXEMPT`, an object of
 *  key: reason), or null when the file has none. */
export function a8ExemptKeys(text) {
  const code = stripComments(text);
  const at = code.search(/\bconst\s+A8_EXEMPT\b/);
  if (at < 0) return null;
  const open = code.indexOf('{', code.indexOf('=', at));
  if (open < 0) return [];
  const block = balanced(code, open).slice(1, -1);
  const keys = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= block.length; i += 1) {
    const c = block[i];
    if (c === '{' || c === '[' || c === '(') depth += 1;
    if (c === '}' || c === ']' || c === ')') depth -= 1;
    if (i === block.length || (c === ',' && depth === 0)) {
      const k = /^\s*(?:'([^']+)'|"([^"]+)"|([\w$]+))\s*:/.exec(block.slice(start, i));
      if (k) keys.push(k[1] ?? k[2] ?? k[3]);
      start = i + 1;
    }
  }
  return keys;
}

/** The registry kinds the A8 grid leaves out (class other than
 *  'workspace'), from packages/client-types/src/kinds.ts. */
export function kindsOutsideGrid(root) {
  const text = readRepoFile(root, 'packages/client-types/src/kinds.ts') ?? '';
  const out = [];
  for (const m of text.matchAll(/^ {2}(\w+): \{\n {4}class: '(\w+)'/gm)) {
    if (m[2] !== 'workspace') out.push(m[1]);
  }
  return out;
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
export function rightsCounts(root, texts) {
  const exits = {};
  let holdsAdmin = 0;
  let tsAreaSql = 0;
  let rawWrites = 0;
  let tsSetAssistant = 0;
  let undated = 0;
  let toolsUncovered = 0;
  const exempt = [];
  for (const { path, text } of texts) {
    for (const [reason, n] of Object.entries(requestSystemExits(text))) {
      exits[reason] = (exits[reason] ?? 0) + n;
    }
    holdsAdmin += scopeHoldsAdminCalls(text);
    if (!isTestSupport(path)) tsAreaSql += tsAdminRuleSql(text);
    if (!isTestSupport(path)) rawWrites += workspaceTableRawWrites(text);
    tsSetAssistant += tsSetAssistantDefs(text);
    undated += legacyPrecheckUndated(text);
    if (toolPolicySwept(path)) toolsUncovered += toolPoliciesUncovered(text);
    const keys = a8ExemptKeys(text);
    if (keys) exempt.push(...keys);
  }
  const fns = migrationFunctions(root);
  const writers = fns.filter((f) => writesWorkspaceTable(f.body));
  const exemptKinds = new Set(exempt.map((k) => k.replace(/^kind:/, '')));
  const kindsUncovered = kindsOutsideGrid(root).filter((k) => !exemptKinds.has(k)).length;
  const exitTotal = Object.values(exits).reduce((a, b) => a + b, 0);
  const known = (exits.area ?? 0) + (exits['login-self'] ?? 0) + (exits['admin-write'] ?? 0);
  return {
    numbers: {
      requestSystemExits: exitTotal,
      requestSystemExits_area: exits.area ?? 0,
      requestSystemExits_loginSelf: exits['login-self'] ?? 0,
      requestSystemExits_adminWrite: exits['admin-write'] ?? 0,
      requestSystemExits_other: exitTotal - known,
      scopeHoldsAdminCalls: holdsAdmin,
      sqlAreaRules: fns.filter((f) => readsAreaLimits(f.body)).length + tsAreaSql,
      workspaceTableRawWrites: rawWrites,
      workspaceTableWriterFns: writers.length,
      setAssistantCopies: tsSetAssistant + fns.filter((f) => isSetAssistantFn(f.name)).length,
      legacyPrecheckUndated: undated,
      a8Uncovered: kindsUncovered + toolsUncovered,
      a8Exempt: exempt.length,
      rawWriteAllowlist: rawWriteAllowlistEntries(root),
    },
    detail: {
      requestSystemExits: exits,
      workspaceTableWriterFns: writers.map((f) => ({
        fn: `${f.schema}.${f.name}(${f.args})`,
        definer: f.definer,
      })),
      sqlAreaRuleFns: fns.filter((f) => readsAreaLimits(f.body)).map((f) => f.name),
    },
  };
}

/**
 * The architecture counts (workspaces arch plan v2, sections 3 and 11; A0):
 * one place that measures the repo, read by the pinned-count lints in this
 * folder (their tests) and by scripts/arch-scoreboard.ts. Plain text
 * heuristics over product files, deterministic, no type checker:
 *
 *  - asSystem call sites per file, with the reasons they pass;
 *  - raw ACL column reads (read_ws, write_ws, home_ws) outside packages/db;
 *  - tool policy lists keyed by name (a list literal holding 3 or more
 *    builtin tool slugs) and their entries;
 *  - route policy lists (a list literal holding 3 or more route patterns);
 *  - route files, 410 stubs, guard calls, and reads of the caller the
 *    pipeline answers (ownerCaller(), A4 step 3b);
 *  - TS kind lists (a list literal holding 5 or more node_type values);
 *  - hand kind lists (A10 #12): any list literal of 3 or more node_type
 *    values outside the kind registry, pinned at 0 outside KIND_LIST_ALLOW;
 *  - hand role lists (A10 #13): a list literal, string union or comparison
 *    chain of role, area or actor names outside its source file
 *    (ROLE_NAME_SOURCES), pinned at 0;
 *  - switch-over code (brainOnWorkspacesNow calls, MANTLE_ADMIN_READS);
 *  - store write API importers (the disk stores of plan section 6);
 *  - route files that read their request body directly (A10 part 2, fold
 *    1), and that put a caught error's text in a reply (fold 2), outside
 *    and inside the named lists (route-plumbing.mjs);
 *  - rate limit calls in route files (A10 #8), outside the named list, and
 *    the named files (route-plumbing.mjs RATE_LIMIT_ALLOW);
 *  - the provider HTTP copies (A10 #10): inline deadlines, hand abort
 *    timers, private withTimeout copies, Retry-After reads and sleeping
 *    retry loops, outside and inside the named lists (provider-http.mjs);
 *  - the app brokers (A10 #9): hand calls of the export sync outside the
 *    one write path and the named files, and the files holding app tool
 *    broker logic outside the one broker (app-broker.mjs).
 *
 * Comment lines never count. Product files only: packages/, server/,
 * scripts/; no tests, migrations, archive or build folders (a route segment
 * of server/web/app/ is not one) or generated manifests.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CALLER_READERS, SESSION_GUARDS } from './session-guards.mjs';
import {
  BODY_READ_ALLOW,
  ERROR_TEXT_ALLOW,
  RATE_LIMIT_ALLOW,
  directBodyReads,
  errorTextReplies,
  rateLimitCalls,
} from './route-plumbing.mjs';
import { PROVIDER_HTTP_PATTERNS } from './provider-http.mjs';
import {
  EXPORT_SYNC_ALLOW,
  EXPORT_SYNC_HOME,
  appToolBrokerLogic,
  exportSyncCalls,
} from './app-broker.mjs';

/** Whether the counts read `path` (repo-relative). */
export function isCounted(path) {
  if (!path || !/\.(ts|tsx|mjs|js)$/.test(path)) return false;
  if (/\.test\.tsx?$/.test(path) || path.endsWith('.d.ts')) return false;
  if (!/^(packages|server|scripts)\//.test(path)) return false;
  if (path.startsWith('packages/db/migrations/')) return false;
  if (/(^|\/)(node_modules|\.next)\//.test(path)) return false;
  // Archive, build, public and dist folders are not product code, except
  // under server/web/app/, where such a folder is a route segment
  // (/api/apps/:id/build, /api/workspaces/:id/archive): those route files
  // count (A4 step 3b part 4).
  if (!path.startsWith('server/web/app/') && /(^|\/)(archive|dist|build|public)\//.test(path)) {
    return false;
  }
  if (path.endsWith('.gen.ts')) return false;
  // The scoreboard names what it counts.
  if (path.startsWith('scripts/arch-scoreboard')) return false;
  return true;
}

/** The repo's counted files, repo-relative, sorted. */
export function countedFiles(root) {
  const out = execFileSync(
    'git',
    // Tracked files only (A0 fix round 2, L-7): an untracked local file
    // would make a local run differ from CI's.
    ['ls-files', 'packages', 'server', 'scripts'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return out
    .split('\n')
    .filter((f) => isCounted(f))
    .sort();
}

/** Read a repo file, or null when git lists it but the tree has none. */
export function readRepoFile(root, path) {
  try {
    return readFileSync(join(root, path), 'utf8');
  } catch {
    return null;
  }
}

/**
 * `text` with comments blanked (line by line, so line numbers hold): block
 * comments, line comments, and lines that are part of a block comment.
 * Strings and template literals are kept; a `//` inside one is not a
 * comment.
 */
export function stripComments(text) {
  let out = '';
  let i = 0;
  let mode = 'code'; // code | block | line | ' | " | `
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (mode === 'code') {
      if (c === '/' && n === '*') {
        mode = 'block';
        out += '  ';
        i += 2;
        continue;
      }
      if (c === '/' && n === '/') {
        mode = 'line';
        out += '  ';
        i += 2;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') mode = c;
      out += c;
      i += 1;
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && n === '/') {
        mode = 'code';
        out += '  ';
        i += 2;
        continue;
      }
      out += c === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }
    if (mode === 'line') {
      if (c === '\n') {
        mode = 'code';
        out += '\n';
      } else out += ' ';
      i += 1;
      continue;
    }
    // In a string: keep it, end on its quote (a backslash escapes).
    if (c === '\\') {
      out += c + (n ?? '');
      i += 2;
      continue;
    }
    if (c === mode || (c === '\n' && mode !== '`')) mode = 'code';
    out += c;
    i += 1;
  }
  return out;
}

/** The text from the bracket at `open` to its match (inclusive), skipping
 *  strings; the rest of the text when it never closes. */
function balanced(text, open) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const stack = [];
  let quote = null;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
}

/** The plain string literals in `text` ('x' and "x", no templates). */
function stringsIn(text) {
  const out = [];
  const re = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g;
  let m;
  while ((m = re.exec(text))) out.push(m[1] ?? m[2]);
  return out;
}

/** Each list literal of `code` (comments stripped): an array literal
 *  assigned or passed to new Set / new Map. Nested lists belong to the
 *  outer one. Returns their texts. */
export function listLiterals(code) {
  const out = [];
  const re = /(?:new\s+(?:Set|Map)\s*(?:<[^>()]*>)?\s*\(\s*|(?:=|:\s*[\w<>[\],\s.|']*=)\s*)\[/g;
  let m;
  let end = 0;
  while ((m = re.exec(code))) {
    const open = m.index + m[0].length - 1;
    if (open < end) continue;
    const list = balanced(code, open);
    end = open + list.length;
    out.push(list);
  }
  return out;
}

// ── asSystem ────────────────────────────────────────────────────────────────

const AS_SYSTEM_CALL = /\basSystem\s*(?:<[^>()]*>)?\s*\(/g;

/** The asSystem call sites of `text`: how many, and the reasons they pass
 *  (the last string argument of each call), sorted and unique. The
 *  definition and imports are not calls. */
export function asSystemSites(text) {
  const code = stripComments(text);
  const reasons = new Set();
  let count = 0;
  let m;
  AS_SYSTEM_CALL.lastIndex = 0;
  while ((m = AS_SYSTEM_CALL.exec(code))) {
    const before = code.slice(Math.max(0, m.index - 20), m.index);
    if (/function\s+$/.test(before)) continue;
    count += 1;
    const call = balanced(code, m.index + m[0].length - 1);
    const lits = stringsIn(call);
    const last = lits[lits.length - 1];
    if (last && /^[a-z][a-z0-9:_-]*$/.test(last)) reasons.add(last);
  }
  return { count, reasons: [...reasons].sort() };
}

// ── raw ACL columns ─────────────────────────────────────────────────────────

export const RAW_ACL_PATTERN = /\b(read_ws|write_ws|home_ws|readWs|writeWs|homeWs)\b/;

/** Lines of `text` (comments exempt) that read a raw ACL column. */
export function rawAclLines(text) {
  return stripComments(text)
    .split('\n')
    .filter((l) => RAW_ACL_PATTERN.test(l)).length;
}

/** Whether the raw ACL count looks at `path`: outside packages/db. */
export function rawAclSwept(path) {
  return isCounted(path) && !path.startsWith('packages/db/');
}

// ── policy lists ────────────────────────────────────────────────────────────

/** Every builtin tool slug with an underscore (`slug: 'note_create'` in
 *  packages/tools/src, and the heartbeat tools of packages/runtime/src: A5
 *  step 6d, a list of those was not seen): a one-word slug ('search') is
 *  too common a word to say a list is about tools. */
export function builtinSlugs(root, files = countedFiles(root)) {
  const slugs = new Set();
  for (const f of files) {
    if (!f.startsWith('packages/tools/src/') && !f.startsWith('packages/runtime/src/')) continue;
    const text = readRepoFile(root, f);
    if (!text) continue;
    for (const m of text.matchAll(/\bslug:\s*'([a-z][a-z0-9]*_[a-z0-9_]+)'/g)) slugs.add(m[1]);
  }
  return slugs;
}

/** Whether a list literal is a list of definition objects (`[{ slug:
 *  'run_plan', handler, ... }, ...]`, RUN_TOOLS): definitions, each with its
 *  own policy (A5), not a policy list keyed by name. A real definition has a
 *  `handler` or an `inputSchema` besides its slug, so the list needs one of
 *  them per slug: a list of slug-only objects (`[{ slug: 'a' }, { slug: 'b'
 *  }]`), or one real definition among them, is a policy list and counts. */
export function isDefinitionList(list) {
  if (!/^\[\s*\{/.test(list)) return false;
  const slugKeys = list.match(/\bslug\s*:/g)?.length ?? 0;
  const defKeys = list.match(/\b(handler|inputSchema)\b/g)?.length ?? 0;
  return slugKeys > 0 && defKeys >= slugKeys;
}

/** The tool policy lists of `text`: lists holding 3 or more slugs, not
 *  counting a list of definition objects. */
export function toolPolicyLists(text, slugs) {
  return listLiterals(stripComments(text))
    .filter((l) => !isDefinitionList(l))
    .map((l) => stringsIn(l).filter((s) => slugs.has(s)).length)
    .filter((n) => n >= 3);
}

/** Whether tool policy lists are looked for in `path`: not the system
 *  manifest, whose lists are the tool groups a brain ships with (grants,
 *  not policy), nor the deferred tool selection's core, alone on its file
 *  (packages/tools/src/selection/core.ts CORE_TOOL_SLUGS: which granted
 *  tools a turn sends in full, in a fixed order the prompt cache needs; it
 *  never adds, removes or narrows a grant, so it decides no access: A5 step
 *  6a). The rest of the selection (deferred.ts) is counted (fix round 1,
 *  LOW-9). */
export function toolPolicySwept(path) {
  return (
    isCounted(path) &&
    !path.startsWith('server/web/lib/system-manifest/') &&
    path !== 'packages/tools/src/selection/core.ts'
  );
}

const ROUTE_ENTRY = /^(?:(?:GET|POST|PUT|PATCH|DELETE|HEAD) \/|\/api(?:\/|$))/;

/** The route policy lists of `text`: lists holding 3 or more routes. */
export function routePolicyLists(text) {
  return listLiterals(stripComments(text))
    .map((l) => stringsIn(l).filter((s) => ROUTE_ENTRY.test(s)).length)
    .filter((n) => n >= 3);
}

/** Whether route policy lists are looked for in `path`: the HTTP tier's
 *  own code, not its route handlers. */
export function routePolicySwept(path) {
  return isCounted(path) && /^server\/web\/(lib|server)\//.test(path) && !/\/route\.ts$/.test(path);
}

// ── kinds ───────────────────────────────────────────────────────────────────

/** The node_type values (packages/db/src/schema/nodes.ts). */
export function nodeTypes(root) {
  const text = readRepoFile(root, 'packages/db/src/schema/nodes.ts') ?? '';
  const at = text.indexOf("pgEnum('node_type'");
  if (at < 0) return new Set();
  const list = balanced(text, text.indexOf('[', at));
  return new Set(stringsIn(list));
}

/** The kind lists of `text`: lists holding 5 or more node types. */
export function kindLists(text, types) {
  return listLiterals(stripComments(text))
    .map((l) => stringsIn(l).filter((s) => types.has(s)).length)
    .filter((n) => n >= 5);
}

// ── hand kind lists (A10 #12) ───────────────────────────────────────────────

/** The files that may hold a literal list of kind names, each with why. Every
 *  other list of kinds is a filter over the kind registry
 *  (packages/client-types/src/kinds.ts, its lists in kind-lists.ts). */
export const KIND_LIST_ALLOW = Object.freeze({
  'packages/db/src/schema/nodes.ts':
    'the node_type enum: the SQL type the registry mirrors (kinds.test.ts and the db test kind-registry.db.test.ts pin them to one set)',
});

/** The string entries of a list literal `[...]` at its own level (not in a
 *  nested list, object or call). */
export function ownStrings(list) {
  const out = [];
  let depth = 0;
  for (let i = 1; i < list.length - 1; i += 1) {
    const c = list[i];
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < list.length && list[j] !== c) j += list[j] === '\\' ? 2 : 1;
      if (depth === 0 && c !== '`') out.push(list.slice(i + 1, j));
      i = j;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
  }
  return out;
}

/** Each list literal of `code` (comments stripped), nested ones too: an
 *  array literal where an expression starts (after `=`, `(`, `,`, `:`, `[`,
 *  `!`, `?`, `=>`, `return` or a line start), so a Set's, a z.enum's and an
 *  inline `[...].includes(` are lists, and a type (`string[]`) or an index
 *  (`a['x']`) is not. */
export function arrayLiterals(code) {
  const out = [];
  for (const m of code.matchAll(/(?:^|[=(,:[!?]|=>|\breturn)\s*\[/gm)) {
    out.push(balanced(code, m.index + m[0].length - 1));
  }
  return out;
}

/** The hand kind lists of `text`: list literals whose own string entries
 *  name 3 or more node types, node types being at least half of them (a
 *  list of tool group slugs that happens to hold 'journal', 'email' and
 *  'location' among a dozen others is not one). */
export function handKindLists(text, types) {
  return arrayLiterals(stripComments(text))
    .map((l) => {
      const own = ownStrings(l);
      const hits = own.filter((s) => types.has(s)).length;
      return hits >= 3 && hits * 2 >= own.length ? hits : 0;
    })
    .filter((n) => n > 0);
}

// ── hand role lists (A10 #13) ───────────────────────────────────────────────

/** The source of each name list (role, area and actor names): the file and
 *  the `export const NAME = [` list in it. A literal list, a string union
 *  or a comparison chain whose own strings are all names of one concept,
 *  `min` or more of them (a negative `min` counts back from the whole
 *  list), is a hand copy of it anywhere but its source file
 *  (docs/actors.md, "Role and area names"). */
export const ROLE_NAME_SOURCES = Object.freeze({
  loginRole: { file: 'packages/client-types/src/role-names.ts', list: 'LOGIN_ROLES', min: 2 },
  historyActor: {
    file: 'packages/client-types/src/role-names.ts',
    list: 'HISTORY_ACTORS',
    min: 3,
  },
  recallActor: {
    file: 'packages/client-types/src/role-names.ts',
    list: 'RECALL_ACTOR_KINDS',
    min: 2,
  },
  workspaceArea: {
    file: 'packages/client-types/src/dto/workspaces.ts',
    list: 'WORKSPACE_AREAS',
    min: 3,
  },
  accessLevel: { file: 'packages/client-types/src/dto/access.ts', list: 'ACCESS_LEVELS', min: 3 },
  // The key areas are ordinary words (pages, notes, files): a subset is
  // often a list of something else, so only a near-whole copy counts.
  keyArea: {
    file: 'packages/client-types/src/dto/access-keys.ts',
    list: 'ACCESS_KEY_AREAS',
    min: -1,
  },
});

/** Each concept's names and the count that makes a copy, read from the
 *  source files of `root` (a missing source names nothing). */
export function roleNameSets(root) {
  const out = {};
  for (const [concept, src] of Object.entries(ROLE_NAME_SOURCES)) {
    const text = readRepoFile(root, src.file) ?? '';
    const at = text.indexOf(`export const ${src.list} = [`);
    if (at < 0) continue;
    const values = new Set(ownStrings(balanced(text, text.indexOf('[', at))));
    const min = src.min < 0 ? values.size + src.min : src.min;
    out[concept] = { values, min: Math.max(2, Math.min(min, values.size)), file: src.file };
  }
  return out;
}

/** A string literal union: two or more quoted strings joined by `|` (a
 *  `null` or `undefined` member is not a name). */
const STRING_UNION = /'[\w-]+'(?:\s*\|\s*(?:'[\w-]+'|null|undefined))+/g;

/** A comparison chain on one subject: `x === 'a' || x === 'b'`. */
const COMPARE_CHAIN = /([\w$.]+)\s*[!=]==\s*'[\w-]+'(?:\s*(?:\|\||&&)\s*\1\s*[!=]==\s*'[\w-]+')+/g;

/** A `typeof x === 'string'` test: a type, not a name (blanked before the
 *  chains are read, so `typeof r === 'string' && r !== 'admin' && r !==
 *  'member'` is the chain of two roles it is). */
const TYPEOF_TEST = /typeof\s+[\w$.]+\s*[!=]==\s*'[\w-]+'/g;

/** The name lists of `text` (comments stripped): the own strings of each
 *  list literal, string union and comparison chain. */
export function nameLists(text) {
  const code = stripComments(text).replace(TYPEOF_TEST, (m) => ' '.repeat(m.length));
  const quotedIn = (t) => [...t.matchAll(/'([\w-]+)'/g)].map((m) => m[1]);
  return [
    ...arrayLiterals(code).map(ownStrings),
    ...[...code.matchAll(STRING_UNION)].map((m) => quotedIn(m[0])),
    ...[...code.matchAll(COMPARE_CHAIN)].map((m) => quotedIn(m[0])),
  ];
}

/** The hand role lists of `text` at repo path `path`: { concept, n } for
 *  each list whose own strings are all names of one concept, at least its
 *  `min`. A list in its concept's source file is `allowed`. */
export function handRoleLists(text, sets, path = '') {
  const out = [];
  for (const own of nameLists(text)) {
    for (const [concept, set] of Object.entries(sets)) {
      if (own.length >= set.min && own.every((v) => set.values.has(v))) {
        out.push({ concept, n: own.length, allowed: path === set.file });
      }
    }
  }
  return out;
}

/** A regex that finds calls of any of `names`: `name(`. */
function callRegex(names) {
  return new RegExp(`\\b(?:${names.join('|')})\\s*\\(`, 'g');
}

// ── routes ──────────────────────────────────────────────────────────────────

/** The guard calls counted: the Or401 guards of the one list
 *  (session-guards.mjs), getOwnerOr401 and its variants that answer a
 *  refusal (not the WithSource and WithLogin forms, nor the asset and
 *  require guards: the count has always been these). */
const GUARD_CALL = callRegex(SESSION_GUARDS.filter((n) => /^get[A-Za-z]*Or401$/.test(n)));

/** Whether `path` is a route file of the HTTP tier. */
export function isRouteFile(path) {
  return /^server\/web\/app\/.*\/route\.ts$/.test(path);
}

/** A route file's guard calls (getOwnerOr401 and its variants). */
export function guardCalls(text) {
  return (stripComments(text).match(GUARD_CALL) ?? []).length;
}

const CALLER_READ = callRegex(CALLER_READERS);

/** A route file's reads of the caller the pipeline answers (A4 step 3b:
 *  ownerCaller(), where a guard call was). The gate answered the caller
 *  before the handler ran, so a file that reads it is guarded. */
export function callerReads(text) {
  return (stripComments(text).match(CALLER_READ) ?? []).length;
}

/** Whether a route file is a retired route's 410 stub: it answers through
 *  lib/gone.ts (gone(), goneResponse()), which logs each hit. A raw 410 for
 *  a missing resource is not a stub (A0 fix round 2, L-8). */
export function isGoneStub(text) {
  return /\bgone(?:Response)?\s*\(/.test(stripComments(text));
}

/**
 * The route files a route file takes a handler from (an /api/v1 alias:
 * `export { GET } from '../../notes/route'`, or `import { GET as base }
 * from '...'`), repo-relative: each relative specifier naming a route file.
 * A4 hand batch B: such a file reads the caller where the handler it takes
 * reads it (the manifest generator follows it the same way), so it is no
 * live route calling no guard.
 */
export function routesTaken(text, path) {
  const dir = path.split('/').slice(0, -1);
  const out = [];
  for (const m of stripComments(text).matchAll(/\bfrom\s+'(\.{1,2}\/[^']*\/route)'/g)) {
    const parts = [...dir];
    for (const seg of m[1].split('/')) {
      if (seg === '..') parts.pop();
      else if (seg !== '.') parts.push(seg);
    }
    out.push(`${parts.join('/')}.ts`);
  }
  return out;
}

// ── switch-over ─────────────────────────────────────────────────────────────

/** brainOnWorkspacesNow call sites of `text` (not its definition). */
export function brainOnWorkspacesCalls(text) {
  const code = stripComments(text);
  let n = 0;
  for (const m of code.matchAll(/\bbrainOnWorkspacesNow\s*\(/g)) {
    if (!/function\s+$/.test(code.slice(Math.max(0, m.index - 20), m.index))) n += 1;
  }
  return n;
}

/** Whether `text` (comments exempt) names MANTLE_ADMIN_READS. */
export function namesAdminReads(text) {
  return /\bMANTLE_ADMIN_READS\b/.test(stripComments(text));
}

// ── store brokers ───────────────────────────────────────────────────────────

/** The disk stores (plan section 6) and how a file reaches each one's
 *  WRITE API (A3b): the write entry of the package, or the app SQL runner's
 *  writing functions and the store's directory setting. Readers keep the
 *  read entries (@mantle/tabledb, @mantle/storage) and are not counted. */
export const STORES = {
  tabledb: {
    why: 'table workbooks (SQLite): @mantle/tabledb/write',
    test: /from\s+'@mantle\/tabledb\/write'/,
  },
  objectstore: {
    why: 'file bytes and app bundles (RustFS): @mantle/storage/write',
    test: /from\s+'@mantle\/storage\/write'/,
  },
  appdb: {
    why: 'app databases (SQLite): the SQL runner writes, and APP_DB_DIR',
    test: /import\s*\{[^}]*\b(runAppSql|runAppSqlBatch|copyAppDbFile|adoptAppDbFile)\b[^}]*\}\s*from\s*'\.\/app-sql-runner'|\bAPP_DB_DIR\b/,
  },
};

/** The stores whose write API `text` reaches (comments exempt). */
export function storesReached(text) {
  const code = stripComments(text);
  return Object.keys(STORES).filter((k) => STORES[k].test.test(code));
}

// ── egress (A10 part 1) ─────────────────────────────────────────────────────

/** The packages whose fetches take outside URLs (eslint-rules/no-bare-fetch.mjs
 *  sweeps the same ones). */
export const BARE_FETCH_PACKAGES = [
  'packages/tools/src/',
  'packages/calendar/src/',
  'packages/content/src/',
];

/** Bare fetch call sites in `text` (comments exempt): `fetch(` not reached
 *  through an object, and `globalThis.fetch(`. No space before the paren
 *  (Prettier writes calls that way), so prose in a string ("pages to fetch
 *  (each…") is not a call. */
export function bareFetchSites(text) {
  const code = stripComments(text);
  let n = 0;
  for (const m of code.matchAll(/(^|[^.\w$])fetch\(|\bglobalThis\.fetch\(/g)) {
    const before = code.slice(Math.max(0, m.index - 12), m.index + (m[1]?.length ?? 0));
    if (/function\s*$/.test(before)) continue;
    n += 1;
  }
  return n;
}

// ── pinned-count rules ──────────────────────────────────────────────────────

/** The repo-relative path of `filename` (absolute or relative), from the
 *  first packages/, server/ or scripts/ segment; null outside them. */
export function repoPathOf(filename) {
  const f = filename.replace(/\\/g, '/');
  const m = /(?:^|\/)((?:packages|server|scripts)\/.*)$/.exec(f);
  return m ? m[1] : null;
}

/** An ESLint rule over a per-file count: it flags a file whose count is
 *  over its pin (an unlisted file's pin is 0). The tests pin the counts
 *  exactly; the rule is the editor's early warning. */
export function pinnedRule({ description, message, pins, swept, count, repoPath }) {
  return {
    meta: { type: 'problem', docs: { description }, messages: { over: message }, schema: [] },
    create(context) {
      const path = repoPath(context.filename);
      if (!path || !swept(path)) return {};
      return {
        Program(node) {
          const n = count(context.sourceCode.getText());
          const pin = Object.hasOwn(pins, path) ? pins[path] : 0;
          if (n > pin) context.report({ node, messageId: 'over' });
        },
      };
    },
  };
}

// ── writes inside read paths (plan 4.4; A2a) ────────────────────────────────

/** The named writes inside read paths: the keys of READ_PATH_WRITES in
 *  packages/db/src/actor.ts (each runs as system(repair:…) or
 *  system(backfill:…)). */
export function readPathWrites(root) {
  const text = readRepoFile(root, 'packages/db/src/actor.ts');
  if (text === null) return [];
  const m = /export const READ_PATH_WRITES = \{([\s\S]*?)\n\} as const;/.exec(text);
  if (!m) return [];
  return [...m[1].matchAll(/^\s*'((?:repair|backfill):[a-z0-9-]+)':/gm)].map((x) => x[1]).sort();
}

// ── the scoreboard ──────────────────────────────────────────────────────────

/**
 * The `_notes` a re-pin keeps (scripts/arch-scoreboard.ts --pin): a note
 * says why a pin went up, so it stays while its number is at or above that
 * pin and goes once the number came back down (A1 low, done in A2a).
 */
export function keptNotes(notes, oldPins, now) {
  const out = {};
  for (const [key, note] of Object.entries(notes ?? {})) {
    const pin = oldPins[key];
    const value = now[key];
    if (typeof pin === 'number' && typeof value === 'number' && value < pin) continue;
    out[key] = note;
  }
  return out;
}

/** Every repo number of plan section 3, plus the per-file maps the lints
 *  pin. */
export function measure(root) {
  const files = countedFiles(root);
  const slugs = builtinSlugs(root, files);
  const types = nodeTypes(root);
  const roleSets = roleNameSets(root);
  const asSystem = {};
  const rawAcl = {};
  const toolLists = {};
  const routeLists = {};
  const kinds = {};
  const handKinds = {};
  const handKindsAllowed = {};
  const handRoles = {};
  const handRolesAllowed = {};
  const stores = Object.fromEntries(Object.keys(STORES).map((k) => [k, []]));
  let routeFiles = 0;
  let apiRouteFiles = 0;
  let goneStubs = 0;
  let guards = 0;
  let guardFiles = 0;
  let liveUnguarded = 0;
  const liveUnguardedFiles = [];
  let reads = 0;
  let readFiles = 0;
  let bowCalls = 0;
  let bowFiles = 0;
  let adminReadsFiles = 0;
  const bareFetch = {};
  const bodyReadFiles = [];
  const bodyReadAllowed = [];
  const errorTextFiles = [];
  const errorTextAllowed = [];
  const rateLimitFiles = [];
  const rateLimitAllowed = [];
  let rateLimitCallsOutside = 0;
  const exportSync = {};
  const exportSyncAllowed = {};
  const brokerLogic = {};
  const providerHttp = Object.fromEntries(
    Object.keys(PROVIDER_HTTP_PATTERNS).map((k) => [k, { outside: {}, allowed: {} }]),
  );
  for (const f of files) {
    const text = readRepoFile(root, f);
    if (text === null) continue;
    const sys = asSystemSites(text);
    if (sys.count) asSystem[f] = sys;
    if (rawAclSwept(f)) {
      const n = rawAclLines(text);
      if (n) rawAcl[f] = n;
    }
    const tl = toolPolicySwept(f) ? toolPolicyLists(text, slugs) : [];
    if (tl.length) toolLists[f] = { lists: tl.length, entries: tl.reduce((a, b) => a + b, 0) };
    if (routePolicySwept(f)) {
      const rl = routePolicyLists(text);
      if (rl.length) routeLists[f] = rl.length;
    }
    const kl = kindLists(text, types);
    if (kl.length) kinds[f] = kl.length;
    const hk = handKindLists(text, types);
    if (hk.length) (KIND_LIST_ALLOW[f] ? handKindsAllowed : handKinds)[f] = hk.length;
    for (const r of handRoleLists(text, roleSets, f)) {
      const into = r.allowed ? handRolesAllowed : handRoles;
      into[f] = (into[f] ?? 0) + 1;
    }
    for (const s of storesReached(text)) stores[s].push(f);
    if (isRouteFile(f)) {
      routeFiles += 1;
      const code = stripComments(text);
      if (directBodyReads(code)) {
        (BODY_READ_ALLOW[f] ? bodyReadAllowed : bodyReadFiles).push(f);
      }
      if (errorTextReplies(code)) {
        (ERROR_TEXT_ALLOW[f] ? errorTextAllowed : errorTextFiles).push(f);
      }
      const limits = rateLimitCalls(code);
      if (limits) {
        if (RATE_LIMIT_ALLOW[f]) rateLimitAllowed.push(f);
        else {
          rateLimitFiles.push(f);
          rateLimitCallsOutside += limits;
        }
      }
      if (f.startsWith('server/web/app/api/')) apiRouteFiles += 1;
      const gone = isGoneStub(text);
      if (gone) goneStubs += 1;
      const g = guardCalls(text);
      guards += g;
      const r = callerReads(text);
      reads += r;
      if (r) readFiles += 1;
      if (g) guardFiles += 1;
      else if (!r && !gone && f.startsWith('server/web/app/api/')) {
        // An alias reads where the handler it takes reads (A4 hand batch B).
        const taken = routesTaken(text, f).some(
          (t) => callerReads(readRepoFile(root, t) ?? '') > 0,
        );
        if (!taken) {
          liveUnguarded += 1;
          liveUnguardedFiles.push(f);
        }
      }
    }
    const b = brainOnWorkspacesCalls(text);
    if (b) {
      bowCalls += b;
      bowFiles += 1;
    }
    if (namesAdminReads(text)) adminReadsFiles += 1;
    if (BARE_FETCH_PACKAGES.some((p) => f.startsWith(p))) {
      const n = bareFetchSites(text);
      if (n) bareFetch[f] = n;
    }
    const plain = stripComments(text);
    if (f !== EXPORT_SYNC_HOME) {
      const n = exportSyncCalls(plain);
      if (n) (Object.hasOwn(EXPORT_SYNC_ALLOW, f) ? exportSyncAllowed : exportSync)[f] = n;
    }
    const logic = appToolBrokerLogic(plain, f);
    if (logic) brokerLogic[f] = logic;
    for (const [k, { count, allowed }] of Object.entries(PROVIDER_HTTP_PATTERNS)) {
      const n = count(plain);
      if (n) providerHttp[k][Object.hasOwn(allowed, f) ? 'allowed' : 'outside'][f] = n;
    }
  }
  const sum = (o, k) => Object.values(o).reduce((a, v) => a + (k ? v[k] : v), 0);
  const reasons = new Set(Object.values(asSystem).flatMap((v) => v.reasons));
  return {
    numbers: {
      asSystemSites: sum(asSystem, 'count'),
      asSystemFiles: Object.keys(asSystem).length,
      asSystemReasons: reasons.size,
      rawAclFiles: Object.keys(rawAcl).length,
      rawAclLines: sum(rawAcl),
      toolPolicyLists: sum(toolLists, 'lists'),
      toolPolicyListFiles: Object.keys(toolLists).length,
      toolPolicyEntries: sum(toolLists, 'entries'),
      routePolicyLists: sum(routeLists),
      routeFiles,
      apiRouteFiles,
      goneStubs,
      guardCalls: guards,
      guardCallFiles: guardFiles,
      liveRoutesWithoutGuard: liveUnguarded,
      callerReads: reads,
      callerReadFiles: readFiles,
      kindLists: sum(kinds),
      handKindLists: sum(handKinds),
      handKindListsAllowed: sum(handKindsAllowed),
      handRoleLists: sum(handRoles),
      handRoleListsAllowed: sum(handRolesAllowed),
      brainOnWorkspacesCalls: bowCalls,
      brainOnWorkspacesFiles: bowFiles,
      adminReadsFiles,
      readPathWrites: readPathWrites(root).length,
      bareFetchSites: sum(bareFetch),
      routeBodyReadFiles: bodyReadFiles.length,
      routeBodyReadAllowed: bodyReadAllowed.length,
      routeErrorTextFiles: errorTextFiles.length,
      routeErrorTextAllowed: errorTextAllowed.length,
      routeRateLimitCalls: rateLimitCallsOutside,
      routeRateLimitAllowed: rateLimitAllowed.length,
      handExportSyncCalls: sum(exportSync),
      handExportSyncAllowed: Object.keys(exportSyncAllowed).length,
      appToolBrokerLogicFiles: Object.keys(brokerLogic).length,
      ...Object.fromEntries(
        Object.entries(providerHttp).flatMap(([k, v]) => [
          [`http_${k}`, sum(v.outside)],
          [`http_${k}_allowed`, sum(v.allowed)],
        ]),
      ),
      ...Object.fromEntries(Object.entries(stores).map(([k, v]) => [`store_${k}_files`, v.length])),
    },
    perFile: {
      asSystem,
      rawAcl,
      toolLists,
      routeLists,
      kinds,
      handKinds,
      handKindsAllowed,
      handRoles,
      handRolesAllowed,
      stores,
      liveUnguardedFiles,
      bareFetch,
      bodyReadFiles,
      bodyReadAllowed,
      errorTextFiles,
      errorTextAllowed,
      rateLimitFiles,
      rateLimitAllowed,
      exportSync,
      exportSyncAllowed,
      brokerLogic,
      providerHttp,
    },
  };
}

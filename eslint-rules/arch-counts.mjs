/**
 * The architecture counts (workspaces arch plan v2, sections 3 and 11; A0):
 * one place that measures the repo, read by the pinned-count lints in this
 * folder (their tests) and by scripts/arch-scoreboard.ts. Text heuristics
 * and syntax trees (the TypeScript parser) over product files,
 * deterministic, no type checker:
 *
 *  - asSystem call sites per file, with the reasons they pass, and the
 *    exits: the uses of the functions holding them (as-system-exits.mjs,
 *    which parses with the TypeScript parser); direct systemDb uses;
 *  - raw ACL column reads (read_ws, write_ws, home_ws) outside packages/db;
 *  - tool policy lists keyed by name (a list literal holding 3 or more
 *    builtin tool slugs) and their entries;
 *  - route policy lists (a list literal holding 3 or more route patterns);
 *  - route files, 410 stubs, guard calls, and reads of the caller the
 *    pipeline answers (ownerCaller(), A4 step 3b);
 *  - hand kind lists (A10 #12): any list of 3 or more node_type values
 *    (an array, a union, an object's keys, a comparison chain, a switch's
 *    shared cases, a SQL list: name-lists.mjs reads them from the syntax
 *    tree) outside the kind registry, pinned at 0 outside KIND_LIST_ALLOW;
 *  - hand role lists (A10 #13): the same forms (not an object's keys) of
 *    role, area or actor names outside its source file (ROLE_NAME_SOURCES),
 *    pinned at 0;
 *  - switch-over code (brainOnWorkspacesNow calls, MANTLE_ADMIN_READS);
 *  - store write API importers (the disk stores of plan section 6);
 *  - route files that read their request body directly (A10 part 2, fold
 *    1), and that put a caught error's text in a reply (fold 2), outside
 *    and inside the named lists (route-plumbing.mjs);
 *  - rate limit calls in any product file (A10 #8), outside the named list,
 *    and the named files (route-plumbing.mjs RATE_LIMIT_ALLOW);
 *  - the provider HTTP copies (A10 #10): inline deadlines, hand abort
 *    timers, private withTimeout copies, Retry-After reads and sleeping
 *    retry loops, outside and inside the named lists (provider-http.mjs);
 *  - the app brokers (A10 #9): hand calls of the export sync outside the
 *    one write path and the named files, and the files holding app tool
 *    broker logic outside the one broker (app-broker.mjs);
 *  - flags and env (A10 #11): raw process.env reads, hand parses of an env
 *    value, isXEnabled definitions and hand profile boolean defaults,
 *    outside and inside the named lists (env-flags.mjs);
 *  - hand re-index lines (A10 #7): notifyNodeIngested calls and raw
 *    node_ingested notifies, `embedding: null` resets and summary clears,
 *    outside markContentChanged and the files no-hand-reindex.mjs names;
 *  - spend recording (A10 #5): hand spend recording and provider calls that
 *    bypass the recording point, outside and inside the named lists
 *    (spend-recording.mjs);
 *  - small helpers copied back (A10 #15): UUID regex copies, the hand
 *    error-to-message idiom, dedupeTags copies, signal handlers, advisory
 *    locks, hand TTL age checks and Cache-Control values not from the table,
 *    outside and inside the named lists; console calls outside scripts, a
 *    hand live workspace and the files that set Cache-Control, pinned
 *    down only (std-helpers.mjs);
 *  - the rights counts (rights-counts.mjs): request system exits by reason,
 *    Admin asks and area rules in code and SQL, workspace table writers,
 *    the assistant copies, undated legacy pre-checks, A8 coverage and the
 *    capped exemption lists; the asSystem exits by route and the Admin
 *    counts (as-system-routes.mjs, admin-counts.mjs);
 *  - raw write SQL and history codes in comments (cleanup-counts.mjs).
 *  - the gateway split out of packages/db/src/client.ts: its modules'
 *    line limit and its import cycles (gateway-counts.mjs).
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
import { ENV_PATTERNS, allowedBy } from './env-flags.mjs';
import { SPEND_PATTERNS } from './spend-recording.mjs';
import {
  STD_HELPER_PATTERNS,
  archivedAtIsNull,
  consoleCalls,
  isScript,
  setsCacheControl,
} from './std-helpers.mjs';
import {
  EXPORT_SYNC_ALLOW,
  EXPORT_SYNC_HOME,
  appToolBrokerLogic,
  exportSyncCalls,
} from './app-broker.mjs';
import { REINDEX_ALLOW, handReindex } from './no-hand-reindex.mjs';
import { asSystemExits, clearParseCache, systemDbUses } from './as-system-exits.mjs';
import { nameListSites } from './name-lists.mjs';
import { checkDocQuotes } from './docs-quotes.mjs';
import { rightsCounts } from './rights-counts.mjs';
import { cleanupCounts } from './cleanup-counts.mjs';
import { gatewayCounts } from './gateway-counts.mjs';

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
  const hit = stripped.get(text);
  if (hit !== undefined) return hit;
  const out = stripCommentsOnce(text);
  // Bounded for a caller that never clears it (a lint run over the repo).
  if (stripped.size >= 4000) stripped.clear();
  stripped.set(text, out);
  return out;
}

/** stripComments' answers by text: every count strips each file once. The
 *  shared syntax trees (as-system-exits.mjs parse) are the other cache;
 *  clearCountCaches() drops both when measure() is done. */
const stripped = new Map();

/** Drop the caches the counts share (measure() calls it when it is done). */
export function clearCountCaches() {
  stripped.clear();
  clearParseCache();
}

function stripCommentsOnce(text) {
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
export function balanced(text, open) {
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
  return reasonedCallSites(text, AS_SYSTEM_CALL);
}

const SYSTEM_WORK_CALL = /\bsystemWork\s*(?:<[^>()]*>)?\s*\(/g;

/** The systemWork call sites of `text` (arch A6b fix round, L2: system work
 *  refuses any scope, and each file that runs it is pinned for review), as
 *  asSystemSites counts asSystem's. */
export function systemWorkSites(text) {
  return reasonedCallSites(text, SYSTEM_WORK_CALL);
}

/** The calls `re` (global) finds in `text`, comments stripped: how many,
 *  and the reasons they pass (each call's last string argument). */
function reasonedCallSites(text, re) {
  const code = stripComments(text);
  const reasons = new Set();
  let count = 0;
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(code))) {
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

/** The node_type values (packages/db/src/schema/nodes.ts), or an error: a
 *  lint or a count with no kinds to judge by would pass everything (A10 #13
 *  low round, L2). */
export function nodeTypes(root) {
  const path = 'packages/db/src/schema/nodes.ts';
  const text = readRepoFile(root, path) ?? '';
  const at = text.indexOf("pgEnum('node_type'");
  if (at < 0) throw new Error(`arch-counts: no node_type enum in ${join(root, path)}`);
  const list = balanced(text, text.indexOf('[', at));
  const types = new Set(stringsIn(list));
  if (!types.size) throw new Error(`arch-counts: the node_type enum in ${path} is empty`);
  return types;
}

// ── hand kind lists (A10 #12) ───────────────────────────────────────────────

/** The files that may hold a literal list of kind names, each with why. Every
 *  other list of kinds is a filter over the kind registry
 *  (packages/client-types/src/kinds.ts, its lists in kind-lists.ts). */
export const KIND_LIST_ALLOW = Object.freeze({
  'packages/db/src/schema/nodes.ts':
    'the node_type enum: the SQL type the registry mirrors (kinds.test.ts and the db test kind-registry.db.test.ts pin them to one set)',
  'packages/client-types/src/kinds.ts':
    'the kind registry itself: ITEM_KINDS is keyed by every kind, and every other list is a filter over it',
  'packages/db/src/matrix/guide-oracle.ts':
    'the access matrix oracle reads the guide, never the registry, on purpose: it is what checks the code (its kinds as the guide names them)',
  'packages/db/src/matrix/oracle.ts':
    'the access matrix oracle (actionApplies): which kinds an action changes, written from the guide so the matrix can catch the code',
  'packages/db/src/matrix/test-support/a8-grid.ts':
    "the access matrix grid's content tables and draft columns per kind: the schema's tables, which the grid writes to directly",
  'packages/runtime/src/assistant/stage-label.ts':
    'CREATE_NOUN is keyed by the noun of a `<thing>_create` tool slug (folder_create is no kind), not by kind',
  'server/web/components/share/contact-shares-menu.tsx':
    'KIND_ICON: an icon component per kind (lucide-react), which the zero-dependency registry cannot hold',
});

/** Whether every member of a `keys` site is a function: a dispatch table
 *  (behaviour per name, as a switch whose cases have their own bodies), not
 *  a list. Read from the site's form: name-lists.mjs marks it. */
const isDispatch = (site) => site.form === 'keys' && site.dispatch;

/** The hand kind list sites of `text` (at repo path `path`): each list
 *  whose own entries name 3 or more node types, node types being at least
 *  half of them (a list of tool group slugs that happens to hold
 *  'journal', 'email' and 'location' among a dozen others is not one).
 *  Every form name-lists.mjs reads counts: an array, a union, an object's
 *  keys (not a dispatch table), a comparison chain, the shared cases of a
 *  switch and a SQL list. `{ n, form, start, end }`. */
export function handKindListSites(text, types, path = 'x.ts', sites = nameListSites(path, text)) {
  const out = [];
  for (const site of sites) {
    if (isDispatch(site)) continue;
    const hits = site.strings.filter((s) => types.has(s)).length;
    if (hits >= 3 && hits * 2 >= site.strings.length) {
      out.push({ n: hits, form: site.form, start: site.start, end: site.end });
    }
  }
  return out;
}

/** The hand kind lists of `text`: the number of kinds in each. `sites`:
 *  the file's name list sites when the caller has them already. */
export function handKindLists(text, types, path = 'x.ts', sites) {
  return handKindListSites(text, types, path, sites).map((s) => s.n);
}

/** A cheap test of whether a file can hold a name list of `names`: two or
 *  more of them written where a list entry is (quoted, as a string, a
 *  template or a SQL literal is; or as a key, `name:`, `name?:` or
 *  `name(`). Every entry nameListSites reads is written one of these ways,
 *  so a file that fails it holds no list (a fast path, not a heuristic). */
export function mayHoldNameList(names) {
  const alt = [...new Set(names)].map((n) => n.replace(/[^\w-]/g, '')).join('|');
  const re = new RegExp(`['"\`](${alt})['"\`]|\\b(${alt})\\??\\s*[:(]`, 'g');
  return (text) => {
    const seen = new Set();
    for (const m of text.matchAll(re)) {
      seen.add(m[1] ?? m[2]);
      if (seen.size >= 2) return true;
    }
    return false;
  };
}

// ── hand role lists (A10 #13) ───────────────────────────────────────────────

/** The source of each name list (role, area and actor names): the file and
 *  the `export const NAME = [` list in it. A literal list, a string union, a
 *  comparison chain, the shared cases of a switch or a SQL list whose own
 *  strings are all names of one concept, `min` or more of them (a negative
 *  `min` counts back from the whole list), is a hand copy of it anywhere but
 *  its source file (docs/actors.md, "Role and area names"). With
 *  `superset`, a list holding every name of the concept and more is one
 *  too (`'admin' | 'member' | 'client'`): build it from the source and name
 *  the extras (`LoginRole | 'client'`). */
export const ROLE_NAME_SOURCES = Object.freeze({
  loginRole: {
    file: 'packages/client-types/src/role-names.ts',
    list: 'LOGIN_ROLES',
    min: 2,
    superset: true,
  },
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
 *  source files of `root`. A source that is missing, or holds no list, is
 *  an error: a lint with no names to judge by would pass everything (A10
 *  #13 low round, L2). */
export function roleNameSets(root) {
  const out = {};
  for (const [concept, src] of Object.entries(ROLE_NAME_SOURCES)) {
    const text = readRepoFile(root, src.file);
    if (text === null) throw new Error(`arch-counts: no ${src.file} under ${root}`);
    const at = text.indexOf(`export const ${src.list} = [`);
    if (at < 0) throw new Error(`arch-counts: no \`export const ${src.list} = [\` in ${src.file}`);
    const values = new Set(stringsIn(balanced(text, text.indexOf('[', at))));
    if (!values.size) throw new Error(`arch-counts: ${src.list} in ${src.file} is empty`);
    const min = src.min < 0 ? values.size + src.min : src.min;
    out[concept] = {
      values,
      min: Math.max(2, Math.min(min, values.size)),
      file: src.file,
      superset: !!src.superset,
    };
  }
  return out;
}

/** The forms a role list is read in: not an object's keys (a table keyed by
 *  role is behaviour per role, and indexed by a LoginRole it is checked by
 *  the compiler). */
const ROLE_FORMS = new Set(['array', 'union', 'chain', 'switch', 'sql']);

/** The hand role lists of `text` at repo path `path`: `{ concept, n,
 *  allowed, start, end }` for each list whose own strings are all names of
 *  one concept, at least its `min`, or (a `superset` concept) every name of
 *  it and more. A list in its concept's source file is `allowed`. */
export function handRoleLists(text, sets, path = 'x.ts', sites = nameListSites(path, text)) {
  const out = [];
  for (const site of sites) {
    if (!ROLE_FORMS.has(site.form)) continue;
    const own = site.strings;
    for (const [concept, set] of Object.entries(sets)) {
      const copy = own.length >= set.min && own.every((v) => set.values.has(v));
      const superset =
        set.superset &&
        own.length > set.values.size &&
        [...set.values].every((v) => own.includes(v));
      if (copy || superset) {
        out.push({
          concept,
          n: own.length,
          superset: !copy,
          allowed: path === set.file,
          start: site.start,
          end: site.end,
        });
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
 *  over its pin (an unlisted file's pin is 0). `count` gets the text and
 *  the repo path. The tests pin the counts exactly; the rule is the
 *  editor's early warning. */
export function pinnedRule({ description, message, pins, swept, count, repoPath }) {
  return {
    meta: { type: 'problem', docs: { description }, messages: { over: message }, schema: [] },
    create(context) {
      const path = repoPath(context.filename);
      if (!path || !swept(path)) return {};
      return {
        Program(node) {
          const n = count(context.sourceCode.getText(), path);
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

// ── item pre-checks (A4 step 4, A5 step 6b) ─────────────────────────────────

/** Where the item pre-check's helpers live: the target makers (edit, manage,
 *  read) and the resolvers a policy's `items` may name. */
const ITEM_GATE = 'packages/tools/src/item-write-gate.ts';

/** The resolvers ITEM_GATE exports: `export const x: Resolver` and
 *  `export function x(...): Resolver`. A policy's `items` names one of
 *  them, or a list of targets. */
export function itemResolverNames(root) {
  const text = readRepoFile(root, ITEM_GATE);
  if (text === null) return [];
  const code = stripComments(text);
  const out = new Set();
  for (const m of code.matchAll(/export const ([A-Za-z_$][\w$]*)\s*:\s*Resolver\b/g)) out.add(m[1]);
  for (const m of code.matchAll(
    /export function ([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*:\s*Resolver\b/g,
  )) {
    out.add(m[1]);
  }
  return [...out].sort();
}

/** The tool item pre-checks of `text` (comments exempt): every policy
 *  `legacyItemPrecheck` (pre-check removal fix round A: the kept ones are
 *  named so, never like a normal policy field), and the old form a policy
 *  `items` value, a list of targets (edit(, manage(, read( or a literal
 *  `{ param`) or a resolver of `resolvers`. A schema's `items:` (a JSON
 *  schema array) is neither. */
export function itemPrecheckToolEntries(text, resolvers) {
  const code = stripComments(text);
  const named = resolvers.length ? `|(?:${resolvers.join('|')})\\b` : '';
  const re = new RegExp(
    `\\bitems\\s*:\\s*(?:\\[\\s*(?:(?:edit|manage|read)\\s*\\(|\\{\\s*param\\s*:)${named})` +
      `|\\blegacyItemPrecheck\\s*:\\s*\\{`,
    'g',
  );
  return [...code.matchAll(re)].length;
}

/** The HTTP item pre-check lists (server/web/lib/auth/route-scope.ts,
 *  itemWriteTarget): the item routes, the routes reached by another id, and
 *  the read and manage exceptions. */
export const ITEM_PRECHECK_ROUTE_FILE = 'server/web/lib/auth/route-scope.ts';
export const ITEM_PRECHECK_ROUTE_LISTS = Object.freeze([
  'ITEM_WRITE_PREFIXES',
  'ITEM_REF_PREFIXES',
  'ITEM_READ_WRITES',
  'ITEM_MANAGE_WRITES',
]);

/** The entries of each HTTP item pre-check list, by list (a list that is
 *  gone counts 0: the exit). */
export function itemPrecheckRouteEntries(root) {
  const code = stripComments(readRepoFile(root, ITEM_PRECHECK_ROUTE_FILE) ?? '');
  const out = {};
  for (const name of ITEM_PRECHECK_ROUTE_LISTS) {
    const at = code.search(new RegExp(`\\bconst ${name}\\b`));
    if (at < 0) {
      out[name] = 0;
      continue;
    }
    const list = balanced(code, code.indexOf('[', code.indexOf('=', at)));
    out[name] = stringsIn(list).filter((s) => ROUTE_ENTRY.test(s)).length;
  }
  return out;
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

/**
 * The write-role gap reruns (plan v3 S3, the `gapTables` pin): each role
 * switch in counted source (`set local role X`, `set role X`, `set session
 * role X`, `set role to X`, `set_config('role', X, ...)`, comments blanked)
 * to a role other than the pool's own (the write role, the workspace role).
 * Main's one was the checked rerun on a gap table as mantle_gap_writer
 * (client.ts); S3 closed the gap tables and removed it, so 0. It counts the
 * switch itself, not a list of tables: renaming a list or a role const does
 * not hide a rerun, since any target but the pool's own counts.
 *
 * Fix round 4: the plain and session forms (`SET ROLE`, `SET SESSION
 * ROLE`) count too. Their target must read as a role name (ROLE_NAME: an
 * interpolation, a name with an underscore as every role here has,
 * postgres, quoted or not), so a column update (`set role = 'admin'`) and
 * prose in a message (`SET ROLE to the shared viewer roles`) are no switch.
 */
export function gapRerunCount(files) {
  const SWITCH =
    /\bset\s+(?:local\s+|session\s+)?role\s+(?:to\s+)?("?[^\s`'";)=]+"?)|set_config\(\s*'role'\s*,\s*([^,)]+)/gi;
  const ROLE_NAME = /^["']?(?:\$\{[^}]+\}|[a-z0-9]*_[a-z0-9_]*|postgres)["']?$/i;
  // The pool's own roles are no rerun: the write role, and the workspace
  // role a read switches to (a test grid's reads, matrix/test-support).
  const WRITE = /^['"]?(?:\$\{(?:WRITE|VIEW)_ROLE\}|mantle_(?:write|view)_user)['"]?$/;
  let n = 0;
  for (const { text } of files) {
    for (const m of stripComments(text).matchAll(SWITCH)) {
      const target = (m[1] ?? m[2] ?? '').trim();
      if (m[1] !== undefined && !ROLE_NAME.test(target)) continue;
      if (!WRITE.test(target) && target.toLowerCase() !== 'none') n++;
    }
  }
  return n;
}

/**
 * The fail-open branches that are counted, not refused (plan v3.2 S4a, the
 * `failOpenSites` pin): each call of noteFailOpen, noteUnscopedYes or
 * noteScopedSystemWrite (packages/db/src/fail-open.ts, fail-open-sites.ts)
 * with a literal site, comments blanked. Six at S4a: scopeHoldsAdmin,
 * scopeHasArea (gateway/scope-answers.ts), typedWrite, loginWriteClient
 * (gateway/write-route.ts), the production allows of asSystem and
 * assertSystemDbCaller (viewer.ts). S4b turns each into a refusal, so 0. A
 * seventh fail-open branch is one more call here.
 */
export function failOpenSiteCount(files) {
  const CALL = /\bnote(?:FailOpen|UnscopedYes|ScopedSystemWrite)\(\s*'[a-z-]+'/g;
  let n = 0;
  for (const { text } of files) n += (stripComments(text).match(CALL) ?? []).length;
  return n;
}

/** The lines of one file (plan v3 section 6: dbClientLines). */
function lineCount(root, path) {
  return readFileSync(join(root, path), 'utf8').split('\n').length - 1;
}

/** Every repo number of plan section 3, plus the per-file maps the lints
 *  pin. */
export function measure(root) {
  const files = countedFiles(root);
  const slugs = builtinSlugs(root, files);
  const types = nodeTypes(root);
  const roleSets = roleNameSets(root);
  const mayHold = mayHoldNameList([
    ...types,
    ...Object.values(roleSets).flatMap((r) => [...r.values]),
  ]);
  const asSystem = {};
  const rawAcl = {};
  const toolLists = {};
  const routeLists = {};
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
  const envFlags = Object.fromEntries(
    Object.keys(ENV_PATTERNS).map((k) => [k, { outside: {}, allowed: {} }]),
  );
  const reindex = {};
  const reindexAllowed = {};
  const spend = Object.fromEntries(
    Object.keys(SPEND_PATTERNS).map((k) => [k, { outside: {}, allowed: {} }]),
  );
  const stdHelpers = Object.fromEntries(
    Object.keys(STD_HELPER_PATTERNS).map((k) => [k, { outside: {}, allowed: {} }]),
  );
  const consoleByFile = {};
  const archivedByFile = {};
  const cacheControlFiles = [];
  // The texts, once: the asSystem exits read every file (as-system-exits.mjs).
  const texts = [];
  const systemDb = {};
  const systemWork = {};
  const resolvers = itemResolverNames(root);
  const itemPrechecks = {};
  for (const f of files) {
    const text = readRepoFile(root, f);
    if (text === null) continue;
    texts.push({ path: f, text });
    const sys = asSystemSites(text);
    if (sys.count) asSystem[f] = sys;
    const sw = systemWorkSites(text);
    if (sw.count) systemWork[f] = sw;
    const sd = systemDbUses(f, text);
    if (sd) systemDb[f] = sd;
    const ip = itemPrecheckToolEntries(text, resolvers);
    if (ip) itemPrechecks[f] = ip;
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
    // One walk of the syntax tree for both name list counts, and none for a
    // file that names fewer than two of the names (most files: it keeps the
    // count fast enough for the tests that run it).
    const sites = mayHold(text) ? nameListSites(f, text) : [];
    const hk = handKindLists(text, types, f, sites);
    if (hk.length) (KIND_LIST_ALLOW[f] ? handKindsAllowed : handKinds)[f] = hk.length;
    for (const r of handRoleLists(text, roleSets, f, sites)) {
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
    // Every limiter call, route file or not (A10 #8 low round, L2): a limit
    // taken in a helper the handler calls first was invisible to a count of
    // route files only.
    const limits = rateLimitCalls(stripComments(text));
    if (limits) {
      if (Object.hasOwn(RATE_LIMIT_ALLOW, f)) rateLimitAllowed.push(f);
      else {
        rateLimitFiles.push(f);
        rateLimitCallsOutside += limits;
      }
    }
    const b = brainOnWorkspacesCalls(text);
    if (b) {
      bowCalls += b;
      bowFiles += 1;
    }
    if (namesAdminReads(text)) adminReadsFiles += 1;
    const ri = handReindex(text);
    if (ri.notify || ri.embedding || ri.summary) {
      (REINDEX_ALLOW[f] ? reindexAllowed : reindex)[f] = ri;
    }
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
    for (const [k, { count, allowed }] of Object.entries(ENV_PATTERNS)) {
      const n = count(plain);
      if (n) envFlags[k][allowedBy(allowed, f) ? 'allowed' : 'outside'][f] = n;
    }
    for (const [k, { count, allowed }] of Object.entries(SPEND_PATTERNS)) {
      const n = count(plain);
      if (n) spend[k][Object.hasOwn(allowed, f) ? 'allowed' : 'outside'][f] = n;
    }
    for (const [k, { count, allowed }] of Object.entries(STD_HELPER_PATTERNS)) {
      const n = count(plain, f);
      if (n) stdHelpers[k][Object.hasOwn(allowed, f) ? 'allowed' : 'outside'][f] = n;
    }
    if (!isScript(f)) {
      const c = consoleCalls(plain);
      if (c) consoleByFile[f] = c;
    }
    // The helper is the one spelling; every other is a hand copy.
    const a = f === 'packages/db/src/workspace-live.ts' ? 0 : archivedAtIsNull(plain);
    if (a) archivedByFile[f] = a;
    if (f !== 'server/web/lib/cache-control.ts' && setsCacheControl(plain)) {
      cacheControlFiles.push(f);
    }
  }
  const sum = (o, k) => Object.values(o).reduce((a, v) => a + (k ? v[k] : v), 0);
  const reasons = new Set(Object.values(asSystem).flatMap((v) => v.reasons));
  // The real system-pool exits (arch A6 fix round 1, L1), file by file:
  // every use of a function holding an asSystem call (as-system-exits.mjs).
  // This one number is what the plan's "at most 40" is about.
  const exits = asSystemExits(texts);
  const exitsByFile = exits.byFile;
  const routePrechecks = itemPrecheckRouteEntries(root);
  const docQuotes = checkDocQuotes(root);
  // Who decides rights in code, and the lists that excuse it (rights-counts.mjs).
  const rights = rightsCounts(root, texts, exits);
  // Raw write SQL and history codes in comments (cleanup-counts.mjs).
  const cleanup = cleanupCounts(root, texts);
  // One tree and one stripped text per file served every count above.
  clearCountCaches();
  // The gateway's guards (gateway-counts.mjs): the package's own name
  // resolves through its exports.
  const gateway = gatewayCounts(texts, {
    strip: stripComments,
    exports: JSON.parse(readFileSync(join(root, 'packages/db/package.json'), 'utf8')).exports,
  });
  return {
    numbers: {
      asSystemSites: sum(asSystem, 'count'),
      asSystemExits: sum(exitsByFile),
      systemDbUses: sum(systemDb),
      systemDbFiles: Object.keys(systemDb).length,
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
      handKindLists: sum(handKinds),
      handKindListsAllowed: sum(handKindsAllowed),
      handRoleLists: sum(handRoles),
      handRoleListsAllowed: sum(handRolesAllowed),
      brainOnWorkspacesCalls: bowCalls,
      brainOnWorkspacesFiles: bowFiles,
      adminReadsFiles,
      readPathWrites: readPathWrites(root).length,
      itemPrecheckTools: sum(itemPrechecks),
      itemPrecheckRoutes: sum(routePrechecks),
      ...rights.numbers,
      ...cleanup.numbers,
      bareFetchSites: sum(bareFetch),
      routeBodyReadFiles: bodyReadFiles.length,
      routeBodyReadAllowed: bodyReadAllowed.length,
      routeErrorTextFiles: errorTextFiles.length,
      routeErrorTextAllowed: errorTextAllowed.length,
      rateLimitCalls: rateLimitCallsOutside,
      rateLimitAllowed: rateLimitAllowed.length,
      handExportSyncCalls: sum(exportSync),
      handExportSyncAllowed: Object.keys(exportSyncAllowed).length,
      appToolBrokerLogicFiles: Object.keys(brokerLogic).length,
      ...Object.fromEntries(
        Object.entries(providerHttp).flatMap(([k, v]) => [
          [`http_${k}`, sum(v.outside)],
          [`http_${k}_allowed`, sum(v.allowed)],
        ]),
      ),
      ...Object.fromEntries(
        Object.entries(envFlags).flatMap(([k, v]) => [
          [`env_${k}`, sum(v.outside)],
          [`env_${k}_allowed`, sum(v.allowed)],
        ]),
      ),
      reindexNotifyCalls: sum(reindex, 'notify'),
      reindexEmbeddingResets: sum(reindex, 'embedding'),
      reindexSummaryClears: sum(reindex, 'summary'),
      reindexAllowedFiles: Object.keys(reindexAllowed).length,
      ...Object.fromEntries(
        Object.entries(spend).flatMap(([k, v]) => [
          [`spend_${k}`, sum(v.outside)],
          [`spend_${k}_allowed`, sum(v.allowed)],
        ]),
      ),
      ...Object.fromEntries(Object.entries(stores).map(([k, v]) => [`store_${k}_files`, v.length])),
      ...Object.fromEntries(
        Object.entries(stdHelpers).flatMap(([k, v]) => [
          [`std_${k}`, sum(v.outside)],
          [`std_${k}_allowed`, sum(v.allowed)],
        ]),
      ),
      consoleCalls: sum(consoleByFile),
      archivedAtIsNull: sum(archivedByFile),
      cacheControlFiles: cacheControlFiles.length,
      actorsMdLines: docQuotes.actorsMdLines,
      actorsHistoryRefs: docQuotes.actorsHistoryRefs,
      actorsStepRefs: docQuotes.actorsStepRefs,
      docQuotesDangling: docQuotes.docQuotesDangling,
      gapTables: gapRerunCount(texts),
      dbClientLines: lineCount(root, 'packages/db/src/client.ts'),
      ...gateway.numbers,
      failOpenSites: failOpenSiteCount(texts),
    },
    perFile: {
      asSystem,
      systemWork,
      asSystemExits: exitsByFile,
      asSystemHolders: exits.holders,
      asSystemExitProblems: exits.problems,
      systemDb,
      rawAcl,
      itemPrechecks,
      routePrechecks,
      rights: rights.detail,
      cleanup: cleanup.detail,
      toolLists,
      routeLists,
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
      envFlags,
      reindex,
      reindexAllowed,
      spend,
      stdHelpers,
      consoleByFile,
      archivedByFile,
      cacheControlFiles,
      gateway: gateway.detail,
    },
  };
}

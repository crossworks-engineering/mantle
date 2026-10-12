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
 *  - route files, 410 stubs, guard calls;
 *  - TS kind lists (a list literal holding 5 or more node_type values);
 *  - switch-over code (brainOnWorkspacesNow calls, MANTLE_ADMIN_READS);
 *  - store write API importers (the disk stores of plan section 6).
 *
 * Comment lines never count. Product files only: packages/, server/,
 * scripts/; no tests, migrations, archive folders or generated manifests.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Whether the counts read `path` (repo-relative). */
export function isCounted(path) {
  if (!path || !/\.(ts|tsx|mjs|js)$/.test(path)) return false;
  if (/\.test\.tsx?$/.test(path) || path.endsWith('.d.ts')) return false;
  if (!/^(packages|server|scripts)\//.test(path)) return false;
  if (path.startsWith('packages/db/migrations/')) return false;
  if (/(^|\/)(archive|node_modules|dist|build|public|\.next)\//.test(path)) return false;
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
 *  packages/tools/src): a one-word slug ('search') is too common a word to
 *  say a list is about tools. */
export function builtinSlugs(root, files = countedFiles(root)) {
  const slugs = new Set();
  for (const f of files) {
    if (!f.startsWith('packages/tools/src/')) continue;
    const text = readRepoFile(root, f);
    if (!text) continue;
    for (const m of text.matchAll(/\bslug:\s*'([a-z][a-z0-9]*_[a-z0-9_]+)'/g)) slugs.add(m[1]);
  }
  return slugs;
}

/** The tool policy lists of `text`: lists holding 3 or more slugs. */
export function toolPolicyLists(text, slugs) {
  return listLiterals(stripComments(text))
    .map((l) => stringsIn(l).filter((s) => slugs.has(s)).length)
    .filter((n) => n >= 3);
}

/** Whether tool policy lists are looked for in `path`: not the system
 *  manifest, whose lists are the tool groups a brain ships with (grants,
 *  not policy). */
export function toolPolicySwept(path) {
  return isCounted(path) && !path.startsWith('server/web/lib/system-manifest/');
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

// ── routes ──────────────────────────────────────────────────────────────────

const GUARD_CALL = /\bget[A-Za-z]*Or401\s*\(/g;

/** Whether `path` is a route file of the HTTP tier. */
export function isRouteFile(path) {
  return /^server\/web\/app\/.*\/route\.ts$/.test(path);
}

/** A route file's guard calls (getOwnerOr401 and its variants). */
export function guardCalls(text) {
  return (stripComments(text).match(GUARD_CALL) ?? []).length;
}

/** Whether a route file is a retired route's 410 stub: it answers through
 *  lib/gone.ts (gone(), goneResponse(), goneForMemberAsset()), which logs
 *  each hit. A raw 410 for a missing resource is not a stub (A0 fix round
 *  2, L-8). */
export function isGoneStub(text) {
  return /\bgone(?:Response|ForMemberAsset)?\s*\(/.test(stripComments(text));
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
 *  write API: the package import, or the store's directory setting. */
export const STORES = {
  tabledb: { why: 'table workbooks (SQLite)', test: /from\s+'@mantle\/tabledb'/ },
  objectstore: { why: 'file bytes (RustFS)', test: /from\s+'@mantle\/storage'/ },
  appdb: { why: 'app databases (SQLite), by APP_DB_DIR', test: /\bAPP_DB_DIR\b/ },
};

/** The stores whose write API `text` reaches (comments exempt). */
export function storesReached(text) {
  const code = stripComments(text);
  return Object.keys(STORES).filter((k) => STORES[k].test.test(code));
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
  const asSystem = {};
  const rawAcl = {};
  const toolLists = {};
  const routeLists = {};
  const kinds = {};
  const stores = Object.fromEntries(Object.keys(STORES).map((k) => [k, []]));
  let routeFiles = 0;
  let apiRouteFiles = 0;
  let goneStubs = 0;
  let guards = 0;
  let guardFiles = 0;
  let liveUnguarded = 0;
  let bowCalls = 0;
  let bowFiles = 0;
  let adminReadsFiles = 0;
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
    for (const s of storesReached(text)) stores[s].push(f);
    if (isRouteFile(f)) {
      routeFiles += 1;
      if (f.startsWith('server/web/app/api/')) apiRouteFiles += 1;
      const gone = isGoneStub(text);
      if (gone) goneStubs += 1;
      const g = guardCalls(text);
      guards += g;
      if (g) guardFiles += 1;
      else if (!gone && f.startsWith('server/web/app/api/')) liveUnguarded += 1;
    }
    const b = brainOnWorkspacesCalls(text);
    if (b) {
      bowCalls += b;
      bowFiles += 1;
    }
    if (namesAdminReads(text)) adminReadsFiles += 1;
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
      kindLists: sum(kinds),
      brainOnWorkspacesCalls: bowCalls,
      brainOnWorkspacesFiles: bowFiles,
      adminReadsFiles,
      readPathWrites: readPathWrites(root).length,
      ...Object.fromEntries(Object.entries(stores).map(([k, v]) => [`store_${k}_files`, v.length])),
    },
    perFile: { asSystem, rawAcl, toolLists, routeLists, kinds, stores },
  };
}

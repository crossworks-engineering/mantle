/**
 * gateway-counts: the guards of packages/db/src/gateway/, the modules split
 * out of packages/db/src/client.ts.
 *
 *  - GATEWAY_MAX_LINES: the most lines a gateway module may have.
 *    eslint.config.mjs sets it as max-lines on the folder, and the
 *    scoreboard pins it (dbGatewayMaxLines: the limit, or the longest
 *    module when one is over it, so a file that turns the lint off still
 *    fails the pin).
 *  - dbGatewayImportCycles: the gateway modules on an import cycle among
 *    the files of packages/db/src (relative imports and re-exports, type
 *    imports too), pinned at 0. A gateway module that imports client.ts is
 *    on one, since client.ts imports the gateway. A specifier may name the
 *    file as `.js`, and the package's own name (`@mantle/db`,
 *    `@mantle/db/client`) resolves through packages/db/package.json's
 *    exports; comments are stripped first.
 *  - dbGlobalKeyWrites and dbGlobalKeyReads: the globalThis.__mantle* keys
 *    are pools.ts's. A write of one (`=`, `??=`, `||=`, `&&=`, `delete`) in
 *    any other file of packages/db/src is pinned at 0; a read outside
 *    pools.ts at 1 (actorClient's closing check in gateway/actor-sql.ts,
 *    which sits below pools.ts and cannot import it).
 *
 * Product files only (the scoreboard's counted files): no tests. The
 * scoreboard passes its comment stripper (stripComments) and the package's
 * exports.
 */
import { posix } from 'node:path';

/** The most lines a gateway module may have. */
export const GATEWAY_MAX_LINES = 600;

const DB_SRC = 'packages/db/src/';
const GATEWAY = `${DB_SRC}gateway/`;
const POOLS = `${GATEWAY}pools.ts`;
const DB_PACKAGE = '@mantle/db';

/** The module specifiers of `code` (comments stripped) that may name a file
 *  of packages/db/src: relative ones and the package's own, from import,
 *  export ... from, and a dynamic import of a literal. */
function dbSpecifiers(code) {
  const out = [];
  const spec = String.raw`(\.{1,2}\/[^'"]+|@mantle\/db(?:\/[^'"]+)?)`;
  const re = new RegExp(
    String.raw`(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[\w*$\{\}\s,]+?\s+from\s+)?['"]` +
      spec +
      String.raw`['"]|\bimport\(\s*['"]` +
      spec +
      String.raw`['"]\s*\)`,
    'g',
  );
  for (const m of code.matchAll(re)) out.push(m[1] ?? m[2]);
  return out;
}

/** The repo path of `spec` imported from `from`, among `paths`, or null:
 *  a `.js` name is its `.ts` file; the package's own name goes through
 *  `exports` (packages/db/package.json's, `./client` -> `./src/client.ts`). */
function resolve(from, spec, paths, exports) {
  let base;
  if (spec === DB_PACKAGE || spec.startsWith(`${DB_PACKAGE}/`)) {
    const target = exports[`.${spec.slice(DB_PACKAGE.length)}`];
    if (typeof target !== 'string') return null;
    base = posix.normalize(posix.join('packages/db', target));
  } else {
    base = posix.normalize(posix.join(posix.dirname(from), spec));
  }
  const bare = base.replace(/\.(?:m?js|jsx)$/, '');
  for (const cand of [
    base,
    `${bare}.ts`,
    `${bare}.tsx`,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
  ]) {
    if (paths.has(cand)) return cand;
  }
  return null;
}

/** The gateway modules on an import cycle among `files` ([{ path, text }],
 *  repo-relative), sorted. Strongly connected components (Tarjan): a module
 *  in a component of two or more, or one that imports itself. `strip`
 *  blanks a text's comments; `exports` is packages/db/package.json's. */
export function gatewayCycleModules(files, { strip, exports }) {
  const db = files.filter((f) => f.path.startsWith(DB_SRC) && /\.tsx?$/.test(f.path));
  const paths = new Set(db.map((f) => f.path));
  const edges = new Map();
  for (const f of db) {
    const to = new Set();
    for (const spec of dbSpecifiers(strip(f.text))) {
      const t = resolve(f.path, spec, paths, exports);
      if (t) to.add(t);
    }
    edges.set(f.path, to);
  }
  let index = 0;
  const idx = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const cyclic = new Set();
  const visit = (v) => {
    idx.set(v, index);
    low.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), idx.get(w)));
      }
    }
    if (low.get(v) !== idx.get(v)) return;
    const comp = [];
    for (;;) {
      const w = stack.pop();
      onStack.delete(w);
      comp.push(w);
      if (w === v) break;
    }
    if (comp.length > 1 || edges.get(v)?.has(v)) for (const w of comp) cyclic.add(w);
  };
  for (const v of edges.keys()) if (!idx.has(v)) visit(v);
  return [...cyclic].filter((p) => p.startsWith(GATEWAY)).sort();
}

/** The lines of a text, as the scoreboard counts them. */
const lineCount = (text) => text.split('\n').length - 1;

/** A globalThis.__mantle* key in code: `globalThis.__mantleX`, also as
 *  `(globalThis as T).__mantleX`. */
const GLOBAL_KEY = /(?:\bglobalThis|\(\s*globalThis\s+as\s+[^)]*\))\s*\.\s*(__mantle\w*)/g;
/** What follows a key that writes it. */
const WRITE_AFTER = /^\s*(?:=(?!=)|\?\?=|\|\|=|&&=)/;

/** The globalThis.__mantle* writes and reads in each file of packages/db/src
 *  but pools.ts, as `path:line key` lists. */
export function globalKeySites(files, { strip }) {
  const writes = [];
  const reads = [];
  for (const f of files) {
    if (!f.path.startsWith(DB_SRC) || f.path === POOLS) continue;
    const code = strip(f.text);
    for (const m of code.matchAll(GLOBAL_KEY)) {
      const line = code.slice(0, m.index).split('\n').length;
      const before = code.slice(Math.max(0, m.index - 12), m.index);
      const write =
        WRITE_AFTER.test(code.slice(m.index + m[0].length)) || /\bdelete\s+$/.test(before);
      (write ? writes : reads).push(`${f.path}:${line} ${m[1]}`);
    }
  }
  return { writes, reads };
}

/** The gateway's numbers, and its modules over the limit or on a cycle.
 *  `strip` blanks a text's comments; `exports` is packages/db/package.json's. */
export function gatewayCounts(files, opts) {
  const modules = files.filter((f) => f.path.startsWith(GATEWAY));
  const longest = Math.max(0, ...modules.map((f) => lineCount(f.text)));
  const cycles = gatewayCycleModules(files, opts);
  const keys = globalKeySites(files, opts);
  return {
    numbers: {
      dbGatewayMaxLines: Math.max(GATEWAY_MAX_LINES, longest),
      dbGatewayImportCycles: cycles.length,
      dbGlobalKeyWrites: keys.writes.length,
      dbGlobalKeyReads: keys.reads.length,
    },
    detail: {
      globalKeyWrites: keys.writes,
      globalKeyReads: keys.reads,
      overLimit: modules
        .filter((f) => lineCount(f.text) > GATEWAY_MAX_LINES)
        .map((f) => `${f.path}: ${lineCount(f.text)}`),
      cycles,
    },
  };
}

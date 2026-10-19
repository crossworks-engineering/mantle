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
 *    on one, since client.ts imports the gateway.
 *
 * Product files only (the scoreboard's counted files): no tests.
 */
import { posix } from 'node:path';

/** The most lines a gateway module may have. */
export const GATEWAY_MAX_LINES = 600;

const DB_SRC = 'packages/db/src/';
const GATEWAY = `${DB_SRC}gateway/`;

/** The relative module specifiers of `text`: import, export ... from, and a
 *  dynamic import of a literal. */
function relativeSpecifiers(text) {
  const out = [];
  const re =
    /(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[\w*${}\s,]+?\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]|\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
  for (const m of text.matchAll(re)) out.push(m[1] ?? m[2]);
  return out;
}

/** The file `spec` names from `from`, among `paths`, or null. */
function resolve(from, spec, paths) {
  const base = posix.normalize(posix.join(posix.dirname(from), spec));
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    if (paths.has(cand)) return cand;
  }
  return null;
}

/** The gateway modules on an import cycle among `files` ([{ path, text }],
 *  repo-relative), sorted. Strongly connected components (Tarjan): a module
 *  in a component of two or more, or one that imports itself. */
export function gatewayCycleModules(files) {
  const db = files.filter((f) => f.path.startsWith(DB_SRC) && /\.tsx?$/.test(f.path));
  const paths = new Set(db.map((f) => f.path));
  const edges = new Map();
  for (const f of db) {
    const to = new Set();
    for (const spec of relativeSpecifiers(f.text)) {
      const t = resolve(f.path, spec, paths);
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

/** The gateway's numbers, and its modules over the limit or on a cycle. */
export function gatewayCounts(files) {
  const modules = files.filter((f) => f.path.startsWith(GATEWAY));
  const longest = Math.max(0, ...modules.map((f) => lineCount(f.text)));
  const cycles = gatewayCycleModules(files);
  return {
    numbers: {
      dbGatewayMaxLines: Math.max(GATEWAY_MAX_LINES, longest),
      dbGatewayImportCycles: cycles.length,
    },
    detail: {
      overLimit: modules
        .filter((f) => lineCount(f.text) > GATEWAY_MAX_LINES)
        .map((f) => `${f.path}: ${lineCount(f.text)}`),
      cycles,
    },
  };
}

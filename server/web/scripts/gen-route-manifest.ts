/**
 * Generates server/route-manifest.gen.ts from the app/ route-handler tree.
 *
 * The Hono server keeps Next's file-per-route convention (app/x/y/route.ts →
 * /x/y) — this script is the bridge: it scans app/**\/route.ts, extracts which
 * HTTP methods each file exports, converts the directory path to a Hono route
 * pattern, and emits a manifest of lazy `() => import(...)` thunks. Runs from
 * predev/prebuild (alongside app-runtime generation), so the manifest is always
 * in sync; the output is gitignored.
 *
 * Sorting: entries are ordered so that at every segment depth
 * literal > :param > catch-all — Next's routing precedence — and the loader
 * registers them in manifest order (Hono's RegExpRouter keeps registration
 * order for overlapping patterns).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeRouteFile,
  handlerPolicy,
  handlerSwitches,
  type HandlerCallers,
  type HandlerSwitches,
  type RouteFileReads,
} from './route-callers';
import { ROUTE_SWITCH_NAMES } from '../lib/auth/route-switches';
import type { RoutePolicyDeclaration } from '../lib/auth/route-declaration';
import { READER_ANSWERS } from '../../../eslint-rules/session-guards.mjs';

/** Every caller kind a reader reads (the one list, session-guards.mjs), in
 *  its order: the manifest's `reads` type. */
const CALLER_KINDS = [...new Set(Object.values(READER_ANSWERS).map((r) => r.caller))];

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const appDir = join(webRoot, 'app');

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

type Entry = {
  /** Path relative to server/web (posix), e.g. app/api/health/route.ts */
  file: string;
  /** Hono pattern, e.g. /api/tables/:id/export */
  pattern: string;
  methods: string[];
  /** Each method whose handler reads the caller the pipeline answers, to
   *  the caller kind its reader reads (arch A4 step 3b; route-callers.ts). */
  reads: HandlerCallers;
  /** Each method exported as a retired route's 410 stub (`gone(kind)`,
   *  lib/gone.ts; A4 hand batch A): its row is a gone row. */
  gone: string[];
  /** Each method to the switch its route file declares (`routeSwitches`,
   *  lib/auth/route-switches.ts; A4 hand batch A): its rows' switch. */
  switches: HandlerSwitches;
  /** The policy the route file declares (`policy`,
   *  lib/auth/route-declaration.ts; plan v3.2 S9), or null: none. */
  policy: RoutePolicyDeclaration | null;
  /** Name of the catch-all param when the pattern ends in /*, else null. */
  catchAll: string | null;
  /** Whether a catch-all also matches the bare prefix ([[...x]] optional form). */
  catchAllOptional: boolean;
  segments: string[];
};

function findRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...findRouteFiles(p));
    else if (e.name === 'route.ts' || e.name === 'route.tsx') out.push(p);
  }
  return out;
}

function exportedMethods(src: string): string[] {
  const found = new Set<string>();
  for (const m of HTTP_METHODS) {
    // export async function GET( / export function GET( / export const GET =
    if (new RegExp(`export\\s+(async\\s+)?function\\s+${m}\\b`).test(src)) found.add(m);
    if (new RegExp(`export\\s+const\\s+${m}\\s*=`).test(src)) found.add(m);
    // export { handler as GET, handler as POST }
    const braced = src.matchAll(/export\s*\{([^}]+)\}/g);
    for (const b of braced) {
      for (const piece of b[1]!.split(',')) {
        const as = piece.match(/\bas\s+(\w+)\s*$/);
        const name = (as ? as[1] : piece.trim())?.trim();
        if (name === m) found.add(m);
      }
    }
  }
  return [...found];
}

/** What the generator reads of each route file (route-callers.ts
 *  analyzeRouteFile): each method whose handler reads the caller the
 *  pipeline answers, to its caller kind, and each gone stub, to its kind;
 *  following the handlers a file imports or re-exports from another route
 *  file (the /api/v1 aliases). */
const readsMemo = new Map<string, RouteFileReads>();
function analysisOf(absFile: string, seen: Set<string> = new Set()): RouteFileReads {
  const memo = readsMemo.get(absFile);
  if (memo) return memo;
  if (seen.has(absFile)) throw new Error(`[gen-route-manifest] import cycle at ${absFile}`);
  seen.add(absFile);
  const rel = relative(webRoot, absFile).split('\\').join('/');
  // A relative route file only: what a handler from elsewhere reads is not
  // known here (it would throw when called: fail closed).
  const reads = analyzeRouteFile(readFileSync(absFile, 'utf8'), rel, (spec) => {
    const target = routeFileAt(absFile, spec);
    return target ? analysisOf(target, seen).callers : null;
  });
  readsMemo.set(absFile, reads);
  return reads;
}

/** The route file `spec` names from `absFile`, if it names one (a
 *  relative route file); else null. */
function routeFileAt(absFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(absFile), spec);
  const target = ['.ts', '.tsx'].map((x) => base + x).find((f) => existsSync(f));
  return target && /\/route\.tsx?$/.test(target) ? target : null;
}

/** Each method to the switch it is served under, per route file
 *  (route-callers.ts handlerSwitches), following the handlers a file takes
 *  from another route file. */
const switchesMemo = new Map<string, HandlerSwitches>();
function switchesOf(absFile: string, seen: Set<string> = new Set()): HandlerSwitches {
  const memo = switchesMemo.get(absFile);
  if (memo) return memo;
  if (seen.has(absFile)) throw new Error(`[gen-route-manifest] import cycle at ${absFile}`);
  seen.add(absFile);
  const rel = relative(webRoot, absFile).split('\\').join('/');
  const switches = handlerSwitches(readFileSync(absFile, 'utf8'), rel, (spec) => {
    const target = routeFileAt(absFile, spec);
    return target ? switchesOf(target, seen) : null;
  });
  switchesMemo.set(absFile, switches);
  return switches;
}

function toEntry(absFile: string): Entry {
  const rel = relative(appDir, dirname(absFile)).split('\\').join('/');
  const rawSegs = rel === '' ? [] : rel.split('/');
  const segments: string[] = [];
  let catchAll: string | null = null;
  let catchAllOptional = false;
  for (const seg of rawSegs) {
    if (seg.startsWith('(') && seg.endsWith(')')) continue; // route group
    let m: RegExpMatchArray | null;
    if ((m = seg.match(/^\[\[\.\.\.(.+)\]\]$/))) {
      catchAll = m[1]!;
      catchAllOptional = true;
      segments.push('*');
    } else if ((m = seg.match(/^\[\.\.\.(.+)\]$/))) {
      catchAll = m[1]!;
      segments.push('*');
    } else if ((m = seg.match(/^\[(.+)\]$/))) {
      segments.push(`:${m[1]}`);
    } else {
      segments.push(seg);
    }
  }
  const src = readFileSync(absFile, 'utf8');
  return {
    file: relative(webRoot, absFile).split('\\').join('/'),
    pattern: '/' + segments.join('/'),
    methods: exportedMethods(src),
    reads: analysisOf(absFile).callers,
    gone: Object.keys(analysisOf(absFile).gone),
    switches: switchesOf(absFile),
    policy: handlerPolicy(src, relative(webRoot, absFile).split('\\').join('/')),
    catchAll,
    catchAllOptional,
    segments,
  };
}

/** Next precedence at each depth: literal beats :param beats catch-all. */
function segRank(seg: string): number {
  if (seg === '*') return 2;
  if (seg.startsWith(':')) return 1;
  return 0;
}

function compareEntries(a: Entry, b: Entry): number {
  const len = Math.max(a.segments.length, b.segments.length);
  for (let i = 0; i < len; i++) {
    const sa = a.segments[i];
    const sb = b.segments[i];
    if (sa === undefined) return -1; // shorter (more specific prefix) first
    if (sb === undefined) return 1;
    const ra = segRank(sa);
    const rb = segRank(sb);
    if (ra !== rb) return ra - rb;
    if (sa !== sb) return sa < sb ? -1 : 1;
  }
  return 0;
}

const entries = findRouteFiles(appDir).map(toEntry).sort(compareEntries);

const missing = entries.filter((e) => e.methods.length === 0);
if (missing.length > 0) {
  console.error(
    '[gen-route-manifest] route files with no detected HTTP method exports:\n' +
      missing.map((e) => `  ${e.file}`).join('\n'),
  );
  process.exit(1);
}

const lines = entries.map(
  (e) =>
    `  { pattern: ${JSON.stringify(e.pattern)}, file: ${JSON.stringify(e.file)}, ` +
    `methods: ${JSON.stringify(e.methods)}, ` +
    `catchAll: ${JSON.stringify(e.catchAll)}, catchAllOptional: ${e.catchAllOptional}, ` +
    (Object.keys(e.reads).length > 0 ? `reads: ${JSON.stringify(e.reads)}, ` : '') +
    (e.gone.length > 0 ? `gone: ${JSON.stringify(e.gone)}, ` : '') +
    (Object.keys(e.switches).length > 0 ? `switches: ${JSON.stringify(e.switches)}, ` : '') +
    (e.policy ? `policy: ${JSON.stringify(e.policy)}, ` : '') +
    // Extensionless specifier: tsc (bundler resolution) rejects explicit .ts
    // imports without allowImportingTsExtensions; tsx resolves both fine.
    `load: () => import(${JSON.stringify('../' + e.file.replace(/\.tsx?$/, ''))}) },`,
);

const out = `/* AUTO-GENERATED by scripts/gen-route-manifest.ts — do not edit. */
import type { RouteModule } from './route-loader';
import type { RoutePolicyDeclaration } from '../lib/auth/route-declaration';

export type ManifestEntry = {
  pattern: string;
  /** The route file, from server/web (the route policy codemod writes it). */
  file: string;
  methods: string[];
  catchAll: string | null;
  catchAllOptional: boolean;
  /** Each method whose handler reads the caller the pipeline answers, to
   *  the caller kind its reader reads. */
  reads?: Record<string, ${CALLER_KINDS.map((k) => `'${k}'`).join(' | ')}>;
  /** Each method exported as a retired route's 410 stub (lib/gone.ts). */
  gone?: string[];
  /** Each method to the switch its route file declares
   *  (lib/auth/route-switches.ts). */
  switches?: Record<string, ${ROUTE_SWITCH_NAMES.map((n) => `'${n}'`).join(' | ')}>;
  /** The policy the route file declares (lib/auth/route-declaration.ts). */
  policy?: RoutePolicyDeclaration;
  load: () => Promise<RouteModule>;
};

export const routeManifest: ManifestEntry[] = [
${lines.join('\n')}
];
`;

mkdirSync(join(webRoot, 'server'), { recursive: true });
writeFileSync(join(webRoot, 'server/route-manifest.gen.ts'), out);
console.log(`[gen-route-manifest] ${entries.length} route files → server/route-manifest.gen.ts`);

import type { Context, Hono } from 'hono';
import { matchedRoutes } from 'hono/route';
import {
  ROUTE_POLICY_SOURCE,
  buildRoutePolicy,
  compileSpelling,
  linkCors,
  servedMethods,
  type RoutePolicySource,
  type PageClass,
  type RouteCaller,
  type RouteRow,
  type RouteSwitch,
} from '../lib/auth/route-policy';
import {
  bodyCeilingFor,
  bodyTooLargeResponse,
  bodyWentOver,
  capRequestBody,
} from '../lib/body-limit';
import { ROUTE_PARAMS_EXPORT, routeParamsRefusal } from '../lib/route-params';
import { ROUTE_POLICY_EXPORT, type RoutePolicyDeclaration } from '../lib/auth/route-declaration';
import { getRequestContext } from './request-context';

/**
 * Registers the generated route manifest (route-manifest.gen.ts) on a Hono
 * app, adapting Next's route-handler convention:
 *
 *   export async function GET(req: Request, ctx: { params: Promise<...> })
 *
 * Handlers receive the raw Fetch Request and a params Promise (Next 15/16
 * shape) and return a plain Response, which Hono forwards untouched — SSE
 * streams, 206/416 Range responses, redirects and multipart parsing all
 * behave exactly as before.
 *
 * Modules are imported lazily on first hit and memoized — boot stays fast and
 * a route's import cost is paid once.
 *
 * Each route carries its ROUTE_POLICY rows (lib/auth/route-policy.ts, arch
 * A4 step 1), built once here; the gate middleware finds them with
 * servedRoute() and runs the handler through enterCall, which opens the
 * request slot. The loader only runs the handler: it is not a second gate.
 *
 * A route file may declare what its path params must be (`routeParams`,
 * lib/route-params.ts): the loader answers the one 404 for a segment the
 * schema refuses, before the handler runs.
 *
 * The pages of server/pages (the /s page, the render surfaces) register
 * here too (registerPages, A4 step 2), each with its row: the plan's
 * "/s links and their brokers, moved into the loader".
 */

type RouteHandler = (
  req: Request,
  ctx: { params: Promise<Record<string, string | string[]>> },
) => Response | Promise<Response>;

export type RouteModule = Record<string, unknown>;

export type RouteEntry = {
  pattern: string;
  methods: string[];
  catchAll: string | null;
  catchAllOptional: boolean;
  /** Each method whose handler reads the caller the pipeline answers, to
   *  the caller kind its reader reads (ownerCaller(), memberCaller(),
   *  loginCaller(), chatLoginCaller(); arch A4 step 3b): their rows'
   *  `caller`. */
  reads?: Readonly<Record<string, RouteCaller>>;
  /** Each method exported as a retired route's 410 stub (`gone(kind)`,
   *  lib/gone.ts; A4 hand batch A): their rows are gone rows. */
  gone?: readonly string[];
  /** Each method to the switch its route file declares (`routeSwitches`,
   *  lib/auth/route-switches.ts; A4 hand batch A): their rows' switch. */
  switches?: Readonly<Record<string, RouteSwitch>>;
  /** The policy the route file declares (`policy`,
   *  lib/auth/route-declaration.ts; plan v3.2 S9), as the generator read it
   *  from the code: the rows are built from it where the source is
   *  'declarations' (ROUTE_POLICY_SOURCE). */
  policy?: RoutePolicyDeclaration;
  load: () => Promise<RouteModule>;
};

/** Plain data equal, key order aside (a declaration is literals only). */
function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((x, i) => sameData(x, b[i]))
    );
  }
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return (
    ka.length === kb.length &&
    ka.every(
      (k) =>
        Object.hasOwn(b, k) &&
        sameData((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    )
  );
}

/**
 * Whether a loaded route module's `policy` is the one its rows were built
 * from (S9): the generator reads the declaration from the code, the module
 * exports its value, and the two must be one. Asked when the module is
 * first loaded, where the rows are read from the declarations; a module
 * whose export is not the manifest's throws (the rows would answer for a
 * policy the file does not hold). The lists' rows read no declaration, so
 * nothing is asked there (`source`).
 */
export function checkLoadedPolicy(
  entry: Pick<RouteEntry, 'pattern' | 'policy'>,
  mod: RouteModule,
  source: RoutePolicySource = ROUTE_POLICY_SOURCE,
): void {
  if (source !== 'declarations') return;
  if (!sameData(mod[ROUTE_POLICY_EXPORT] ?? null, entry.policy ?? null)) {
    throw new Error(
      `${entry.pattern}: the module's ${ROUTE_POLICY_EXPORT} is not the one the manifest read (regenerate it)`,
    );
  }
}

function memoize<T>(fn: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => {
    // Reset on rejection so a transient import failure isn't cached forever.
    p ??= fn().catch((err) => {
      p = null;
      throw err;
    });
    return p;
  };
}

/** Decoded path segments after the static prefix — Next's catch-all value. */
function restSegments(pathname: string, prefixSegCount: number): string[] {
  const segs = pathname.split('/').filter(Boolean);
  return segs.slice(prefixSegCount).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
}

/** A route handler the loader registered: its pattern, its ROUTE_POLICY
 *  rows by request method (none for the 405 answer of another method), and
 *  whether the gate gives its pattern CORS (linkCors; every method, the
 *  preflight too). */
export type ServedRoute = Readonly<{
  pattern: string;
  rows: ReadonlyMap<string, RouteRow>;
  cors: boolean;
}>;

const servedBy = new WeakMap<object, ServedRoute>();

/**
 * The route that answers this request, for the gate middleware: the first
 * handler the loader registered among the ones Hono matched after the
 * current one (Hono runs them in that order, and the first answers), or
 * null when no route of the manifest answers (a 404, the /s and /print
 * pages).
 */
export function servedRoute(c: Context): ServedRoute | null {
  const routes = matchedRoutes(c);
  for (let i = c.req.routeIndex + 1; i < routes.length; i++) {
    const served = servedBy.get(routes[i]!.handler);
    if (served) return served;
  }
  return null;
}

/** Register the manifest's routes, each with its ROUTE_POLICY rows (built
 *  here from the manifest; a route no list classes throws, so it never
 *  ships, and so does a row that is not public and reads no caller). A
 *  map: the rows of the loader's own tests, whose routes are not the app's;
 *  `{ standIn: true }`: the rows of a test's stand-in routes, whose
 *  handlers call the guards themselves (buildRouteRow `standIn`; only a
 *  test passes it, arch-lints.test.ts). */
export function registerRoutes(
  app: Hono,
  manifest: RouteEntry[],
  rows: ReadonlyMap<string, RouteRow> | Readonly<{ standIn: boolean }> = buildRoutePolicy(manifest),
): void {
  const policy = 'standIn' in rows ? buildRoutePolicy(manifest, rows) : rows;
  for (const entry of manifest) {
    const rowsFor = (methods: string[]): ReadonlyMap<string, RouteRow> =>
      new Map(
        methods.flatMap((m) => {
          const row = policy.get(`${m} ${entry.pattern}`);
          return row ? [[m, row] as const] : [];
        }),
      );
    // The gate's spelling test of the pattern (spellsPattern), compiled at
    // registration: a pattern it cannot spell fails at boot, not per request.
    compileSpelling(entry.pattern);
    const load = memoize(async () => {
      const mod = await entry.load();
      checkLoadedPolicy(entry, mod);
      return mod;
    });
    const isCatchAll = entry.catchAll !== null;
    // Segment count of the static prefix before the '*' (for rest extraction).
    const prefixSegCount = entry.pattern.split('/').filter(Boolean).length - 1;

    for (const method of entry.methods) {
      const handle = async (c: Context) => {
        // The owner answer threw at the gate (arch A4 step 3b): taken off
        // the request first, and thrown below in the handler's place,
        // where the handler's guard threw it before, for onError (which
        // keeps the gate's CORS headers). Where no handler runs (the bare
        // prefix's 404, a stale manifest's 405) no guard ran before
        // either: that answer stands, with its CORS headers, and the
        // error goes with the guard that never ran.
        const ctx = getRequestContext();
        const pending = ctx?.callerError;
        if (pending) delete ctx.callerError;
        let params: Record<string, string | string[]> = {};
        if (isCatchAll) {
          // Hono's `/x/*` also matches the bare `/x`. Next semantics:
          // [[...p]] matches it with the param ABSENT; [...p] doesn't match.
          const rest = restSegments(new URL(c.req.raw.url).pathname, prefixSegCount);
          if (rest.length === 0) {
            if (!entry.catchAllOptional) return c.notFound();
          } else {
            params = { [entry.catchAll!]: rest };
          }
        } else if (entry.pattern.includes(':')) {
          params = { ...c.req.param() };
        }
        const mod = await load();
        const handler = mod[method] as RouteHandler | undefined;
        if (typeof handler !== 'function') {
          return Response.json({ error: 'method not allowed' }, { status: 405 });
        }
        if (pending) throw pending.error;
        // The route's params schema (A10 lows, lib/route-params.ts): a
        // segment that is not what the route file declares (an id that is
        // not a uuid) is the one 404, before the handler, its body or the
        // database see it.
        const refused = routeParamsRefusal(mod[ROUTE_PARAMS_EXPORT], entry.pattern, params);
        if (refused) return refused;
        // The one body reader (A10 part 2, fold 1): the handler's request
        // reads its body through the route's ceiling, whichever reader it
        // calls, so a chunked body that declares no length is refused at the
        // ceiling (413) instead of read in full. An upload route (no
        // ceiling) streams under its own cap, as before.
        // The ceiling is the one of the path Hono matched: the decoded one
        // (c.req.path), so `/api/%61uth/...` gets the ceiling of the route
        // that answers it, not of its spelling (fix round 1, L8).
        const ceiling = bodyCeilingFor(c.req.path);
        const req = ceiling === null ? c.req.raw : capRequestBody(c.req.raw, ceiling);
        // The gate opened the request slot (workspaces W6a) through enterCall;
        // the session guard fills it with the login's scope.
        let res: Response;
        try {
          res = await handler(req, { params: Promise.resolve(params) });
        } catch (err) {
          // A handler that wrapped the ceiling's error in its own and threw
          // still answers 413, not the opaque 500 (fix round 1, L9).
          if (ceiling !== null && bodyWentOver(req)) return bodyTooLargeResponse(ceiling);
          throw err;
        }
        // A handler that caught the ceiling's error (a `.catch(() => ({}))`
        // read) still answers 413: the body was never read in full.
        if (ceiling !== null && bodyWentOver(req)) return bodyTooLargeResponse(ceiling);
        return res;
      };

      // HEAD is answered by the GET handler (Hono), with its own row.
      const methods = servedMethods({ pattern: entry.pattern, methods: [method] });
      servedBy.set(handle, {
        pattern: entry.pattern,
        rows: rowsFor(methods),
        cors: linkCors(entry.pattern),
      });
      app.on(method, entry.pattern, handle);
    }

    // Next parity for the error path: a request whose PATH matches a route
    // file but whose METHOD isn't exported got a 405 + Allow from Next (and
    // OPTIONS was auto-answered 204 + Allow). Registered after the real
    // methods, so it only fires for the leftovers. (CORS-eligible OPTIONS
    // never reaches here — the gate answers those preflights first.)
    const allow = [
      ...entry.methods,
      ...(entry.methods.includes('GET') ? ['HEAD'] : []),
      'OPTIONS',
    ].join(', ');
    const leftover = (c: Context) => {
      if (c.req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: { Allow: allow } });
      }
      return Response.json(
        { error: 'method not allowed' },
        { status: 405, headers: { Allow: allow } },
      );
    };
    servedBy.set(leftover, {
      pattern: entry.pattern,
      rows: new Map(),
      cors: linkCors(entry.pattern),
    });
    app.all(entry.pattern, leftover);
  }
}

/** A page of server/pages: a Hono handler, its pattern and methods. */
export type PageRoute = Readonly<{
  pattern: string;
  methods: readonly string[];
  handle: (c: Context) => Response | Promise<Response>;
}>;

/**
 * Register a list of pages of server/pages (the /s page, the render
 * surfaces), each with its ROUTE_POLICY rows, of the class the list is
 * (`cls`: SHARE_PAGES 'link', PRINT_PAGES 'render'; a page the lists class
 * otherwise throws). The gate finds the row (servedRoute) and runs the page
 * through enterCall in the page's own actor slot (the row's startsAs), as
 * the pages did for themselves before A4 step 2. No 405 answer: another
 * method falls through to the 404, as before.
 */
export function registerPages(
  app: Hono,
  pages: readonly PageRoute[],
  cls: PageClass,
  policy: ReadonlyMap<string, RouteRow> = buildRoutePolicy(pages, { page: cls }),
): void {
  for (const page of pages) {
    compileSpelling(page.pattern);
    for (const method of page.methods) {
      // One function per method, so each carries its own rows.
      const handle = (c: Context) => page.handle(c);
      const rows = new Map(
        servedMethods({ pattern: page.pattern, methods: [method] }).flatMap((m) => {
          const row = policy.get(`${m} ${page.pattern}`);
          return row ? [[m, row] as const] : [];
        }),
      );
      servedBy.set(handle, { pattern: page.pattern, rows, cors: linkCors(page.pattern) });
      app.on(method, page.pattern, handle);
    }
  }
}

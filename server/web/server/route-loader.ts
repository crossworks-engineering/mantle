import type { Context, Hono } from 'hono';
import { matchedRoutes } from 'hono/route';
import { buildRoutePolicy, servedMethods, type RouteRow } from '../lib/auth/route-policy';

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
  load: () => Promise<RouteModule>;
};

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

/** A route handler the loader registered: its pattern and its ROUTE_POLICY
 *  rows by request method (none for the 405 answer of another method). */
export type ServedRoute = Readonly<{ pattern: string; rows: ReadonlyMap<string, RouteRow> }>;

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
 *  ships). `policy` is for the loader's own tests, whose routes are not the
 *  app's. */
export function registerRoutes(
  app: Hono,
  manifest: RouteEntry[],
  policy: ReadonlyMap<string, RouteRow> = buildRoutePolicy(manifest),
): void {
  for (const entry of manifest) {
    const rowsFor = (methods: string[]): ReadonlyMap<string, RouteRow> =>
      new Map(
        methods.flatMap((m) => {
          const row = policy.get(`${m} ${entry.pattern}`);
          return row ? [[m, row] as const] : [];
        }),
      );
    const load = memoize(entry.load);
    const isCatchAll = entry.catchAll !== null;
    // Segment count of the static prefix before the '*' (for rest extraction).
    const prefixSegCount = entry.pattern.split('/').filter(Boolean).length - 1;

    for (const method of entry.methods) {
      const handle = async (c: Context) => {
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
        // The gate opened the request slot (workspaces W6a) through enterCall;
        // the session guard fills it with the login's scope.
        return handler(c.req.raw, { params: Promise.resolve(params) });
      };

      // HEAD is answered by the GET handler (Hono), with its own row.
      const methods = servedMethods({ pattern: entry.pattern, methods: [method] });
      servedBy.set(handle, { pattern: entry.pattern, rows: rowsFor(methods) });
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
    servedBy.set(leftover, { pattern: entry.pattern, rows: new Map() });
    app.all(entry.pattern, leftover);
  }
}

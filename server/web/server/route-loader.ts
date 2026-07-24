import type { Context, Hono } from 'hono';

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

export function registerRoutes(app: Hono, manifest: RouteEntry[]): void {
  for (const entry of manifest) {
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
        return handler(c.req.raw, { params: Promise.resolve(params) });
      };

      app.on(method, entry.pattern, handle);
    }
  }
}

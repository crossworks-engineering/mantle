import { AsyncLocalStorage } from 'node:async_hooks';
import type { AccessKeyGrant } from '../lib/access-keys';

/**
 * Per-request ambient context for the Hono server.
 *
 * Under Next, `lib/auth.ts`/`lib/audit.ts` read the request through the ambient
 * `cookies()`/`headers()` from next/headers — no `Request` is threaded through
 * their ~280 call sites. This ALS store reproduces that ambience: the gate
 * middleware (server/middleware/gate.ts) runs every handler inside
 * `runWithRequestContext`, and `server/http-compat/headers.ts` exposes the same
 * read API on top of it.
 *
 * `path`/`method` replace the old middleware header-injection trick
 * (x-mantle-path / x-mantle-method): they are ALWAYS derived server-side from
 * the URL, never from a client-suppliable header, so audit attribution can't be
 * spoofed on any path.
 */
export type RequestContext = {
  req: Request;
  /** Decoded pathname (new URL(req.url).pathname). */
  path: string;
  method: string;
  /** The API key the gate verified for this request (an /api/v1 call with
   *  an `mtlk_` bearer), so the route's login lookup does not check it a
   *  second time. Absent on every other request. */
  accessKey?: AccessKeyGrant;
};

const store = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return store.run(ctx, fn);
}

/** The current request's context, or null outside a request (boot, workers, tests). */
export function getRequestContext(): RequestContext | null {
  return store.getStore() ?? null;
}

/**
 * One Content-Type for JSON. `Response.json()` on Bun says
 * `application/json;charset=utf-8`, the clients know `application/json`, and
 * more than a thousand routes call it. This runs outside everything else
 * (server/app.ts), so it sees the answer that goes out, a refusal and the
 * app's error answer included.
 */
import type { MiddlewareHandler } from 'hono';

const BUN_JSON_TYPE = 'application/json;charset=utf-8';

export function plainJsonType(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (c.res.headers.get('content-type') !== BUN_JSON_TYPE) return;
    try {
      c.res.headers.set('Content-Type', 'application/json');
    } catch {
      // Immutable headers (a fetched Response): a copy takes it.
      const res = new Response(c.res.body, c.res);
      res.headers.set('Content-Type', 'application/json');
      c.res = res;
    }
  };
}

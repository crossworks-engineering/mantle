/**
 * One Content-Type for JSON on every runtime. `Response.json()` says
 * `application/json` on Node and `application/json;charset=utf-8` on Bun, and
 * more than a thousand routes call it. This runs outside everything else
 * (server/app.ts), so it sees the answer that goes out, a refusal and the
 * app's error answer included. On Node it touches only an answer that already
 * says this exact type, which no route writes.
 */
import type { MiddlewareHandler } from 'hono';

const BUN_JSON_TYPE = 'application/json;charset=utf-8';

export function jsonTypeOnEveryRuntime(): MiddlewareHandler {
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

/**
 * runRoute: one request
 * through the FULL HTTP pipeline, the way a client's request runs: the
 * gate middleware, the request's ROUTE_POLICY row, enterCall with the
 * caller the gate resolved (the login found once), the request slot, the
 * session guard reading the bound caller, and the handler. A route test
 * that imports route.ts and calls its handler skips all of that; one that
 * calls runRoute does not.
 *
 *     const res = await runRoute(OWNER, 'PUT', '/api/profile', { timezone: 'UTC' });
 *
 * The login is a session cookie for a login id (a row the test stands in,
 * see run-route-stand-ins.ts, or a real row in a database test), an API
 * key (`{ key }`), or null (no credential). Test support only: nothing in
 * the server imports it.
 */
import type { Hono } from 'hono';
import { env } from '@mantle/config';
import { SESSION_COOKIE_NAME } from '../lib/auth-constants';

/** Who calls: a login id (its session cookie, signed at `epoch`), an API
 *  key's token, or nobody. */
export type RouteLogin = string | { id: string; epoch?: number } | { key: string } | null;

/** The secret runRoute signs with when the test set none (32 or more). */
const TEST_SECRET = 'run-route-test-secret-at-least-32-characters';
const SECRET_NAME = 'SESSION_SECRET';

let app: Promise<Hono> | null = null;

/** The app, built once per test file (the real createApp: every route of
 *  the manifest and the pages). */
function routeApp(): Promise<Hono> {
  app ??= import('./app').then((m) => m.createApp());
  return app;
}

/** The credential headers of `login`. */
async function credential(login: RouteLogin): Promise<Record<string, string>> {
  if (login === null) return {};
  if (typeof login === 'object' && 'key' in login) {
    return { authorization: `Bearer ${login.key}` };
  }
  const { buildSessionCookie } = await import('../lib/auth/tokens');
  const id = typeof login === 'string' ? login : login.id;
  const epoch = typeof login === 'string' ? 0 : (login.epoch ?? 0);
  return { cookie: `${SESSION_COOKIE_NAME}=${buildSessionCookie(id, { epoch }).value}` };
}

/**
 * Send `method path` (with `body` as JSON, when given) through the full
 * pipeline as `login`, and answer the response. `path` may carry a query.
 */
export async function runRoute(
  login: RouteLogin,
  method: string,
  path: string,
  body?: unknown,
  opts: {
    headers?: Record<string, string>;
    signal?: AbortSignal;
    /** A body sent as is (a form), in place of `body` as JSON; its
     *  content type goes in `headers`. */
    rawBody?: string;
  } = {},
): Promise<Response> {
  const secret = env(SECRET_NAME);
  // A test that set no signing secret gets one (a test process only).
  if (!secret || secret.length < 32) Object.assign(process.env, { [SECRET_NAME]: TEST_SECRET });
  const headers: Record<string, string> = {
    ...(await credential(login)),
    ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    ...opts.headers,
  };
  const url = path.startsWith('http') ? path : `http://brain.example.invalid${path}`;
  return (await routeApp()).request(url, {
    method,
    headers,
    body: opts.rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}

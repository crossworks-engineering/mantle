/**
 * The public HTTP API, version 1 (plan page 1e62e204, section 2.6).
 *
 * Every /api/v1 route is listed here with the area it belongs to and
 * whether it reads or writes. The table is the contract an API key is held
 * to: the gate looks a request up here (server/middleware/access-key-gate.ts)
 * and refuses a key the route's area or a write it may not make. A path
 * under /api/v1 that is not in this table is a 404 for a key, so a route
 * file added without a row can never be reached with one.
 * api-v1.test.ts pins the table to the route files.
 *
 * Most routes are thin aliases of the routes Jackdaw uses (the same handler,
 * re-exported from app/api/v1/**). The shapes in docs/guide/07-api are the
 * promise: a breaking change needs /api/v2, and v1 stays for at least six
 * months after v2 ships.
 *
 * Cookies and device tokens work here too. The v1 routes past whoami are
 * admin routes: a member or client login (or a key that acts as one) gets
 * 403 `member-login` / `client-login` from them, as on the routes they
 * alias. Those logins use /api/mcp.
 */
import type { AccessKeyArea, AccessKeyGrant } from './access-keys';

export type ApiV1Route = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** The pattern as the route manifest writes it (`:id` for a segment). */
  pattern: string;
  /** null = about the login only (whoami), or open only to a key with
   *  every area. */
  area: AccessKeyArea | null;
  access: 'read' | 'write';
};

const r = (
  method: ApiV1Route['method'],
  pattern: string,
  area: AccessKeyArea | null,
  access: ApiV1Route['access'],
): ApiV1Route => ({ method, pattern, area, access });

export const API_V1_ROUTES: readonly ApiV1Route[] = [
  r('GET', '/api/v1/whoami', null, 'read'),
  // Search and any item by id.
  r('GET', '/api/v1/search', 'search', 'read'),
  r('GET', '/api/v1/nodes/:id', null, 'read'),
  // Pages.
  r('GET', '/api/v1/pages', 'pages', 'read'),
  r('POST', '/api/v1/pages', 'pages', 'write'),
  r('GET', '/api/v1/pages/:id', 'pages', 'read'),
  r('PATCH', '/api/v1/pages/:id', 'pages', 'write'),
  // Notes.
  r('GET', '/api/v1/notes', 'notes', 'read'),
  r('POST', '/api/v1/notes', 'notes', 'write'),
  r('GET', '/api/v1/notes/:id', 'notes', 'read'),
  // Tasks.
  r('GET', '/api/v1/tasks', 'tasks', 'read'),
  r('POST', '/api/v1/tasks', 'tasks', 'write'),
  r('GET', '/api/v1/tasks/:id', 'tasks', 'read'),
  r('PATCH', '/api/v1/tasks/:id', 'tasks', 'write'),
  r('POST', '/api/v1/tasks/:id/comments', 'tasks', 'write'),
  // Tables: rows are written to the draft; commit publishes it.
  r('GET', '/api/v1/tables', 'tables', 'read'),
  r('GET', '/api/v1/tables/:id', 'tables', 'read'),
  r('GET', '/api/v1/tables/:id/rows', 'tables', 'read'),
  r('POST', '/api/v1/tables/:id/rows', 'tables', 'write'),
  r('PATCH', '/api/v1/tables/:id/rows/:rowId', 'tables', 'write'),
  r('POST', '/api/v1/tables/:id/commit', 'tables', 'write'),
  // Files.
  r('GET', '/api/v1/files', 'files', 'read'),
  r('POST', '/api/v1/files', 'files', 'write'),
  r('GET', '/api/v1/files/:id', 'files', 'read'),
  r('GET', '/api/v1/files/:id/download', 'files', 'read'),
  // Calendar events.
  r('GET', '/api/v1/events', 'calendar', 'read'),
  r('POST', '/api/v1/events', 'calendar', 'write'),
  // Contacts (read only).
  r('GET', '/api/v1/contacts', 'contacts', 'read'),
  r('GET', '/api/v1/contacts/:id', 'contacts', 'read'),
  // Journal.
  r('GET', '/api/v1/journal', 'journal', 'read'),
  r('POST', '/api/v1/journal', 'journal', 'write'),
];

const compiled = API_V1_ROUTES.map((route) => ({
  route,
  re: new RegExp(`^${route.pattern.replace(/:[A-Za-z]+/g, '[^/]+')}/?$`),
}));

/** The v1 route a request names, or null. HEAD is looked up as GET. */
export function matchApiV1Route(method: string, path: string): ApiV1Route | null {
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  for (const { route, re } of compiled) if (route.method === m && re.test(path)) return route;
  return null;
}

export type KeyScopeRefusal = 'not-in-api' | 'key-area' | 'key-read-only';

/** Whether an API key may call this v1 route: the route is in the table,
 *  its area is one of the key's (or the key has all), and a write needs a
 *  read_write key. */
export function keyMayCall(
  grant: Pick<AccessKeyGrant, 'access' | 'areas'>,
  route: ApiV1Route | null,
): { ok: true } | { ok: false; reason: KeyScopeRefusal } {
  if (!route) return { ok: false, reason: 'not-in-api' };
  if (route.access === 'write' && grant.access !== 'read_write') {
    return { ok: false, reason: 'key-read-only' };
  }
  // whoami is about the key itself: every key may ask it.
  if (route.pattern === '/api/v1/whoami') return { ok: true };
  if (grant.areas === null) return { ok: true };
  if (route.area === null || !grant.areas.includes(route.area)) {
    return { ok: false, reason: 'key-area' };
  }
  return { ok: true };
}

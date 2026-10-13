/**
 * The public HTTP API, version 1 (plan page 1e62e204, section 2.6).
 *
 * Every /api/v1 route is listed here with the area it belongs to and
 * whether it reads or writes. The table is the contract an API key is held
 * to: the gate looks a request up here (server/middleware/access-key-gate.ts)
 * and refuses a key outside its areas or a write its access does not
 * allow. A key acts as its login (workspaces plan 7.5): the login's rights
 * and workspaces decide, and the key's access and areas only narrow them,
 * never widen. A path under /api/v1 that is not in this table is a 404 for
 * a key, so a route file added without a row can never be reached with one.
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
import { emailAttachmentIds } from '@mantle/files';
import { keyAreasReachEmail } from '@mantle/mcp-core/key-scope';
import type { AccessKeyArea, AccessKeyGrant } from './access-keys';
import { getRequestContext } from '../server/request-context';

/**
 * Whether this request may confirm a change of who can see an item (the
 * tree's "Confirm first", a 409 `visibility` answered with `confirm: true`).
 * An API key may not (M2 audit F1): the confirm is for a person who saw the
 * list, and MCP drops it for a key too (register/context.ts). A key's write
 * that would widen who sees an item stays a 409.
 */
export function callerMayConfirm(): boolean {
  return !isApiKeyRequest();
}

/**
 * Whether this request may reach email. A key reaches it only with the
 * Search area (or every area); the attachments of synced mail are file
 * nodes, so the Files routes leave them out for any other key (access
 * matrix M4). Sessions and device tokens are not limited by areas.
 */
export function callerMayReadEmail(): boolean {
  const key = getRequestContext()?.accessKey;
  return !key || keyAreasReachEmail(key.areas);
}

/**
 * Of `ids`, the ones this request may not reach because they are email
 * attachments or items made from one (an extracted image, an auto table:
 * access matrix M4, T4). Empty for a session, a device token and a key that
 * reaches email. The routes answer such an item "not found".
 */
export async function hiddenFromKey(ownerId: string, ids: readonly string[]): Promise<Set<string>> {
  if (callerMayReadEmail() || ids.length === 0) return new Set();
  return emailAttachmentIds(ownerId, ids);
}

/** Whether the gate let this request in with an API key. */
export function isApiKeyRequest(): boolean {
  return !!getRequestContext()?.accessKey;
}

export type ApiV1Route = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** The pattern as the route manifest writes it (`:id` for a segment). */
  pattern: string;
  /** null = about the key itself (`self`), or open only to a key with
   *  every area. */
  area: AccessKeyArea | null;
  access: 'read' | 'write';
  /** About the key itself (whoami): every key may call it, whatever its
   *  areas. The route's ROUTE_POLICY row carries it (keySelf), so the
   *  gate's key narrower would answer what keyMayCall answers (it does not
   *  run on HTTP: the HTTP caller sets no key areas). */
  self?: true;
  /** The v1 file has its own handler (it narrows a key past the route it
   *  wraps): not an alias of the route without /v1 (ROUTE_POLICY aliasOf,
   *  D3). Absent: the file re-exports that route's handler, where there is
   *  one (route-policy.test.ts reads the files). */
  own?: true;
};

const r = (
  method: ApiV1Route['method'],
  pattern: string,
  area: AccessKeyArea | null,
  access: ApiV1Route['access'],
  own?: 'own' | 'self',
): ApiV1Route => ({
  method,
  pattern,
  area,
  access,
  ...(own === 'own' ? { own: true as const } : {}),
  ...(own === 'self' ? { self: true as const } : {}),
});

export const API_V1_ROUTES: readonly ApiV1Route[] = [
  r('GET', '/api/v1/whoami', null, 'read', 'self'),
  // Search and any item by id.
  r('GET', '/api/v1/search', 'search', 'read'),
  r('GET', '/api/v1/nodes/:id', null, 'read'),
  // Pages.
  r('GET', '/api/v1/pages', 'pages', 'read'),
  r('POST', '/api/v1/pages', 'pages', 'write'),
  r('GET', '/api/v1/pages/:id', 'pages', 'read'),
  r('PATCH', '/api/v1/pages/:id', 'pages', 'write', 'own'),
  // Notes.
  r('GET', '/api/v1/notes', 'notes', 'read'),
  r('POST', '/api/v1/notes', 'notes', 'write'),
  r('GET', '/api/v1/notes/:id', 'notes', 'read'),
  // Tasks.
  r('GET', '/api/v1/tasks', 'tasks', 'read'),
  r('POST', '/api/v1/tasks', 'tasks', 'write'),
  r('GET', '/api/v1/tasks/:id', 'tasks', 'read'),
  r('PATCH', '/api/v1/tasks/:id', 'tasks', 'write'),
  // Tables: rows are written to the draft; commit publishes it.
  r('GET', '/api/v1/tables', 'tables', 'read'),
  r('GET', '/api/v1/tables/:id', 'tables', 'read'),
  r('GET', '/api/v1/tables/:id/rows', 'tables', 'read'),
  r('POST', '/api/v1/tables/:id/rows', 'tables', 'write', 'own'),
  r('PATCH', '/api/v1/tables/:id/rows/:rowId', 'tables', 'write', 'own'),
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

/** The v1 route a RAW (undecoded) request path names, or null. HEAD is
 *  looked up as GET. The raw-path check for an API key: the gate and the
 *  guard judge a key on the request's ROUTE_POLICY row, and only where
 *  this names the same route (route-policy.ts requestKeyRoute), so an
 *  encoded spelling Hono decodes onto a row is still not in the API. */
export function matchApiV1Route(method: string, path: string): ApiV1Route | null {
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  for (const { route, re } of compiled) if (route.method === m && re.test(path)) return route;
  return null;
}

export type KeyScopeRefusal = 'not-in-api' | 'key-area' | 'key-read-only';

/** What keyMayCall reads of a v1 route: a table entry, or the same as a
 *  ROUTE_POLICY row carries it (route-policy.ts rowKeyRoute). */
export type KeyRoute = Pick<ApiV1Route, 'access' | 'area' | 'self'>;

/** Whether an API key may call this v1 route: the route is in the table,
 *  its area is one of the key's (or the key has all), and a write needs a
 *  read_write key. This only narrows: the login's own rights still decide
 *  past it (plan 7.5). */
export function keyMayCall(
  grant: Pick<AccessKeyGrant, 'access' | 'areas'>,
  route: KeyRoute | null,
): { ok: true } | { ok: false; reason: KeyScopeRefusal } {
  if (!route) return { ok: false, reason: 'not-in-api' };
  if (route.access === 'write' && grant.access !== 'read_write') {
    return { ok: false, reason: 'key-read-only' };
  }
  // A route about the key itself (whoami): every key may ask it.
  if (route.self) return { ok: true };
  if (grant.areas === null) return { ok: true };
  if (route.area === null || !grant.areas.includes(route.area)) {
    return { ok: false, reason: 'key-area' };
  }
  return { ok: true };
}

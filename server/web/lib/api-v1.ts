/**
 * The public HTTP API, version 1 (plan page 1e62e204, section 2.6).
 *
 * Every /api/v1 route file declares, per method, the area an API key needs
 * (`keyArea` in its `policy`, route-declaration.ts; plan v3.2 S9 part 3:
 * the table that listed them here is gone). That is the contract a key is
 * held to: the gate reads the request's row (route-policy.ts keyOnRow) and
 * refuses a key outside its areas or a write its access does not allow. A
 * key acts as its login (workspaces plan 7.5): the login's rights and
 * workspaces decide, and the key's access and areas only narrow them,
 * never widen. A row under /api/v1 that declares no key area is a 404 for
 * a key, so a route file added without one can never be reached with one.
 *
 * Most routes are thin aliases of the routes Jackdaw uses (the same handler,
 * re-exported from app/api/v1/**). The shapes in docs/guide/07-api are the
 * promise: a breaking change needs /api/v2, and v1 stays for at least six
 * months after v2 ships.
 *
 * Cookies and device tokens work here too. A v1 route answers a login as
 * its base route does: a
 * login outside Admin, or a key that acts as one, reads and writes through
 * a v1 route exactly where the base route (the route the v1 file
 * re-exports, or the `base` a v1 file with a handler of its own declares)
 * admits it, in its own scope, and gets 403 `member-login` where the base
 * route refuses it. A v1 route with a handler of its own and no base (the
 * table row writes, which run a builtin on the owner's surface) stays for
 * Admin users only.
 */
import { emailAttachmentIds } from '@mantle/files';
import { keyAreasReachEmail } from '@mantle/mcp-core/key-scope';
import type { AccessKeyArea, AccessKeyGrant } from './access-keys';
import { getRequestContext } from '../server/request-context';

/**
 * Whether this request may confirm a change of who can see an item (the
 * tree's "Confirm first", a 409 `visibility` answered with `confirm: true`).
 * An API key may not: the confirm is for a person who saw the
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

export type KeyScopeRefusal = 'not-in-api' | 'key-area' | 'key-read-only';

/** What keyMayCall reads of a v1 route, as its ROUTE_POLICY row carries
 *  it (route-policy.ts rowKeyRoute): the row's effect, and the key area
 *  its route file declares (`keyArea`; S9 part 3, was the key table
 *  API_V1_ROUTES here). */
export type KeyRoute = Readonly<{
  access: 'read' | 'write';
  /** null = about the key itself (`self`), or open only to a key with
   *  every area. */
  area: AccessKeyArea | null;
  /** About the key itself (whoami): every key may call it, whatever its
   *  areas. */
  self?: true;
}>;

/** Whether an API key may call this v1 route: the route is in the API,
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

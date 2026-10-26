/**
 * The classes of a route's scope and the audit rule by effect (workspaces
 * W6a, plan 2.4 and 11). What the session guard does with each owner route
 * is its row's scope (route-policy.ts RouteRow.scope), from its route
 * file's declaration (`class`, `area`; plan v3.2 S9):
 *
 *  - `content`: brain items. A read enters the login's scope for the rest
 *    of the request: the union of its workspaces, on the workspace role
 *    (mantle_view_user). A write, an Admin user's too, runs in the login's
 *    scope: its writes on the write role (mantle_write_user) while the
 *    actor check is not off, where the database checks each one.
 *  - an area (`settings`, `users`, `assistants`, `connectors`, `keys`):
 *    management (plan 2.4). The login must hold the area (the gate's Admin
 *    step); the route then runs on the system pool, as management always
 *    did.
 *  - `self`: the login's own things (its profile, push devices, its chat
 *    with the Admin assistant, pairing a phone, the version and help).
 *
 * The prefix table and the login lists that classed the routes before
 * (ROUTE_PREFIXES, the member open reads and writes, the creates, the
 * read posts and write gets, the writes that make no item) are gone (S9
 * part 3): each route file declares it, and route-policy.rows.json holds
 * every row.
 */
import type { WorkspaceArea } from '@mantle/client-types/dto/workspaces';
import { auditsByMethod } from './route-declaration';

export type RouteClass =
  { kind: 'content' } | { kind: 'self' } | { kind: 'area'; area: WorkspaceArea };

/**
 * Whether a request writes the generic `api.write` audit row
 * (session.ts auditMutation) as a write: a mutating method, or a row whose
 * effect is a write (`effect`, the request's ROUTE_POLICY row inside a
 * routed request, else null). The row's effect adds the GETs that write (a
 * connector's OAuth callback stores tokens on a GET or HEAD); a POST that
 * reads (an effect exception) keeps the audit row its method always wrote.
 */
export function auditsAsWrite(method: string, effect: 'read' | 'write' | null): boolean {
  // By method: route-declaration.ts UNAUDITED_METHODS (auditsByMethod), the
  // set a declaration's `audit` is checked against too.
  return auditsByMethod(method) || effect === 'write';
}

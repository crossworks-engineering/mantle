/**
 * GET /scim/v2/Users (the list, or the one login a `userName eq`,
 * `externalId eq` or `id eq` filter names) and POST (a new member login,
 * no password, no workspace). The identity provider's own routes, under
 * its bearer token; off (no token set), 404 (docs/scim.md). Not a Control
 * Center: the same 404, with no SCIM code loaded.
 */
import { routePolicy } from '@/lib/auth/route-declaration';
import { ccOff } from '@/lib/control/env';

export const policy = routePolicy({
  GET: { class: 'public', limits: { rateLimit: ['scim'] } },
  POST: {
    class: 'public',
    item: { none: "a public route: it judges its own credential (the box's SCIM token)" },
    limits: { rateLimit: ['scim'] },
    audit: 'own',
  },
});

/** SCIM's code, loaded only on a Control Center (after ccOff). */
const scim = () => import('@/lib/scim/service');

export async function GET(req: Request) {
  const off = ccOff();
  if (off) return off;
  const s = await scim();
  return (await s.scimGate(req)) ?? s.listUsers(req);
}

export async function POST(req: Request) {
  const off = ccOff();
  if (off) return off;
  const s = await scim();
  return (await s.scimGate(req)) ?? s.createUser(req);
}

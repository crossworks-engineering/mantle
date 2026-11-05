/**
 * GET /scim/v2/Users (the list, or the one login a `userName eq`,
 * `externalId eq` or `id eq` filter names) and POST (a new member login,
 * no password, no workspace). The identity provider's own routes, under
 * its bearer token; off (no token set), 404 (docs/scim.md).
 */
import { routePolicy } from '@/lib/auth/route-declaration';
import { createUser, listUsers, scimGate } from '@/lib/scim/service';

export const policy = routePolicy({
  GET: { class: 'public', limits: { rateLimit: ['scim'] } },
  POST: {
    class: 'public',
    item: { none: "a public route: it judges its own credential (the box's SCIM token)" },
    limits: { rateLimit: ['scim'] },
    audit: 'own',
  },
});

export async function GET(req: Request) {
  return scimGate(req) ?? listUsers(req);
}

export async function POST(req: Request) {
  return scimGate(req) ?? createUser(req);
}

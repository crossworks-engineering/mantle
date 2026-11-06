/**
 * /scim/v2/Users/:id: GET one login, PATCH it (Entra's shapes), PUT it
 * (Okta's), DELETE it (a disable: nothing is removed). A disable is the
 * users area's own: every session, key and MCP grant of the login ends.
 * Under the box's SCIM token; off, 404 (docs/scim.md).
 */
import { routePolicy } from '@/lib/auth/route-declaration';
import { deleteUser, getUser, patchUser, replaceUser, scimGate } from '@/lib/scim/service';

export const policy = routePolicy({
  GET: { class: 'public', limits: { rateLimit: ['scim'] } },
  PATCH: {
    class: 'public',
    item: { none: "a public route: it judges its own credential (the box's SCIM token)" },
    limits: { rateLimit: ['scim'] },
    audit: 'own',
  },
  PUT: {
    class: 'public',
    item: { none: "a public route: it judges its own credential (the box's SCIM token)" },
    limits: { rateLimit: ['scim'] },
    audit: 'own',
  },
  DELETE: {
    class: 'public',
    item: { none: "a public route: it judges its own credential (the box's SCIM token)" },
    limits: { rateLimit: ['scim'] },
    audit: 'own',
  },
});

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  return (await scimGate(req)) ?? getUser((await ctx.params).id);
}

export async function PATCH(req: Request, ctx: Ctx) {
  return (await scimGate(req)) ?? patchUser(req, (await ctx.params).id);
}

export async function PUT(req: Request, ctx: Ctx) {
  return (await scimGate(req)) ?? replaceUser(req, (await ctx.params).id);
}

export async function DELETE(req: Request, ctx: Ctx) {
  return (await scimGate(req)) ?? deleteUser(req, (await ctx.params).id);
}

/**
 * /scim/v2/Users/:id: GET one login, PATCH it (Entra's shapes), PUT it
 * (Okta's), DELETE it (a disable: nothing is removed). A disable is the
 * users area's own: every session, key and MCP grant of the login ends.
 * Under the box's SCIM token; off, 404 (docs/scim.md). Not a Control
 * Center: the same 404, with no SCIM code loaded.
 */
import { routePolicy } from '@/lib/auth/route-declaration';
import { ccOff } from '@/lib/control/env';

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

/** SCIM's code, loaded only on a Control Center (after ccOff). */
const scim = () => import('@/lib/scim/service');

export async function GET(req: Request, ctx: Ctx) {
  const off = ccOff();
  if (off) return off;
  const s = await scim();
  return (await s.scimGate(req)) ?? s.getUser((await ctx.params).id);
}

export async function PATCH(req: Request, ctx: Ctx) {
  const off = ccOff();
  if (off) return off;
  const s = await scim();
  return (await s.scimGate(req)) ?? s.patchUser(req, (await ctx.params).id);
}

export async function PUT(req: Request, ctx: Ctx) {
  const off = ccOff();
  if (off) return off;
  const s = await scim();
  return (await s.scimGate(req)) ?? s.replaceUser(req, (await ctx.params).id);
}

export async function DELETE(req: Request, ctx: Ctx) {
  const off = ccOff();
  if (off) return off;
  const s = await scim();
  return (await s.scimGate(req)) ?? s.deleteUser(req, (await ctx.params).id);
}

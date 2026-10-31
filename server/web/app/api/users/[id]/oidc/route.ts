import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { oidcAdminSetOutside, oidcAdminUnlink } from '@/lib/oidc/flow';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  PATCH: {
    class: 'area',
    area: 'users',
    item: { none: 'manages the users area: the Admin step checks it' },
    audit: 'own',
  },
  DELETE: {
    class: 'area',
    area: 'users',
    item: { none: 'manages the users area: the Admin step checks it' },
    audit: 'own',
  },
});

const IdParams = z.object({ id: z.string().uuid() });

/**
 * PATCH /api/users/:id/oidc { outside }: mark a login an outside person
 * (keeps its password when company sign-in is required) or clear the mark.
 * DELETE: remove the login's company sign-in link. Off: 404
 * (docs/oidc-sign-in.md).
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const id = IdParams.safeParse(await ctx.params);
  if (!id.success) return NextResponse.json({ error: 'Invalid user id.' }, { status: 400 });
  return oidcAdminSetOutside(req, id.data.id, { id: user.actor.id, email: user.email });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const id = IdParams.safeParse(await ctx.params);
  if (!id.success) return NextResponse.json({ error: 'Invalid user id.' }, { status: 400 });
  return oidcAdminUnlink(req, id.data.id, { id: user.actor.id, email: user.email });
}

/**
 * DELETE /api/team-admin/invites/:id: revoke an invite that has not been
 * redeemed (member logins, Phase 6). 404 when there is no such open invite.
 * Admin only.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { revokeMemberInvite } from '@mantle/content';
import { ownerCaller } from '@/lib/auth';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  DELETE: {
    class: 'area',
    area: 'users',
    item: { none: 'manages the users area: the Admin step checks it' },
  },
});

const Params = z.object({ id: z.string().uuid() });

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const params = Params.safeParse(await ctx.params);
  if (!params.success || !(await revokeMemberInvite(user.id, params.data.id))) {
    return NextResponse.json({ error: 'Invite not found.' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

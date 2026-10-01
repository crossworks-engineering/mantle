/**
 * DELETE /api/team-admin/invites/:id: revoke an invite that has not been
 * redeemed (member logins, Phase 6). 404 when there is no such open invite.
 * Admin only.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { revokeMemberInvite } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';

const Params = z.object({ id: z.string().uuid() });

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const params = Params.safeParse(await ctx.params);
  if (!params.success || !(await revokeMemberInvite(user.id, params.data.id))) {
    return NextResponse.json({ error: 'Invite not found.' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

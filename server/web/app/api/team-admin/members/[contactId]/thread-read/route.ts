/**
 * POST /api/team-admin/members/[contactId]/thread-read — advance the owner's
 * read cursor on a member's pre-Forum chat archive. Used to happen as a
 * RENDER side effect of the SSR members pane (merely rendering marked the
 * thread read even if the owner never looked); now the client fires it after
 * the archive is actually on screen. Idempotent.
 */
import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { markTeamThreadRead } from '@mantle/content';


export async function POST(_req: Request, ctx: { params: Promise<{ contactId: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { contactId } = await ctx.params;
  await markTeamThreadRead(user.id, contactId);
  return NextResponse.json({ ok: true });
}

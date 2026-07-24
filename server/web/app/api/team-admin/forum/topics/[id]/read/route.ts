/**
 * POST /api/team-admin/forum/topics/[id]/read — advance the OWNER's read
 * cursor on a forum topic (clears the unread dot in the admin topic list).
 * Used to happen as a render side effect of the SSR topics pane; now the
 * client fires it once the transcript is on screen. Idempotent.
 */
import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { markForumTopicRead } from '@mantle/content';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  await markForumTopicRead(user.id, { kind: 'owner' }, id);
  return NextResponse.json({ ok: true });
}

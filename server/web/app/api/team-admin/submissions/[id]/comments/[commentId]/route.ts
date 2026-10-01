/** DELETE /api/team-admin/submissions/:id/comments/:commentId : take back
 *  one of the caller's own review comments. */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { deleteReviewComment } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';
import { reviewNotFound } from '@/lib/member-review';

const Params = z.object({ id: z.string().uuid(), commentId: z.string().uuid() });

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string; commentId: string }> },
) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const params = Params.safeParse(await ctx.params);
  if (!params.success) return reviewNotFound();
  const gone = await deleteReviewComment(params.data.id, user.actor.id, params.data.commentId);
  return gone ? NextResponse.json({ ok: true }) : reviewNotFound();
}

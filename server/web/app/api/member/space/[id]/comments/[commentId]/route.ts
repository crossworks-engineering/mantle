import { NextResponse } from '@/server/http-compat';
import { deleteMineComment } from '@mantle/content';
import { getMemberOr401 } from '@/lib/auth';
import { CommentParams, inMySpace, notFound } from '@/lib/member-space';

/** DELETE /api/member/space/:id/comments/:commentId : remove one of the
 *  member's own comments on one of their own items. */
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string; commentId: string }> },
) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const params = CommentParams.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const ok = await inMySpace(member, () =>
    deleteMineComment(member.spaceId, params.data.id, params.data.commentId),
  );
  return ok ? NextResponse.json({ ok: true }) : notFound();
}

import { NextResponse } from '@/server/http-compat';
import { withTeamDrafts } from '@mantle/db';
import { deleteTeamDraftComment } from '@mantle/content';
import { getMemberOr401 } from '@/lib/auth';
import { CommentParams, notFound } from '@/lib/member-space';

/** DELETE /api/member/team-drafts/:id/comments/:commentId : remove one of the
 *  member's own comments on a teammate's team-shared item. */
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string; commentId: string }> },
) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const params = CommentParams.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const ok = await withTeamDrafts(() =>
    deleteTeamDraftComment(params.data.id, member.loginId, params.data.commentId),
  );
  return ok ? NextResponse.json({ ok: true }) : notFound();
}

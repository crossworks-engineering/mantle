import { NextResponse } from '@/server/http-compat';
import { deleteClientThreadComment } from '@mantle/content';
import { getMemberOr401 } from '@/lib/auth';
import { memberWriteGate, notFound } from '@/lib/member-space';
import { ThreadCommentParams } from '@/lib/client-thread';

/** DELETE /api/member/library/:id/comments/:commentId : remove one of the
 *  member's own comments on a client thread (its own login, scope client).
 *  Anything else is a plain 404. */
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string; commentId: string }> },
) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const limited = memberWriteGate(member);
  if (limited) return limited;
  const params = ThreadCommentParams.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const ok = await deleteClientThreadComment(
    member.anchorId,
    params.data.id,
    { kind: 'member', loginId: member.loginId },
    params.data.commentId,
  );
  return ok ? NextResponse.json({ ok: true }) : notFound();
}

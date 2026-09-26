import { NextResponse } from '@/server/http-compat';
import { addMineComment, listMineComments, toNodeCommentDto } from '@mantle/content';
import { getMemberOr401 } from '@/lib/auth';
import {
  CommentBody,
  SpaceIdParams,
  inMySpace,
  memberAuthor,
  notFound,
  spaceStateResponse,
} from '@/lib/member-space';
import { firstIssue } from '@/lib/zod-issue';

/**
 * GET /api/member/space/:id/comments : the thread on one of the member's own
 * items, oldest first. POST { body } : add to it, open while the item is
 * shared with the team or submitted for review (409 `not-shared` otherwise).
 * Comments are kept with the brain's id, so the thread survives Accept.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const params = SpaceIdParams.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const rows = await inMySpace(member, () => listMineComments(member.spaceId, params.data.id));
  if (!rows) return notFound();
  const viewer = { loginId: member.loginId };
  return NextResponse.json({ comments: rows.map((r) => toNodeCommentDto(r, viewer)) });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const params = SpaceIdParams.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const body = CommentBody.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: firstIssue(body.error) }, { status: 400 });
  try {
    const row = await inMySpace(member, () =>
      addMineComment(
        member.spaceId,
        member.anchorId,
        params.data.id,
        memberAuthor(member),
        body.data.body,
      ),
    );
    return NextResponse.json(
      { comment: toNodeCommentDto(row, { loginId: member.loginId }) },
      { status: 201 },
    );
  } catch (err) {
    return spaceStateResponse(err);
  }
}

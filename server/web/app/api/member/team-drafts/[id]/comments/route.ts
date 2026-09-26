import { NextResponse } from '@/server/http-compat';
import { withTeamDrafts } from '@mantle/db';
import { addTeamDraftComment, listTeamDraftComments, toNodeCommentDto } from '@mantle/content';
import { getMemberOr401 } from '@/lib/auth';
import {
  CommentBody,
  SpaceIdParams,
  memberAuthor,
  notFound,
  spaceStateResponse,
} from '@/lib/member-space';
import { firstIssue } from '@/lib/zod-issue';

/**
 * GET /api/member/team-drafts/:id/comments : the thread on a teammate's
 * team-shared item. POST { body } : add to it. Read on the team role with
 * the human flag on; a private item is a plain 404.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const params = SpaceIdParams.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const rows = await withTeamDrafts(() => listTeamDraftComments(params.data.id));
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
    const row = await withTeamDrafts(() =>
      addTeamDraftComment(member.anchorId, params.data.id, memberAuthor(member), body.data.body),
    );
    return NextResponse.json(
      { comment: toNodeCommentDto(row, { loginId: member.loginId }) },
      { status: 201 },
    );
  } catch (err) {
    return spaceStateResponse(err);
  }
}

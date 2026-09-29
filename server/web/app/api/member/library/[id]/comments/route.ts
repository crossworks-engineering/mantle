import { NextResponse } from '@/server/http-compat';
import { withHumanViewer } from '@mantle/db';
import { addClientThreadComment, listClientThread, toNodeCommentDto } from '@mantle/content';
import { getMemberOr401 } from '@/lib/auth';
import { readJsonNoNul } from '@/lib/strip-nul';
import { memberAuthor, memberWriteGate, notFound, spaceStateResponse } from '@/lib/member-space';
import { commentPageQuery } from '@/lib/comment-page';
import { ThreadCommentBody, ThreadParams } from '@/lib/client-thread';
import { firstIssue } from '@/lib/zod-issue';

/**
 * GET /api/member/library/:id/comments[?before=ISO] : the client thread on a
 * Library item at CLIENT level (client logins C5, decision 8), which the
 * team, the admins and every client login read and write: its newest 100
 * comments, oldest first, and `hasMore`. POST { body } -> 201 { comment }
 * (409 `thread-full` at 1000 comments).
 * Only on an item at client level: a team item (or anything else) is a plain
 * 404. Read on the team role with the human flag on; written on the admin
 * pool with the item's level checked in the same statement. A member's
 * comment shows their display name (else the email's local part) to the
 * clients too. Writes are rate limited per login.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const params = ThreadParams.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const page = commentPageQuery(req);
  if (page instanceof Response) return page;
  const thread = await withHumanViewer('team', () =>
    listClientThread(member.anchorId, params.data.id, page),
  );
  if (!thread) return notFound();
  const viewer = { loginId: member.loginId };
  return NextResponse.json({
    comments: thread.rows.map((r) => toNodeCommentDto(r, viewer)),
    hasMore: thread.hasMore,
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const limited = memberWriteGate(member);
  if (limited) return limited;
  const params = ThreadParams.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const body = ThreadCommentBody.safeParse(await readJsonNoNul(req));
  if (!body.success) return NextResponse.json({ error: firstIssue(body.error) }, { status: 400 });
  let row;
  try {
    row = await addClientThreadComment(
      member.anchorId,
      params.data.id,
      { kind: 'member', ...memberAuthor(member) },
      body.data.body,
    );
  } catch (err) {
    return spaceStateResponse(err);
  }
  if (!row) return notFound();
  return NextResponse.json(
    { comment: toNodeCommentDto(row, { loginId: member.loginId }) },
    { status: 201 },
  );
}

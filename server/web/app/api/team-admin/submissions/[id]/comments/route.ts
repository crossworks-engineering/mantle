/**
 * GET  /api/team-admin/submissions/:id/comments[?before=ISO] : the thread an
 *   admin reads: its newest 100 comments, oldest first, and `hasMore`.
 * POST /api/team-admin/submissions/:id/comments { body } : the reviewer's
 *   side of the review talk, while the item is submitted. Review talk only:
 *   teammates never read it; the author does.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { addReviewComment, listReviewComments } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';
import { commentPageQuery } from '@/lib/comment-page';
import {
  SubmissionParams,
  commentsDto,
  reviewErrorResponse,
  reviewNotFound,
  reviewer,
} from '@/lib/member-review';

const Body = z.object({ body: z.string().max(10_000) });

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const params = SubmissionParams.safeParse(await ctx.params);
  if (!params.success) return reviewNotFound();
  const page = commentPageQuery(req);
  if (page instanceof Response) return page;
  const thread = await listReviewComments(params.data.id, page);
  if (!thread) return reviewNotFound();
  return NextResponse.json({ comments: commentsDto(thread.rows, user), hasMore: thread.hasMore });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const params = SubmissionParams.safeParse(await ctx.params);
  if (!params.success) return reviewNotFound();
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'Invalid comment.' }, { status: 400 });
  try {
    const c = await addReviewComment(user.id, params.data.id, reviewer(user), body.data.body);
    return NextResponse.json({ comment: commentsDto([c], user)[0] }, { status: 201 });
  } catch (err) {
    return reviewErrorResponse(err);
  }
}
